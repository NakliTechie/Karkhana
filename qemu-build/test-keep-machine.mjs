// Browser check of scratch → persistent promotion (Batch L5): boots the real
// page in headless Chrome and proves that
//   - a scratch tab runs on the in-memory disk, not tmpfs,
//   - "keep this machine" moves the running guest onto a new OPFS disk with no
//     reboot, while a guest process keeps writing through the copy,
//   - everything the session wrote, /etc included, survives a reload,
//   - a saved disk is replaced only when asked, and never while another tab uses it.
// Run: node qemu-build/test-keep-machine.mjs   (KARKHANA_ROOT and KARKHANA_URL as elsewhere)
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
const LINES = 150;

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

const keep = (page, options = {}) =>
  page.evaluate(`window.karkhana.disk.keep(${JSON.stringify(options)}).then(() => 'kept', (e) => e.code || e.message)`);
// Which ⚙ → Disk buttons show. Headless Chrome has showDirectoryPicker, so backup buttons show with a disk.
const buttons = (page) => page.evaluate(`(() => { const shown = (id) => !document.getElementById(id).hidden;
  return { keep: shown('cfg-keep'), scratchTab: shown('cfg-scratch-tab'), backup: shown('cfg-backup') }; })()`);
const disk = (page) => page.evaluate('({ mode: window.karkhana.disk.mode, created: window.karkhana.disk.created, reason: window.karkhana.disk.reason })');

test('a scratch tab becomes persistent without a reboot', { timeout: 6 * BOOT_MS }, async (t) => {
  const server = LIVE_URL ? null : await serve(ROOT);
  const browser = await launch();
  t.after(async () => { await browser.close(); server?.close(); });
  const base = LIVE_URL || `http://127.0.0.1:${server.address().port}/${PAGE}`;
  const scratchUrl = `${base}${base.includes('?') ? '&' : '?'}disk=scratch`;
  let a;
  let pid;

  await t.test('a scratch tab runs on the in-memory disk', async () => {
    a = await open(browser, scratchUrl);
    assert.deepEqual(await disk(a.page), { mode: 'scratch', created: false, reason: 'requested with ?disk=scratch' });
    const kb = Number((await a.run("df -P / | awk 'NR==2 {print $2}'", COMMAND_MS))[0]);
    assert.ok(kb > 15_000_000, `/ must report the 16 GiB disk, got ${kb} KiB`);
    assert.deepEqual(await a.run('stat -f -c %T /tmp', COMMAND_MS), ['tmpfs']);
    assert.deepEqual(await buttons(a.page), { keep: true, scratchTab: false, backup: false });
  });

  await t.test('keeping the machine moves the running guest onto OPFS', async () => {
    await a.run('head -c 30000000 /dev/urandom > /root/ballast && echo kept > /root/keep-marker && echo etc > /etc/keep-etc'
      + " && printf '#!/bin/sh\\necho tool-ok\\n' > /usr/local/bin/keep-tool && chmod +x /usr/local/bin/keep-tool", COMMAND_MS);
    // Started from a subshell, so interactive bash prints no job notices.
    pid = (await a.run(`(sh -c 'i=0; while [ $i -lt ${LINES} ]; do echo $i >> /root/during-keep; i=$((i+1)); sleep 0.1; done' >/dev/null 2>&1 & echo $!)`, COMMAND_MS))[0];
    assert.match(pid, /^\d+$/);
    assert.equal(await keep(a.page), 'kept');
    assert.deepEqual(await disk(a.page), { mode: 'persistent', created: true, reason: null });
    assert.equal(await a.page.evaluate('document.getElementById("diskstate").textContent'), 'disk: persistent');
    assert.equal(await a.page.evaluate('new URL(location.href).searchParams.has("disk")'), false, 'a reload must not go back to scratch');
    assert.equal(await a.page.evaluate('!!window.karkhana.disk.backup'), true);
    assert.deepEqual(await buttons(a.page), { keep: false, scratchTab: true, backup: true });
    const lines = Number((await a.run('wc -l < /root/during-keep', COMMAND_MS))[0]);
    assert.ok(lines < LINES, `the writer must still be running after the copy (${lines} lines)`);
    assert.deepEqual(await a.run(`kill -0 ${pid} && echo alive`, COMMAND_MS), ['alive'], 'no reboot');
    await until('the writer', async () => Number((await a.run('wc -l < /root/during-keep', COMMAND_MS))[0]) === LINES, 180_000);
    await a.run('echo after > /root/after-keep && sync', COMMAND_MS);
  });

  await t.test('everything the session wrote survives a reload', async () => {
    await a.reload();
    assert.deepEqual(await disk(a.page), { mode: 'persistent', created: false, reason: null });
    assert.deepEqual(await a.run('cat /root/keep-marker /etc/keep-etc /root/after-keep && keep-tool', COMMAND_MS), ['kept', 'etc', 'after', 'tool-ok']);
    const expected = Array.from({ length: LINES }, (_, i) => String(i)).join(' ');
    assert.deepEqual(await a.run("paste -sd ' ' /root/during-keep", COMMAND_MS), [expected], 'every line written during the copy, in order');
    assert.deepEqual(await a.run('cmp -s /root/ballast /root/ballast && wc -c < /root/ballast', COMMAND_MS), ['30000000']);
  });

  await t.test('a saved disk is replaced only when asked, and not while in use', async () => {
    const b = await open(browser, scratchUrl);
    await b.run('echo second-tab > /root/keep-marker', COMMAND_MS);
    assert.equal(await keep(b.page), 'exists');
    assert.equal(await keep(b.page, { replace: true }), 'busy', 'tab a still holds the saved disk');
    assert.deepEqual(await a.run('cat /root/keep-marker', COMMAND_MS), ['kept'], 'the saved disk is untouched');
    await a.page.close();
    assert.equal(await keep(b.page, { replace: true }), 'kept');
    await b.run('sync', COMMAND_MS);
    await b.reload();
    assert.deepEqual(await disk(b.page), { mode: 'persistent', created: false, reason: null });
    assert.deepEqual(await b.run('cat /root/keep-marker; test -e /root/after-keep && echo old || echo new', COMMAND_MS), ['second-tab', 'new']);
  });
});
