// Host checks for net/egress.js against naklios's real nakli-egress Worker,
// run in-process: the Worker's own fetch handler and signature check, a fake
// upstream behind it. No network, no deploy.
// Run: node qemu-build/test-egress.mjs
// NAKLI_EGRESS names the nakli-egress checkout (default: ~/Code/naklios-universe/naklios/nakli-egress).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { RANGE_BYTES, canonicalString, createEgress, hostListed } from './net/egress.js';

const EGRESS_DIR = process.env.NAKLI_EGRESS || path.join(homedir(), 'Code/naklios-universe/naklios/nakli-egress');
const present = existsSync(path.join(EGRESS_DIR, 'src/index.js'));
const skip = present ? false : `nakli-egress not found at ${EGRESS_DIR}`;
const WORKER = 'https://egress.example.workers.dev/';
const SECRET = 'test-secret-0123456789';
const BIG = 40 * 1024 * 1024 + 123;

// A fake upstream: the Worker's outbound fetch lands here.
function upstream(url, init = {}) {
  const u = new URL(url);
  const headers = new Headers(init.headers);
  if (u.hostname === 'files.example.com') {
    if (u.pathname === '/small') return new Response('hello', { headers: { 'content-type': 'text/plain', 'x-seen-ua': headers.get('user-agent') || '' } });
    if (u.pathname === '/auth') return new Response(headers.get('authorization') || 'none');
    if (u.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: '/small' } });
    if (u.pathname === '/away') return new Response(null, { status: 302, headers: { location: 'https://direct.example.org/thing' } });
    if (u.pathname === '/empty') return new Response(null, { status: 204 });
    if (u.pathname === '/echo') return new Response(init.body, { headers: { 'x-method': init.method } });
    if (u.pathname === '/big') {
      const body = new Uint8Array(BIG);
      for (let i = 0; i < BIG; i += 4096) body[i] = (i / 4096) & 0xff;
      const m = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range') || '');
      if (!m) return new Response(body);
      const start = +m[1];
      const end = Math.min(+m[2], BIG - 1);
      return new Response(body.slice(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${BIG}` } });
    }
  }
  return new Response('not found', { status: 404 });
}

async function setup({ secret = SECRET, allowlist = 'files.example.com' } = {}) {
  const worker = (await import(pathToFileURL(path.join(EGRESS_DIR, 'src/index.js')).href)).default;
  globalThis.fetch = async (url, init) => upstream(url, init);
  const env = { EGRESS_SECRET: SECRET, ALLOWLIST: allowlist, ALLOW_ORIGINS: 'https://karkhana.naklitechie.com' };
  const direct = [];
  const fetchImpl = async (url, init) => {
    if (url === WORKER) return worker.fetch(new Request(url, { ...init, headers: { ...init.headers, origin: 'https://karkhana.naklitechie.com' } }), env);
    direct.push(url);
    return new Response('direct ' + url);
  };
  return { egress: createEgress({ workerUrl: WORKER, secret, hosts: ['files.example.com'], fetchImpl }), direct };
}

test('the signing string matches nakli-egress byte for byte', { skip }, async () => {
  const lib = await import(pathToFileURL(path.join(EGRESS_DIR, 'src/lib.js')).href);
  const req = { method: 'post', url: 'https://x/y?z', headers: { B: '2', a: '1', Host: 'x', 'Content-Length': '3' }, bodySha256: 'ab', nonce: 'n', ts: 7 };
  assert.equal(canonicalString(req), lib.canonicalString(req));
});

test('a listed GET goes through the Worker and comes back as a Response', { skip }, async () => {
  const { egress } = await setup();
  const r = await egress.fetch('https://files.example.com/small', {}, { 'User-Agent': 'apt' });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'hello');
  assert.equal(r.headers.get('x-seen-ua'), 'apt', 'the guest headers reach the upstream');
  assert.equal(r.url, 'https://files.example.com/small');
});

test('the guest Authorization header is relayed, not stripped', { skip }, async () => {
  const { egress } = await setup();
  const r = await egress.fetch('https://files.example.com/auth', {}, { Authorization: 'Bearer t' });
  assert.equal(await r.text(), 'Bearer t');
});

test('a body over the Worker cap arrives whole, fetched in ranges', { skip }, async () => {
  const { egress } = await setup();
  const r = await egress.fetch('https://files.example.com/big');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), String(BIG));
  const body = new Uint8Array(await r.arrayBuffer());
  assert.equal(body.length, BIG);
  assert.ok(BIG > 2 * RANGE_BYTES, 'the case needs three ranges');
  for (const i of [0, RANGE_BYTES, 2 * RANGE_BYTES, BIG - 123]) {
    if (i % 4096 === 0) assert.equal(body[i], (i / 4096) & 0xff, `byte ${i}`);
  }
});

test('redirects are followed through the Worker, and leave it for unlisted hosts', { skip }, async () => {
  const { egress, direct } = await setup();
  const r = await egress.fetch('https://files.example.com/redirect');
  assert.equal(await r.text(), 'hello');
  assert.equal(r.redirected, true);
  const away = await egress.fetch('https://files.example.com/away');
  assert.equal(await away.text(), 'direct https://direct.example.org/thing');
  assert.deepEqual(direct, ['https://direct.example.org/thing']);
});

test('POST bodies and null-body statuses survive the relay', { skip }, async () => {
  const { egress } = await setup();
  const r = await egress.fetch('https://files.example.com/echo', { method: 'POST', body: new TextEncoder().encode('payload') });
  assert.equal(r.headers.get('x-method'), 'POST');
  assert.equal(await r.text(), 'payload');
  const empty = await egress.fetch('https://files.example.com/empty');
  assert.equal(empty.status, 204);
});

test('a wrong secret or a host off the Worker allowlist fails as a fetch error', { skip }, async () => {
  const bad = await setup({ secret: 'wrong' });
  await assert.rejects(bad.egress.fetch('https://files.example.com/small'), (e) => e instanceof TypeError && /bad signature/.test(e.message));
  const narrow = await setup({ allowlist: 'other.example.com' });
  await assert.rejects(narrow.egress.fetch('https://files.example.com/small'), (e) => e instanceof TypeError && /destination not allowed/.test(e.message));
  assert.equal(narrow.egress.stats.failed, 1);
});

test('routes() takes exact hosts and *.suffix rules, http(s) only', () => {
  const hosts = ['deb.debian.org', '*.githubusercontent.com'];
  assert.equal(hostListed('http://deb.debian.org/debian/dists', hosts), true);
  assert.equal(hostListed('https://objects.githubusercontent.com/x', hosts), true);
  assert.equal(hostListed('https://githubusercontent.com/x', hosts), true);
  assert.equal(hostListed('https://evilgithubusercontent.com/x', hosts), false);
  assert.equal(hostListed('https://pypi.org/simple/', hosts), false);
  assert.equal(hostListed('ftp://deb.debian.org/', hosts), false);
});
