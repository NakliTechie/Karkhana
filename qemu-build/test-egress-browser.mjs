// Browser check of egress (Batch E3): boots the real page in headless Chrome on
// the in-page network path and proves that, through a nakli-egress Worker,
//   - a host without CORS headers fails before egress is configured,
//   - apt-get update and install work, and
//   - a GitHub release asset downloads, following its redirect.
// Needs a running Worker whose ALLOW_ORIGINS admits the test origin, e.g. locally:
//   npx wrangler dev --var 'ALLOW_ORIGINS:*' --var 'ALLOWLIST:deb.debian.org,...'
// Run: KARKHANA_EGRESS_URL=http://127.0.0.1:8787/ KARKHANA_EGRESS_SECRET=... node qemu-build/test-egress-browser.mjs
// KARKHANA_ROOT and KARKHANA_URL work as in test-persistent-disk.mjs.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, serve, shell, until } from './browser-harness.mjs';

const ROOT = path.resolve(process.env.KARKHANA_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const PAGE = existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : 'karkhana.html';
const LIVE_URL = process.env.KARKHANA_URL;
const WORKER = process.env.KARKHANA_EGRESS_URL;
const SECRET = process.env.KARKHANA_EGRESS_SECRET;
const BOOT_MS = LIVE_URL ? 900_000 : 240_000;
const RELEASE = 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz';

test('egress reaches hosts that send no CORS headers', { skip: !(WORKER && SECRET) && 'set KARKHANA_EGRESS_URL and KARKHANA_EGRESS_SECRET', timeout: BOOT_MS + 1_800_000 }, async (t) => {
  const server = LIVE_URL ? null : await serve(ROOT);
  const browser = await launch();
  t.after(async () => { await browser.close(); server?.close(); });
  const page = await browser.newPage();
  await page.send('Page.navigate', { url: LIVE_URL || `http://127.0.0.1:${server.address().port}/${PAGE}` });
  const { capture, run } = shell(page);
  await until('the page script', () => page.evaluate('!!window.karkhana?.shell'), 30_000);
  await capture();
  await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
  assert.equal(await page.evaluate('window.karkhana.net.mode'), 'browser-fetch', 'egress serves the in-page network path');

  await t.test('without egress, a GitHub release does not download', async () => {
    const out = await run(`curl -fsSL --max-time 60 -o /tmp/rg.tgz ${RELEASE}; echo exit=$?`, 120_000);
    assert.notEqual(out.at(-1), 'exit=0');
  });

  await page.evaluate(`window.karkhana.egress.configure(${JSON.stringify({ workerUrl: WORKER, secret: SECRET })}); true`);
  assert.equal(await page.evaluate('window.karkhana.egress.status.configured'), true);

  await t.test('apt-get update and install work through the Worker', async () => {
    const update = await run('apt-get update 2>&1 | tail -1; echo exit=${PIPESTATUS[0]}', 900_000);
    assert.equal(update.at(-1), 'exit=0', update.join('\n'));
    const install = await run('apt-get install -y --no-install-recommends tree >/tmp/apt.log 2>&1; echo exit=$?; tree --version', 900_000);
    assert.equal(install[0], 'exit=0', install.join('\n'));
    assert.match(install[1], /^tree v/);
  });

  await t.test('a GitHub release asset downloads through its redirect', async () => {
    const out = await run(`curl -fsSL --max-time 300 -o /tmp/rg.tgz ${RELEASE} && tar -xzf /tmp/rg.tgz -C /tmp && /tmp/ripgrep-14.1.1-x86_64-unknown-linux-musl/rg --version | head -1`, 600_000);
    assert.match(out.at(-1), /^ripgrep 14\.1\.1/);
    const status = await page.evaluate('window.karkhana.egress.status');
    assert.ok(status.requests > 0 && status.bytes > 0, JSON.stringify(status));
  });
});
