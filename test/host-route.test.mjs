import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { apply } from '../lib/index.js';
import { runtimeFile } from './runtime-config.mjs';

const fixturesRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));
const connectionSource = await fs.readFile(runtimeFile('@deepseek-ai/dsh-client-connection/lib/index.js'), 'utf8');
const bridgeStart = connectionSource.indexOf('//#region lib/types/http-bridge.js');
const bridgeEnd = connectionSource.indexOf('//#endregion', bridgeStart);
assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart);
const nativeBridge = new Function('Readable', connectionSource.slice(bridgeStart, bridgeEnd) + '\nreturn bridge;')(Readable);
const sharedStart = connectionSource.indexOf('\tcreateSharedFetchHandler(channel) {');
const sharedEnd = connectionSource.indexOf('\n\tregisterFetchRoute(', sharedStart);
assert.ok(sharedStart >= 0 && sharedEnd > sharedStart);
const createNativeSharedHandler = new Function('endpointFromPath', 'return function ' + connectionSource.slice(sharedStart, sharedEnd).trim() + ';')(() => undefined);

async function exerciseNativeBridge(route) {
  const registry = { fetchRoutes: new Map([[route.path, { ...route, methods: new Set(route.methods) }]]), interceptors: new Map() };
  const handler = createNativeSharedHandler.call(registry, '/api');
  assert.equal(handler.requestBodyMode({ method: 'GET', url: new URL('http://dsh.internal' + route.path) }), 'buffered');
  assert.equal(handler.requestBodyMode({ method: 'POST', url: new URL('http://dsh.internal' + route.path) }), 'buffered');
  const peer = { principal: { kind: 'owner' } };
  // Pass actual Node streams through DSH's genuine shared route selector and
  // HTTP bridge, without opening a socket or contacting any live profile.
  const invoke = async (method, body, carrier = handler) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(req, { method, url: route.path, headers: body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
    const res = new EventEmitter(), chunks = [];
    Object.assign(res, { writableEnded: false, destroyed: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
    });
    await nativeBridge(req, res, carrier, peer);
    assert.equal(res.writableEnded, true);
    return { status: res.status, value: JSON.parse(Buffer.concat(chunks).toString()) };
  };
  const get = await invoke('GET');
  assert.equal(get.status, 200);
  assert.deepEqual(get.value.settings, { frameCount: 12, maxSide: 960 });
  const post = await invoke('POST', JSON.stringify({ frameCount: 7, maxSide: 640 }));
  assert.equal(post.status, 200);
  assert.deepEqual(post.value.settings, { frameCount: 7, maxSide: 640 });
  const reread = await invoke('GET');
  assert.equal(reread.status, 200);
  assert.deepEqual(reread.value.settings, { frameCount: 7, maxSide: 640 });
  const brokenRegistry = { fetchRoutes: new Map([[route.path, { ...route, requestBody: undefined, methods: new Set(route.methods) }]]), interceptors: new Map() };
  const brokenHandler = createNativeSharedHandler.call(brokenRegistry, '/api');
  await assert.rejects(invoke('GET', undefined, brokenHandler), /GET\/HEAD method cannot have body/, 'regression reproduces the real bridge failure when requestBody is omitted');
}

test('host HTTP route: authenticated registry, settings persistence, input errors, session ownership and unload', async () => {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixturesRoot, 'host-route-'));
  const previousHome = process.env.DSH_HOME;
  const effects = [], routes = new Map(), tools = new Map();
  const originalFile = { attachmentId: 'sha256:' + 'f'.repeat(64), name: 'original.gif', bytes: 25 };
  const agent = { options: {}, session: {
    requestHeader: () => ({ config: { provider: 'fixture-provider', model: 'fixture-model' } }),
    snapshotEvents: () => [{ type: 'user/message', data: { content: [
      { type: 'file', attachment: originalFile },
      { type: 'file', attachment: { ...originalFile, attachmentId: 'sha256:' + 'a'.repeat(64), name: 'notes.txt' } },
      { type: 'image', attachment: { ...originalFile, attachmentId: 'sha256:' + 'b'.repeat(64), name: 'normalized.gif' } },
    ] } }],
  } };
  let modalities = ['text', 'image'];
  const ctx = {
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') effects.push(dispose); },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    agents: { get: id => id === 'fixture-session' ? agent : undefined },
    llm: { async resolveModelInfo(provider, model, signal) { signal?.throwIfAborted(); assert.equal(provider, 'fixture-provider'); assert.equal(model, 'fixture-model'); return { inputModalities: modalities }; } },
  };
  try {
    process.env.DSH_HOME = directory;
    apply(ctx);
    // The plugin captured this isolated directory during apply. Restore the
    // process environment immediately so later independent tests cannot use it.
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    assert.deepEqual([...routes.keys()], ['/api/plugins/media-reader']);
    assert.deepEqual([...tools.keys()], ['read_media']);
    const route = routes.get('/api/plugins/media-reader');
    assert.deepEqual(route.methods, ['GET', 'POST']);
    assert.equal(route.requestBody, 'buffered', 'native HTTP bridge must not create a streaming body for GET');
    const request = async (suffix = '', options = {}) => {
      const response = await route.fetch(new Request('http://127.0.0.1/api/plugins/media-reader' + suffix, options));
      return { status: response.status, headers: response.headers, value: await response.json() };
    };
    let result = await request();
    assert.equal(result.status, 200);
    assert.deepEqual(result.value.settings, { frameCount: 12, maxSide: 960 });
    assert.equal(result.value.version, '1.0.0');
    assert.equal(typeof result.value.decoderReady, 'boolean');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    await exerciseNativeBridge(route);
    const post = body => request('', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body });
    result = await post(JSON.stringify({ frameCount: 6, maxSide: 1280 }));
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'dsh-media-reader.json'), 'utf8')), { frameCount: 6, maxSide: 1280 });
    assert.deepEqual((await request()).value.settings, { frameCount: 6, maxSide: 1280 });
    assert.equal((await request('', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post(JSON.stringify({ frameCount: 25, maxSide: 1280 }))).status, 400);
    assert.equal((await post(JSON.stringify({ frameCount: '6', maxSide: 1280 }))).status, 400);
    assert.equal((await post(JSON.stringify({ frameCount: 6, maxSide: 9000 }))).status, 400);
    assert.equal((await post(' '.repeat(4097))).status, 413);
    assert.deepEqual((await request()).value.settings, { frameCount: 6, maxSide: 1280 }, 'rejected POSTs preserve last valid settings');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['dsh-media-reader.json'], 'atomic writes leave no temporary configuration');
    result = await request('?sessionId=fixture-session');
    assert.equal(result.status, 200);
    assert.deepEqual(result.value.files, [originalFile]);
    assert.deepEqual(result.value.model, { provider: 'fixture-provider', model: 'fixture-model', imageCapable: true });
    modalities = ['text'];
    result = await request('?sessionId=fixture-session');
    assert.equal(result.status, 200);
    assert.equal(result.value.model.imageCapable, false);
    assert.match(result.value.model.message, /看图能力/);
    assert.deepEqual(result.value.files, [originalFile], 'model gating does not fabricate or expose another session source');
    assert.equal((await request('?sessionId=unknown-session')).status, 404);
    const capturedTool = tools.get('read_media');
    for (const dispose of effects.reverse()) await dispose();
    assert.equal(routes.size, 0);
    assert.equal(tools.size, 0);
    await assert.rejects(capturedTool.execute({}, { signal: new AbortController().signal }), /插件已停用/);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    // This is the exact mkdtemp directory created inside the test workspace.
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(fixturesRoot));
    if (!(await fs.lstat(resolved)).isSymbolicLink()) await fs.rm(resolved, { recursive: true, force: true });
  }
});
