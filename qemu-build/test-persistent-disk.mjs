// Browser check of the persistent guest disk (Batch K): boots the real page and
// engine in headless Chrome and proves that
//   - a first visit creates the OPFS disk and the guest mounts it,
//   - files and the execute bit survive a reload, with no ksave,
//   - work survives a tab closed without sync, after ext4's commit interval,
//   - /tmp stays scratch,
//   - a second tab falls back to scratch (the in-memory disk) instead of sharing it, and
//   - a first visit costs OPFS only the template plus what the session wrote.
// Run: node qemu-build/test-persistent-disk.mjs
// KARKHANA_ROOT serves another tree (default: the repository root); a staged
// tree from chunk.sh serves karkhana.html, a published one index.html.
// KARKHANA_URL tests a deployed site instead, e.g. https://karkhana.naklitechie.com/
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, serve, shell, sleep, until } from './browser-harness.mjs';

const ROOT = path.resolve(process.env.KARKHANA_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const PAGE = existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : 'karkhana.html';
const LIVE_URL = process.env.KARKHANA_URL;
// A live first visit downloads the whole engine before it boots.
const BOOT_MS = LIVE_URL ? 900_000 : 240_000;
// ext4 commits every 5 s; the disk worker flushes OPFS 1 s after the last write.
const COMMIT_WAIT_MS = 9_000;
const FIRST_VISIT_BUDGET = 64 * 1024 * 1024;

// Opens the page and waits for the shell, capturing output from the start of boot.
async function boot(browser, url) {
  const page = await browser.newPage();
  await page.viewport(1440, 810);
  await page.send('Page.navigate', { url });
  const sh = shell(page);
  await until('the page script', () => page.evaluate('!!window.karkhana?.shell'), 30_000);
  await sh.capture();
  await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
  return { page, ...sh };
}

const rootSizeKB = async (run) => Number((await run("df -P / | awk 'NR==2 {print $2}'", COMMAND_MS))[0]);
// First commands after a restore page the guest in from disk; allow them time.
const COMMAND_MS = 60_000;

test('the guest disk persists in OPFS', { timeout: 6 * BOOT_MS }, async (t) => {
  const server = LIVE_URL ? null : await serve(ROOT);
  const browser = await launch();
  t.after(async () => { await browser.close(); server?.close(); });
  const url = LIVE_URL || `http://127.0.0.1:${server.address().port}/${PAGE}`;
  const marker = `kdisk-${process.pid}-${Date.now()}`;
  let first;

  await t.test('a first visit creates the disk and the guest mounts it', async () => {
    first = await boot(browser, url);
    const disk = await first.page.evaluate('window.karkhana.disk');
    assert.equal(disk.mode, 'persistent', `scratch because: ${disk.reason}`);
    assert.equal(disk.created, true);
    assert.match(await first.output(), /karkhana disk: persistent\r/);
    assert.equal(await first.page.evaluate('document.getElementById("diskstate").textContent'), 'disk: persistent');
    const kb = await rootSizeKB(first.run);
    assert.ok(kb > 15_000_000, `/ must report the 16 GiB disk, got ${kb} KiB`);
    assert.deepEqual(await first.run('stat -f -c %T /tmp', COMMAND_MS), ['tmpfs']);
  });

  await t.test('a first visit costs OPFS little', async () => {
    // usage also counts Cache Storage, where the service worker keeps the engine.
    const usage = await first.page.evaluate('navigator.storage.estimate().then((e) => e.usageDetails.fileSystem)');
    assert.ok(usage < FIRST_VISIT_BUDGET, `first visit used ${usage} bytes of OPFS`);
  });

  await t.test('files and the execute bit survive a reload, with no ksave', async () => {
    await first.run(`echo ${marker} > /root/kdisk-marker && printf '#!/bin/sh\\necho tool-ok\\n' > /usr/local/bin/kdisk-tool && chmod +x /usr/local/bin/kdisk-tool && sync`, COMMAND_MS);
    await first.page.send('Page.reload');
    await sleep(1000);
    await until('the page script', () => first.page.evaluate('!!window.karkhana?.shell'), 30_000);
    await first.capture();
    await until('the guest shell after reload', () => first.page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
    const disk = await first.page.evaluate('window.karkhana.disk');
    assert.equal(disk.mode, 'persistent', `scratch because: ${disk.reason}`);
    assert.equal(disk.created, false);
    assert.deepEqual(await first.run('cat /root/kdisk-marker', COMMAND_MS), [marker]);
    assert.deepEqual(await first.run('kdisk-tool', COMMAND_MS), ['tool-ok']);
  });

  await t.test('a second tab falls back to scratch', async () => {
    const second = await boot(browser, url);
    const disk = await second.page.evaluate('window.karkhana.disk');
    assert.equal(disk.mode, 'scratch');
    assert.match(disk.reason, /another Karkhana tab/);
    assert.match(await second.output(), /karkhana disk: persistent\r/, 'scratch runs on the in-memory disk');
    assert.deepEqual(await second.run('test -e /root/kdisk-marker && echo present || echo absent', COMMAND_MS), ['absent']);
    await second.page.close();
  });

  await t.test('work survives a tab closed without sync', async () => {
    await first.run(`echo ${marker}-unsynced > /root/kdisk-unsynced`, COMMAND_MS);
    await sleep(COMMIT_WAIT_MS);
    await first.page.close();
    const again = await boot(browser, url);
    const disk = await again.page.evaluate('window.karkhana.disk');
    assert.equal(disk.mode, 'persistent', `scratch because: ${disk.reason}`);
    assert.deepEqual(await again.run('cat /root/kdisk-unsynced', COMMAND_MS), [`${marker}-unsynced`]);
    assert.deepEqual(await again.run('cat /root/kdisk-marker', COMMAND_MS), [marker]);
  });
});
