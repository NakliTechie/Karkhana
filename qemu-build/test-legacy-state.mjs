// Browser check of the ksave retirement (Batch 2, N2): a browser that still
// holds an archive from `ksave` (karkhana-persist/state.tar in OPFS, from before
// the persistent disk) gets its files once, on the boot that creates its disk.
//   - the guest's files from the archive are on the new disk after the first prompt,
//   - the archive is set aside (state.tar.migrated), so a reload does not apply it again,
//   - ksave and krestore are gone from the guest.
// Run: node qemu-build/test-legacy-state.mjs   (KARKHANA_ROOT and KARKHANA_URL as elsewhere)
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

// A ustar archive with one file, as `tar -cf - -C / root` would hold it.
function tarOf(name, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512);
  const field = (value, at, len) => header.write(value, at, len, 'ascii');
  field(name, 0, 100);
  field('0000644\0', 100, 8);
  field('0000000\0', 108, 8);
  field('0000000\0', 116, 8);
  field(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  field(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  field('        ', 148, 8);
  field('0', 156, 1);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  const sum = header.reduce((n, b) => n + b, 0);
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad, Buffer.alloc(1024)]);
}

const opfsFiles = (page) => page.evaluate(`navigator.storage.getDirectory()
  .then((r) => r.getDirectoryHandle('karkhana-persist', { create: true }))
  .then(async (d) => { const names = []; for await (const n of d.keys()) names.push(n); return names.sort(); })`);

test('an old ksave archive moves onto a new disk once', { timeout: 4 * BOOT_MS }, async (t) => {
  const server = LIVE_URL ? null : await serve(ROOT);
  const browser = await launch();
  t.after(async () => { await browser.close(); server?.close(); });
  const origin = LIVE_URL ? new URL(LIVE_URL).origin : `http://127.0.0.1:${server.address().port}`;
  const url = LIVE_URL || `${origin}/${PAGE}`;
  const page = await browser.newPage();
  const sh = shell(page);
  const boot = async () => {
    await until('the page script', () => page.evaluate('!!window.karkhana?.shell'), 60_000);
    await sh.capture();
    await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
  };

  await t.test('a first visit with an old archive restores it into the new disk', async () => {
    // Seed OPFS from a same-origin page before Karkhana first runs.
    await page.send('Page.navigate', { url: `${origin}/404.html` });
    await sleep(1500);
    const tar = tarOf('root/from-ksave', 'legacy\n').toString('base64');
    await page.evaluate(`(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('karkhana-persist', { create: true });
      const w = await (await dir.getFileHandle('state.tar', { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(${JSON.stringify(tar)}), (c) => c.charCodeAt(0)));
      await w.close();
      return true;
    })()`);
    await page.send('Page.navigate', { url });
    await boot();
    assert.deepEqual(await page.evaluate('({ mode: window.karkhana.disk.mode, created: window.karkhana.disk.created })'), { mode: 'persistent', created: true });
    assert.deepEqual(await sh.run('cat /root/from-ksave', COMMAND_MS), ['legacy']);
    assert.deepEqual(await opfsFiles(page), ['state.tar.migrated']);
    assert.deepEqual(await sh.run('command -v ksave krestore || echo gone', COMMAND_MS), ['gone']);
  });

  await t.test('a reload does not apply it again', async () => {
    await sh.run('echo changed > /root/from-ksave && sync', COMMAND_MS);
    await page.send('Page.reload');
    await sleep(1000);
    await boot();
    assert.equal(await page.evaluate('window.karkhana.disk.created'), false);
    assert.deepEqual(await sh.run('cat /root/from-ksave; test -e /persist/state.tar && echo staged || echo none', COMMAND_MS), ['changed', 'none']);
  });
});
