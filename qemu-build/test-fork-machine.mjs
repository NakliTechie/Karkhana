// Browser check of fork and keep (Batch V1): boots the real page in headless
// Chrome and proves that
//   - "fork this machine" opens scratch tabs that start from the saved disk,
//   - forks diverge from each other and from the original,
//   - keeping one fork replaces the saved machine and keeps its identity, while
//     the tab that held it runs on, as scratch, with no reboot,
//   - the kept fork survives a reload; a fork that was not kept does not.
// Run: node qemu-build/test-fork-machine.mjs   (KARKHANA_ROOT and KARKHANA_URL as elsewhere)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, serve, shell, sleep, until } from './browser-harness.mjs';

const ROOT = path.resolve(process.env.KARKHANA_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const PAGE = existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : 'karkhana.html';
const LIVE_URL = process.env.KARKHANA_URL;
const BOOT_MS = LIVE_URL ? 900_000 : 240_000;
const COMMAND_MS = 60_000;

async function open(browser, url) {
  const page = await browser.newPage();
  await page.viewport(1440, 810);
  await page.send('Page.navigate', { url });
  const sh = shell(page);
  const boot = async () => {
    await until('the page script', () => page.evaluate('!!window.karkhana?.shell'), 30_000);
    await sh.capture();
    await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
  };
  await boot();
  const reload = async () => { await page.send('Page.reload'); await sleep(1000); await boot(); };
  return { page, reload, ...sh };
}

const disk = (page) => page.evaluate('({ mode: window.karkhana.disk.mode, reason: window.karkhana.disk.reason, id: window.karkhana.disk.id })');
const keep = (page, options = {}) =>
  page.evaluate(`window.karkhana.disk.keep(${JSON.stringify(options)}).then(() => 'kept', (e) => e.code || e.message)`);
const forkCopies = (page) => page.evaluate(`navigator.storage.getDirectory()
  .then((r) => r.getDirectoryHandle('karkhana-forks', { create: true }))
  .then(async (d) => { let n = 0; for await (const _ of d.keys()) n++; return n; })`);

test('a machine forks into tabs, and keeping one replaces the saved machine', { timeout: 8 * BOOT_MS }, async (t) => {
  const server = LIVE_URL ? null : await serve(ROOT);
  const browser = await launch();
  t.after(async () => { await browser.close(); server?.close(); });
  const base = LIVE_URL || `http://127.0.0.1:${server.address().port}/${PAGE}`;
  let a;
  let b;
  let c;
  let savedId;
  let pid;

  await t.test('forks start from the saved machine', async () => {
    a = await open(browser, base);
    ({ id: savedId } = await disk(a.page));
    assert.equal((await disk(a.page)).mode, 'persistent');
    await a.run('echo original > /root/fork-marker && head -c 20000000 /dev/urandom > /root/fork-ballast && md5sum /root/fork-ballast > /root/fork-sum && sync', COMMAND_MS);
    pid = (await a.run('(sleep 100000 >/dev/null 2>&1 & echo $!)', COMMAND_MS))[0];
    const urlB = await a.page.evaluate('window.karkhana.disk.fork()');
    assert.match(urlB, new RegExp(`disk=fork&fork=[0-9a-f-]{36}&of=${savedId}$`));
    b = await open(browser, urlB);
    assert.deepEqual(await disk(b.page), { mode: 'scratch', reason: "a fork of another tab's machine", id: savedId });
    assert.deepEqual(await b.run('cat /root/fork-marker && md5sum -c /root/fork-sum', COMMAND_MS), ['original', '/root/fork-ballast: OK']);
    assert.equal(await forkCopies(b.page), 0, 'the fork deleted its copy once loaded');
    c = await open(browser, await a.page.evaluate('window.karkhana.disk.fork()'));
    assert.equal((await disk(c.page)).mode, 'scratch');
  });

  await t.test('forks diverge from each other and from the original', async () => {
    await b.run('echo b > /root/fork-marker', COMMAND_MS);
    await c.run('echo c > /root/fork-marker', COMMAND_MS);
    assert.deepEqual(await a.run('cat /root/fork-marker', COMMAND_MS), ['original']);
    assert.deepEqual(await b.run('cat /root/fork-marker', COMMAND_MS), ['b']);
    assert.deepEqual(await c.run('cat /root/fork-marker', COMMAND_MS), ['c']);
  });

  await t.test('keeping a fork replaces the saved machine; the original runs on as scratch', async () => {
    assert.equal(await keep(c.page), 'exists');
    assert.equal(await keep(c.page, { replace: true }), 'kept');
    assert.deepEqual(await disk(c.page), { mode: 'persistent', reason: null, id: savedId }, 'the kept fork carries the saved identity');
    assert.equal(await c.page.evaluate('new URL(location.href).searchParams.has("disk")'), false);
    assert.deepEqual(await disk(a.page), { mode: 'scratch', reason: 'another tab kept its machine as the saved one', id: savedId });
    assert.deepEqual(await a.run(`kill -0 ${pid} && echo alive; cat /root/fork-marker`, COMMAND_MS), ['alive', 'original'], 'no reboot');
    assert.deepEqual(await b.run('cat /root/fork-marker', COMMAND_MS), ['b'], 'the other fork is untouched');
  });

  await t.test('the kept fork survives a reload; a fork not kept does not', async () => {
    await c.run('sync', COMMAND_MS);
    await c.reload();
    assert.deepEqual(await disk(c.page), { mode: 'persistent', reason: null, id: savedId });
    assert.deepEqual(await c.run('cat /root/fork-marker && md5sum -c /root/fork-sum', COMMAND_MS), ['c', '/root/fork-ballast: OK']);
    await b.reload();
    const gone = await disk(b.page);
    assert.equal(gone.mode, 'scratch');
    assert.match(gone.reason, /fork's copy is gone/);
    assert.deepEqual(await b.run('test -e /root/fork-marker && echo present || echo absent', COMMAND_MS), ['absent']);
  });
});
