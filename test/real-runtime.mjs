import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// These fixtures exercise the installed DSH's actual React, Cordis and slot
// renderer. They never open a real profile, model route, credential or session.
const testDir = path.dirname(fileURLToPath(import.meta.url));
export const pluginDir = path.dirname(testDir);
export const artifactsDir = path.resolve(process.env.DSH_TEST_ARTIFACTS || path.join(pluginDir, 'test/artifacts'));
const defaultAsar = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/app.asar') : '';

export function openAsar(filename = process.env.DSH_TEST_ASAR || defaultAsar) {
  if (!filename || !fs.existsSync(filename)) throw new Error('Set DSH_TEST_ASAR to the installed DSH 0.2.1-rc.2 app.asar file.');
  const fd = fs.openSync(filename, 'r');
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, prefix.length, 0);
  const bytes = Buffer.alloc(prefix.readUInt32LE(12));
  fs.readSync(fd, bytes, 0, bytes.length, 16);
  const header = JSON.parse(bytes.toString('utf8'));
  const offset = 8 + prefix.readUInt32LE(4);
  const members = [];
  const visit = (node, parent = '') => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const member = parent ? parent + '/' + name : name;
      if (entry.files) visit(entry, member);
      else members.push(member);
    }
  };
  visit(header);
  return {
    members,
    read(member) {
      let node = header;
      for (const part of member.split('/')) node = node.files?.[part];
      if (!node || node.unpacked) throw new Error('Missing packed fixture: ' + member);
      const bytes = Buffer.alloc(node.size);
      fs.readSync(fd, bytes, 0, bytes.length, offset + Number(node.offset));
      return bytes;
    },
    close() { fs.closeSync(fd); },
  };
}

export async function createHarness(fixture) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const asar = openAsar();
  const prefix = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/';
  const frontend = asar.members.find(name => name.startsWith(prefix) && /\/index-[^/]+\.js$/.test(name));
  if (!frontend) throw new Error('DSH frontend fixture missing');
  const original = asar.read(frontend).toString('utf8');
  const seedFunction = original.match(/function ([\w$]+)\(\)\{return\{react:/)?.[1];
  const bootStart = original.search(/const [\w$]+=globalThis\.dshDesktopBoot,/);
  if (!seedFunction || bootStart < 0) throw new Error('DSH frontend fixture layout changed');
  // Keep the genuine frontend seeds, omit only starting the DSH application.
  const seeds = original.slice(0, bootStart) + '\nglobalThis.__hubSeeds=' + seedFunction + '();';
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Media Reader Test</title><style>body{margin:0;font:14px system-ui;background:#f6f6f7;color:#242427}button,input{font:inherit}#root{padding:24px}#fixture-settings{display:grid;grid-template-columns:150px minmax(0,1fr);gap:24px;min-height:440px}#fixture-nav{display:flex;flex-direction:column;gap:6px}#fixture-nav button{padding:9px;border:0;border-radius:6px;background:#fff;text-align:left}#fixture-content{max-width:920px}#fixture-composer{border:1px solid #bbb;border-radius:12px;padding:12px;display:flex;gap:12px;margin-bottom:24px;max-width:650px}.test-native-panel{padding:18px;background:white;border:1px solid #ddd;border-radius:12px}.test-native-panel label{display:block;margin:12px 0}.test-status{font-size:12px;color:#65656d}</style></head><body><div id="root"></div><script>window.__hubFactories=new Map();window.__ModuleLoader__={load(r){window.__hubFactories.set(r.id,r.factory)}};</script><script type="module" src="/fixture.js"></script></body></html>';
  const server = http.createServer((req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      let body;
      let type = 'text/javascript; charset=utf-8';
      if (pathname === '/') { body = html; type = 'text/html; charset=utf-8'; }
      else if (pathname === '/fixture.js') body = fixture;
      else if (pathname === '/client.js') body = fs.readFileSync(path.join(pluginDir, 'lib/client.js'));
      else if (pathname === '/hub.js') body = fs.readFileSync(path.join(process.env.DSH_TEST_HUB_ROOT || path.resolve(pluginDir, '../plugin-hub'), 'lib/client.js'));
      else if (pathname === '/native-conversation.js') body = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js');
      else if (pathname === '/renderer.js') body = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js');
      else if (pathname === '/assets/seeds.js') body = seeds;
      else if (/^\/assets\/[\w.-]+\.js$/.test(pathname)) body = asar.read(prefix + pathname.slice('/assets/'.length));
      else { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (error) { res.writeHead(500); res.end(String(error.stack)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(artifactsDir, 'chrome-'));
  const chrome = spawn(process.env.DSH_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let chromeDiagnostics = '';
  chrome.stderr.on('data', data => { chromeDiagnostics = (chromeDiagnostics + data.toString()).slice(-2400); });
  chrome.on('error', error => { chromeDiagnostics += String(error); });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let ws;
  let seq = 0;
  const pending = new Map();
  const errors = [];
  const close = async () => {
    ws?.close();
    chrome.kill();
    await new Promise(resolve => server.close(resolve));
    asar.close();
    await sleep(100);
    const absolute = path.resolve(profile);
    if (absolute.startsWith(path.resolve(artifactsDir) + path.sep)) {
      try { fs.rmSync(absolute, { recursive: true, force: true }); } catch {}
    }
  };
  try {
    const marker = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 80 && !fs.existsSync(marker); attempt++) await sleep(100);
    if (!fs.existsSync(marker)) throw new Error('Headless Chrome did not start: ' + chromeDiagnostics);
    const port = fs.readFileSync(marker, 'utf8').split('\n')[0];
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(message.params.args.map(argument => argument.value ?? argument.description).join(' '));
      }
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
        pending.set(id, result => {
          clearTimeout(timer);
          if (result.error) reject(new Error(result.error.message));
          else resolve(result.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('globalThis.__hubFixtureReady === true')) break;
      const failure = await evaluate('globalThis.__hubFixtureError || null');
      if (failure) throw new Error(failure);
      if (attempt === 99) throw new Error('Hub fixture did not initialize: ' + errors.join('\n'));
      await sleep(75);
    }
    return {
      send, evaluate, errors, sleep, close,
      async screenshot(name) {
        const filename = path.join(artifactsDir, name + '.png');
        const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(filename, Buffer.from(result.data, 'base64'));
        return filename;
      },
    };
  } catch (error) { await close(); throw error; }
}
