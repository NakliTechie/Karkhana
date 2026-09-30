// Browser check of the guest terminal size: boots the real page and engine in
// headless Chrome at a 1440x810 viewport and drives it over the DevTools
// protocol (Node 22's built-in WebSocket; no packages). Proves that
//   - the guest pty reports the page terminal's size at the first prompt,
//   - a 120-character command echoes on one rendered row,
//   - a viewport resize reaches the guest pty, and
//   - a foreground program receives SIGWINCH with the new size.
// Run: node qemu-build/test-terminal-size.mjs
// KARKHANA_ROOT serves another published tree (default: the repository root).
// CHROME names the browser binary (default: the macOS Google Chrome install).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.KARKHANA_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BOOT_MS = 180_000;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.py': 'text/plain', '.sh': 'text/plain',
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The deployed site's cross-origin isolation headers (see _headers); QEMU needs SharedArrayBuffer.
function serve(root) {
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

async function launch() {
  const profile = await mkdtemp(path.join(tmpdir(), 'karkhana-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,810', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
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
    viewport: (width, height) => page.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false }),
    async close() {
      socket.close();
      chrome.kill();
      await new Promise((resolve) => chrome.once('exit', resolve));
      await rm(profile, { recursive: true, force: true });
    },
  };
  return page;
}

async function until(what, probe, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Rendered terminal rows, trailing blanks trimmed. xterm.js draws rows as DOM text here.
const ROWS = `[...document.querySelectorAll('#terminal .xterm-rows > div')]
  .map((row) => row.textContent.replace(/\\s+$/, ''))`;

test('the guest terminal follows the page terminal size', { timeout: BOOT_MS + 120_000 }, async (t) => {
  const server = await serve(ROOT);
  const page = await launch();
  t.after(async () => { await page.close(); server.close(); });
  await page.viewport(1440, 810);
  await page.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
  await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
  await page.evaluate(`window.__out = ''; window.karkhana.shell.onData((text) => { window.__out += text; }); true`);
  const output = () => page.evaluate('window.__out');
  // Run a command and return its output lines, after the echoed command line.
  let serial = 0;
  const run = async (command, timeout) => {
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
  };
  const guestSize = async () => (await run('stty size'))[0];
  const pageSize = () => page.evaluate('window.karkhana.shell.size');

  await t.test('the first prompt carries the page size', async () => {
    const { cols, rows } = await pageSize();
    assert.ok(cols > 150, `a 1440px viewport must give well over 150 columns, got ${cols}`);
    assert.equal(await guestSize(), `${rows} ${cols}`);
  });

  await t.test('a 120-character command echoes on one row', async () => {
    const text = 'Write a warm two-sentence thank-you note to my team. Save it to a file, then show me the note.';
    const command = `echo "${text.padEnd(113, '.')}"`;
    assert.equal(command.length, 120);
    const { cols } = await pageSize();
    await run(command);
    const rows = await page.evaluate(ROWS);
    const echoed = rows.findIndex((row) => row.startsWith('karkhana:') && row.includes(command));
    assert.notEqual(echoed, -1, `no rendered row holds the whole command:\n${rows.join('\n')}`);
    assert.ok(rows[echoed].length <= cols, 'the echoed row must fit the terminal width');
    assert.equal(rows[echoed + 1], text.padEnd(113, '.'), 'the output must start on the next row');
  });

  await t.test('a viewport resize reaches the guest pty', async () => {
    const before = await pageSize();
    await page.viewport(1000, 700);
    const after = await until('xterm to refit', async () => {
      const size = await pageSize();
      return size.cols !== before.cols ? size : null;
    });
    await until(`guest size ${after.rows} ${after.cols}`, async () => (await guestSize()) === `${after.rows} ${after.cols}`);
  });

  await t.test('a foreground program receives SIGWINCH with the new size', async () => {
    const before = await pageSize();
    await page.evaluate('window.__out = ""; true');
    await page.evaluate(`window.karkhana.shell.exec(${JSON.stringify(
      `bash -c 'trap "echo WINCH-\\$(stty size); exit" WINCH; echo WAITING; while :; do sleep 0.2; done'`)})`);
    await until('the trap to install', async () => /WAITING\r*\n/.test(await output()));
    await page.viewport(1440, 810);
    const after = await until('xterm to refit', async () => {
      const size = await pageSize();
      return size.cols !== before.cols ? size : null;
    });
    await until(`WINCH-${after.rows} ${after.cols}`, async () => (await output()).includes(`WINCH-${after.rows} ${after.cols}`));
  });
});
