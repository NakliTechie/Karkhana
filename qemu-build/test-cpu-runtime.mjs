// Browser check of the guest CPU model on an engine (Batch O, kept for every
// engine build): x86-64-v2 instructions as Bun and OpenCode use them.
//   - POPCNT gives known answers (a 397-byte static probe),
//   - Bun runs JavaScript, AES-GCM, SHA-256 and a subprocess,
//   - Node 22 runs the same crypto known answers,
//   - with KARKHANA_OPENCODE=1, OpenCode prints its version (minutes under TCG).
// The binaries are too large for the repo: KARKHANA_CPU_ASSETS names a directory
// holding bun (1.4.2, linux x64 baseline), popcnt-probe and, for OpenCode,
// opencode (1.18.33). They are staged into /persist and copied onto the disk.
// Run: node qemu-build/test-cpu-runtime.mjs   (KARKHANA_ROOT and KARKHANA_URL as elsewhere)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, serve, shell, sleep, until } from './browser-harness.mjs';

const ROOT = path.resolve(process.env.KARKHANA_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const PAGE = existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : 'karkhana.html';
const LIVE_URL = process.env.KARKHANA_URL;
const BOOT_MS = LIVE_URL ? 900_000 : 240_000;
const ASSETS = process.env.KARKHANA_CPU_ASSETS || '/Users/chiragpatnaik/Code/Karkhana-cpu-compatibility/qemu-build/diagnostics/htdocs';
const OPENCODE = process.env.KARKHANA_OPENCODE === '1';
const EXPECTED_POPCNT = [32, 32, 64, 1, 1, 1, 1, 0, 16, 0, 32, 0, 0, 1, 1, 0];

const RUNTIME_JS = `const assert = require('node:assert/strict');
const crypto = require('node:crypto');
assert.equal(6 * 7, 42);
const c = crypto.createCipheriv('aes-128-gcm', Buffer.alloc(16), Buffer.alloc(12));
const ciphertext = Buffer.concat([c.update(Buffer.alloc(16)), c.final()]);
assert.equal(ciphertext.toString('hex'), '0388dace60b6a392f328c2b971b2fe78');
assert.equal(c.getAuthTag().toString('hex'), 'ab6e47d42cec13bdf53a67b21257bddf');
assert.equal(crypto.createHash('sha256').update('abc').digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
console.log('RUNTIME_OK ' + (typeof Bun === 'undefined' ? process.version : 'bun-' + Bun.version));
if (typeof Bun !== 'undefined') {
  const child = Bun.spawnSync(['/bin/echo', 'BUN_CHILD_OK']);
  assert.equal(child.exitCode, 0);
  assert.equal(child.stdout.toString().trim(), 'BUN_CHILD_OK');
  console.log('BUN_CHILD_OK');
}
`;

const SCRIPT = `#!/bin/sh
exec > /persist/cpu-check.log 2>&1
set -eu
trap 'status=$?; [ "$status" -ne 0 ] && echo "CHECK_FAILED=$status"' EXIT
mkdir -p /root/cpu-probe && cd /root/cpu-probe
cp /persist/bun /persist/popcnt-probe /persist/cpu-runtime.js .
chmod +x bun popcnt-probe
timeout 120 ./popcnt-probe > /persist/popcnt-output
echo "BUN_VERSION=$(timeout 120 ./bun --version)"
timeout 120 ./bun cpu-runtime.js
timeout 120 node cpu-runtime.js
${OPENCODE ? `cp /persist/opencode . && chmod +x opencode
start=$(date +%s); echo "OPENCODE_VERSION=$(timeout 1200 ./opencode --version)"; echo "OPENCODE_SECONDS=$(($(date +%s) - start))"` : ''}
cd / && rm -rf /root/cpu-probe
echo CHECK_COMPLETE
`;

test('the guest CPU runs Bun and Node correctly', { timeout: BOOT_MS + (OPENCODE ? 1_800_000 : 600_000) }, async (t) => {
  const names = ['bun', 'popcnt-probe', ...(OPENCODE ? ['opencode'] : [])];
  for (const name of names) assert.ok(existsSync(path.join(ASSETS, name)), `${name} missing from ${ASSETS}`);
  const server = LIVE_URL ? null : await serve(ROOT);
  const browser = await launch();
  t.after(async () => { await browser.close(); server?.close(); });
  const page = await browser.newPage();
  const sh = shell(page);
  await page.send('Page.navigate', { url: LIVE_URL ? `${LIVE_URL}${LIVE_URL.includes('?') ? '&' : '?'}disk=scratch` : `http://127.0.0.1:${server.address().port}/${PAGE}?disk=scratch` });
  await until('the page script', () => page.evaluate('!!window.karkhana?.shell'), 60_000);
  await sh.capture();
  await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);

  // Into page memory (/persist), 4 MiB at a time.
  const stage = async (name, data) => {
    await page.evaluate(`window.__fd = Module.FS.open('/persist/${name}', 'w'); true`);
    for (let at = 0; at < data.length; at += 4 << 20) {
      const chunk = data.subarray(at, at + (4 << 20)).toString('base64');
      await page.evaluate(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(chunk)}), (c) => c.charCodeAt(0)); Module.FS.write(window.__fd, b, 0, b.length, ${at}); return true; })()`);
    }
    await page.evaluate('Module.FS.close(window.__fd); true');
  };
  for (const name of names) await stage(name, readFileSync(path.join(ASSETS, name)));
  await stage('cpu-runtime.js', Buffer.from(RUNTIME_JS));
  await stage('cpu-check.sh', Buffer.from(SCRIPT));
  // A subshell: run() appends `; echo <marker>`, and `&;` is a syntax error.
  await sh.run('(sh /persist/cpu-check.sh &)', 60_000);
  const log = await until('the guest checks', async () => {
    const text = await page.evaluate("(() => { try { return Module.FS.readFile('/persist/cpu-check.log', { encoding: 'utf8' }); } catch (e) { return ''; } })()");
    return /CHECK_(COMPLETE|FAILED)/.test(text) ? text : null;
  }, OPENCODE ? 1_500_000 : 300_000);
  t.diagnostic(log.trim().split('\n').join(' | '));
  assert.match(log, /CHECK_COMPLETE/);
  const out = Buffer.from(await page.evaluate("Array.from(Module.FS.readFile('/persist/popcnt-output'))"));
  assert.deepEqual(EXPECTED_POPCNT.map((_, i) => Number(out.readBigUInt64LE(i * 8))), EXPECTED_POPCNT, 'POPCNT known answers');
  assert.match(log, /BUN_VERSION=1\.4\.2/);
  assert.match(log, /RUNTIME_OK bun-1\.4\.2/);
  assert.match(log, /BUN_CHILD_OK/);
  assert.match(log, /RUNTIME_OK v22\./);
  if (OPENCODE) assert.match(log, /OPENCODE_VERSION=1\.18\.33/);
  await sleep(0);
});
