// Browser check of the storage ladder's Folder rung (Batch L): boots the real
// page in headless Chrome and proves that
//   - attaching a folder copies the whole disk into it,
//   - a later backup copies only what changed,
//   - restore replaces this browser's disk with the folder's copy, through a
//     reload, and the guest's files come back with the same disk identity.
// Headless Chrome cannot show the folder picker, so the folder is an OPFS
// directory: the same FileSystemDirectoryHandle API a picked folder has.
// Run: node qemu-build/test-backup-browser.mjs   (KARKHANA_ROOT as elsewhere)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, serve, shell, sleep, until } from './browser-harness.mjs';

const ROOT = path.resolve(process.env.KARKHANA_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const PAGE = existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : 'karkhana.html';
const BOOT_MS = 240_000;
const FOLDER = `navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('backup-under-test', { create: true }))`;

test('the disk backs up to a folder and restores from it', { timeout: 3 * BOOT_MS + 600_000 }, async (t) => {
  const server = await serve(ROOT);
  const browser = await launch();
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage();
  const sh = shell(page);
  const boot = async () => {
    await until('the page script', () => page.evaluate('!!window.karkhana?.shell'), 30_000);
    await sh.capture();
    await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
    await until('the disk API', () => page.evaluate('!!window.karkhana.disk?.backup'), 30_000);
  };
  const status = () => page.evaluate('window.karkhana.disk.backup.status');
  const committed = (seq) => until(`backup ${seq}`, async () => {
    const s = await status();
    assert.notEqual(s.state, 'error', s.lastError);
    return s.seq >= seq ? s : null;
  }, 300_000);
  await page.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${PAGE}` });
  await boot();
  assert.equal(await page.evaluate('window.karkhana.disk.mode'), 'persistent');

  let full;
  await t.test('attaching a folder copies the whole disk', async () => {
    // 40 MB of data, so the disk spans enough chunks for an incremental backup to skip most.
    await sh.run('head -c 40000000 /dev/urandom > /root/ballast && echo first > /root/backup-marker && sync', 300_000);
    await page.evaluate(`${FOLDER}.then((d) => window.karkhana.disk.backup.attach(d)).then(() => true)`);
    full = await committed(1);
    assert.equal(full.state, 'on');
    assert.ok(full.chunksWritten >= 2, JSON.stringify(full));
    t.diagnostic(`full backup: ${full.chunksWritten} chunks, ${full.bytesWritten} bytes`);
  });

  await t.test('a later backup copies only what changed', async () => {
    await sh.run('echo second >> /root/backup-marker && sync', 60_000);
    await sleep(1500);
    assert.notEqual(await page.evaluate('window.karkhana.disk.backup.now()'), -1);
    const next = await committed(2);
    assert.ok(next.chunksWritten - full.chunksWritten < full.chunksWritten / 2, `incremental: ${full.chunksWritten} then ${next.chunksWritten}`);
    t.diagnostic(`incremental backup: ${next.chunksWritten - full.chunksWritten} new chunks`);
  });

  await t.test('restore brings the files back in place of the disk', async () => {
    const before = await page.evaluate(`${FOLDER}.then((d) => window.karkhana.disk.backup.describe(d))`);
    await sh.run('echo after-backup > /root/not-in-backup && sync', 60_000);
    await page.evaluate(`${FOLDER}.then((d) => { window.karkhana.disk.backup.restore(d); return true; })`);
    await sleep(2000);
    await boot();
    const disk = await page.evaluate('({ mode: window.karkhana.disk.mode, created: window.karkhana.disk.created })');
    assert.equal(disk.mode, 'persistent');
    assert.deepEqual(await sh.run('cat /root/backup-marker', 60_000), ['first', 'second']);
    assert.deepEqual(await sh.run('test -e /root/not-in-backup && echo present || echo absent', 60_000), ['absent']);
    const after = await page.evaluate(`${FOLDER}.then((d) => window.karkhana.disk.backup.describe(d))`);
    assert.equal(after.diskId, before.diskId, 'the restored disk keeps its identity');
    assert.equal(await page.evaluate("localStorage.getItem('karkhana-restore-pending')"), null);
  });
});
