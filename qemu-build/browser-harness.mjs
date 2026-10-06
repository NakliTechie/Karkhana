// Shared harness for the browser checks: a static server with the deployed
// site's cross-origin isolation headers, and headless Chrome driven over the
// DevTools protocol (Node 22's built-in WebSocket; no packages).
// CHROME names the browser binary (default: the macOS Google Chrome install).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.py': 'text/plain', '.sh': 'text/plain',
};
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The deployed site's cross-origin isolation headers (see _headers); QEMU needs SharedArrayBuffer.
export function serve(root) {
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://host').pathname).replace(/\/$/, '/index.html');
    const file = path.join(root, path.normalize(rel));
    try {
      if (!file.startsWith(root + path.sep)) throw new Error('outside root');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// One Chrome with a fresh profile. Pages opened with newPage() share it, and
// so share the origin's storage, as tabs do.
export async function launch({ width = 1440, height = 810 } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), 'karkhana-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  // A test that throws before close() would leave Chrome running its guest.
  const orphanGuard = () => chrome.kill();
  process.once('exit', orphanGuard);
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    chrome.on('error', reject);
    chrome.on('exit', (code) => reject(new Error(`Chrome exited (${code}) before DevTools opened:\n${log}`)));
    chrome.stderr.on('data', (data) => {
      log += data;
      const match = /DevTools listening on (ws:\S+)/.exec(log);
      if (match) resolve(match[1]);
    });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return {
    // Browser-level DevTools commands (Browser.setDownloadBehavior, ...).
    send: (method, params) => send(method, params),
    async newPage() {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const page = {
        send: (method, params) => send(method, params, sessionId),
        async evaluate(expression) {
          const { result, exceptionDetails } = await page.send('Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true });
          if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
          return result.value;
        },
        // Reloads, and returns once the new document runs: the old one stays
        // scriptable for a moment after Page.reload, and would answer for it.
        async reload() {
          await page.evaluate('window.__harnessOld = true');
          await page.send('Page.reload');
          await until('the reloaded page', () => page.evaluate('window.__harnessOld !== true').catch(() => false), 60_000);
        },
        viewport: (w, h) => page.send('Emulation.setDeviceMetricsOverride',
          { width: w, height: h, deviceScaleFactor: 1, mobile: false }),
        close: () => send('Target.closeTarget', { targetId }),
      };
      return page;
    },
    async close() {
      process.off('exit', orphanGuard);
      socket.close();
      chrome.kill();
      await new Promise((resolve) => chrome.once('exit', resolve));
      // Chrome's helpers can still be writing the profile as the browser exits.
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

export async function until(what, probe, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Runs commands in the guest shell and returns their output lines, after the
// echoed command line. Call capture() once per page load before run().
export function shell(page) {
  let serial = 0;
  const output = () => page.evaluate('window.__out');
  return {
    output,
    capture: () => page.evaluate(`window.__out = ''; window.karkhana.shell.onData((text) => { window.__out += text; }); true`),
    async run(command, timeout) {
      const marker = `__karkhana_done_${++serial}__`;
      const split = `${marker.slice(0, 4)}""${marker.slice(4)}`;
      await page.evaluate('window.__out = ""; true');
      await page.evaluate(`window.karkhana.shell.exec(${JSON.stringify(`${command}; echo ${split}`)})`);
      // Both the guest pty and the page's line discipline add a CR: lines end \r\r\n.
      const done = new RegExp(`${marker}\\r*\\n`);
      const text = await until(`output of ${command}`, async () => {
        const out = await output();
        return done.test(out) ? out : null;
      }, timeout);
      const body = text.slice(text.lastIndexOf(split) + split.length, text.lastIndexOf(marker));
      return body.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map((line) => line.replace(/\r/g, '')).filter(Boolean);
    },
  };
}
