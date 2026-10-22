import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createTool, copySource, sessionFiles, sessionFileByName, renderResult } from '../lib/index.js';
import { pathToFileURL } from 'node:url';
import { runtimeFile } from './runtime-config.mjs';
const { assertNever, isJsonValue } = await import(pathToFileURL(runtimeFile('@deepseek-ai/dsh-util-values/lib/index.js')).href);

const runtimeSource = await fs.readFile(runtimeFile('@deepseek-ai/dsh-tools/lib/index.js'), 'utf8');
const regionStart = runtimeSource.indexOf('//#region lib/types/json-schema.js');
const regionEnd = runtimeSource.indexOf('//#endregion', regionStart);
assert.ok(regionStart >= 0 && regionEnd > regionStart, 'installed DSH JSON-schema fixture is available');
// Execute DSH's unmodified real schema validator with its actual JSON helpers.
// HarnessError is only the exception base; the schema code and rules are native.
const native = new Function('HarnessError', 'assertNever', 'isJsonValue', runtimeSource.slice(regionStart, regionEnd) + '\nreturn { assertSupportedJsonSchema, validateJsonSchemaValue };')(Error, assertNever, isJsonValue);
const file = (digit, name = 'demo.gif') => ({ attachmentId: 'sha256:' + digit.repeat(64), name, bytes: 100 });
const event = (...refs) => ({ type: 'user/message', data: { content: refs.map(attachment => ({ type: 'file', attachment })) } });
const session = events => ({ snapshotEvents: () => events });

test('real DSH accepts both raw tool schemas; native image output survives output validation', () => {
  const tool = createTool({}, () => ({ frameCount: 12, maxSide: 960 }));
  assert.doesNotThrow(() => native.assertSupportedJsonSchema(tool.parameters));
  assert.doesNotThrow(() => native.assertSupportedJsonSchema(tool.output.schema));
  const image = { attachmentId: 'sha256:' + '1'.repeat(64), mediaType: 'image/png', bytes: 200, width: 96, height: 64, originalDimensions: { width: 192, height: 128 } };
  const value = { source: 'demo.gif', duration_seconds: 2, width: 192, height: 128, start_seconds: 0, end_seconds: 2, capped: false, frames: [{ time_seconds: 1, requested_time_seconds: 1.1, image }] };
  assert.deepEqual(native.validateJsonSchemaValue(tool.output.schema, value), []);
  const rendered = renderResult({}, value);
  assert.deepEqual(rendered.filter(block => block.type === 'image'), [{ type: 'image', attachment: image }]);
  assert.throws(() => native.assertSupportedJsonSchema({ type: 'integer', minimum: 1 }), /not a supported keyword/);
});

test('original file blocks use attachment; names resolve only the latest matching message and refuse ambiguity', () => {
  const a = file('a'), b = file('b'), c = file('c', 'other.mp4');
  const history = session([event(a), event(c), event(b), { type: 'assistant/message', data: { content: [{ type: 'file', attachment: a }] } }, { type: 'user/message', data: { content: [{ type: 'image', attachment: c }, { type: 'file', file: c }] } }]);
  assert.deepEqual(sessionFiles(history), [a, c, b]);
  assert.deepEqual(sessionFileByName(history, 'demo.gif'), b);
  assert.equal(sessionFileByName(history, 'missing.gif'), undefined);
  assert.equal(sessionFileByName(history, 'DEMO.GIF'), undefined, 'exact source name is required');
  assert.throws(() => sessionFileByName(session([event(a), event(a, b)]), 'demo.gif'), /多个同名媒体/);
  assert.deepEqual(sessionFileByName(session([event(a, a)]), 'demo.gif'), a, 'repeated blocks of the same immutable object are not distinct media');
});

test('three source selectors are exclusive and foreign filenames never reach the attachment store', async () => {
  const exec = { signal: new AbortController().signal, agent: { session: session([event(file('a'))]) } };
  const ctx = { attachments: { readFileStream: () => { throw new Error('unexpected store read'); } } };
  await assert.rejects(copySource(ctx, {}, exec, 'unused'), /且仅提供/);
  await assert.rejects(copySource(ctx, { attachment_name: 'demo.gif', file_path: 'demo.gif' }, exec, 'unused'), /且仅提供/);
  await assert.rejects(copySource(ctx, { attachment_id: 'foreign' }, exec, 'unused'), /当前会话/);
  await assert.rejects(copySource(ctx, { attachment_name: 'foreign.gif' }, exec, 'unused'), /当前会话/);
});
