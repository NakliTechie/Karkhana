// Browser check of machine files (Batch V2, teleport): two headless Chromes
// with separate profiles stand in for two devices. It proves that
//   - "save this machine to a file" downloads the running machine, disk and RAM,
//     while the guest keeps running, and a command sent mid-save reaches the guest,
//   - opening that file in the other browser resumes it mid-command: the same
//     shell (a variable set only in RAM), the same background process, still
//     counting, and the disk's files,
//   - the restored machine can be kept, and is then there after a reload.
// Needs an engine built with the 9p migration patch and a read-only rootfs (Dockerfile.builder).
// Run: node qemu-build/test-teleport.mjs   (KARKHANA_ROOT and KARKHANA_URL as elsewhere)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    await until('the page script', () => page.evaluate('!!window.karkhana?.shell'), 60_000);
    await sh.capture();
    await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
  };
  await boot();
  return { page, boot, ...sh };
}

const counter = (run) => run('cat /root/tp-counter', COMMAND_MS).then((lines) => Number(lines[0]));

test('a running machine moves to another browser through a file', { timeout: 6 * BOOT_MS }, async (t) => {
  const server = LIVE_URL ? null : await serve(ROOT);
  const downloads = await mkdtemp(path.join(tmpdir(), 'karkhana-machine-'));
  const one = await launch();
  const two = await launch();
  t.after(async () => { await one.close(); await two.close(); server?.close(); await rm(downloads, { recursive: true, force: true }); });
  const base = LIVE_URL || `http://127.0.0.1:${server.address().port}/${PAGE}`;
  const scratchUrl = `${base}${base.includes('?') ? '&' : '?'}disk=scratch`;
  let a;
  let b;
  let pid;
  let file;

  await t.test('saving downloads the machine while it keeps running', async () => {
    a = await open(one, base);
    await a.run('echo moved > /root/tp-marker && export TP_VAR=only-in-ram && sync', COMMAND_MS);
    // Each count replaces the file whole, so a read never sees it half-written.
    // The loop goes in a script: a command that wraps the terminal confuses the output parser.
    await a.run(`echo 'i=0; while :; do i=$((i+1)); echo $i > /root/c.new; mv /root/c.new /root/tp-counter; sleep 1; done' > /root/tp-count.sh`, COMMAND_MS);
    pid = (await a.run('(sh /root/tp-count.sh >/dev/null 2>&1 & echo $!)', COMMAND_MS)).find((line) => /^\d+$/.test(line));
    await one.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await a.page.evaluate('document.getElementById("cfg-machine-save").click(); true');
    // The save holds QEMU's monitor for seconds; a command sent meanwhile must
    // wait for the guest, not reach the monitor.
    await sleep(300);
    assert.deepEqual(await a.run('echo sent-during-save', COMMAND_MS), ['sent-during-save']);
    const name = await until('the download', async () => {
      const done = (await readdir(downloads)).filter((n) => n.endsWith('.karkhana'));
      return done[0] || null;
    }, 600_000);
    file = path.join(downloads, name);
    const size = (await stat(file)).size;
    t.diagnostic(`machine file: ${Math.round(size / 1048576)} MB`);
    assert.match(await a.page.evaluate('document.getElementById("cfg-disk-status").textContent'), /saved this machine as/);
    const before = await counter(a.run);
    await sleep(2500);
    assert.ok(await counter(a.run) > before, 'the original runs on');
  });

  await t.test('the other browser resumes it mid-command', async () => {
    b = await open(two, scratchUrl);
    const { root } = await b.page.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await b.page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#cfg-machine-file' });
    await b.page.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await sleep(3000);
    await b.boot();
    assert.ok(!(await b.output()).includes('(qemu)'), 'the page talks to QEMU\'s monitor out of sight');
    assert.deepEqual(await b.page.evaluate('({ mode: window.karkhana.disk.mode, reason: window.karkhana.disk.reason, restored: window.karkhana.machine.restored })'),
      { mode: 'scratch', reason: 'a machine restored from a file', restored: true });
    assert.deepEqual(await b.run('echo $TP_VAR; cat /root/tp-marker', COMMAND_MS), ['only-in-ram', 'moved'], 'the same shell, the same disk');
    assert.deepEqual(await b.run(`kill -0 ${pid} && echo alive`, COMMAND_MS), ['alive'], 'the background process came along');
    const first = await counter(b.run);
    await sleep(3000);
    assert.ok(await counter(b.run) > first, 'and it is still counting');
    assert.deepEqual(await b.run('echo new > /persist/tp-after && cat /persist/tp-after', COMMAND_MS), ['new'], '9p works after the restore');
  });

  await t.test('the restored machine can be kept, and survives a reload', async () => {
    assert.equal(await b.page.evaluate("window.karkhana.disk.keep().then(() => 'kept', (e) => e.code || e.message)"), 'kept');
    await b.run('sync', COMMAND_MS);
    await b.page.send('Page.reload');
    await sleep(1000);
    await b.boot();
    assert.equal(await b.page.evaluate('window.karkhana.disk.mode'), 'persistent');
    assert.deepEqual(await b.run('cat /root/tp-marker', COMMAND_MS), ['moved']);
  });
});
