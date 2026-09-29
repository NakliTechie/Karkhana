// Browser metadata semantics, authorization, lifecycle, and memory bounds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const source = readFileSync(new URL('./net/pypi-metadata.js', import.meta.url));
const { createPyPIProcessor, encodeProject, PYPI_LIMITS, JSON_TYPE, HTML_TYPE } =
  await import('data:text/javascript;base64,' + source.toString('base64'));
const BASE = 'http://127.0.0.1:12345', SESSION = 'a'.repeat(32);
const FILENAME = 'demo-1.0-py3-none-any.whl';
const UPSTREAM = 'https://files.pythonhosted.org/packages/ab/cd/123/' + FILENAME;
const ROUTE = '/files' + new URL(UPSTREAM).pathname;
const DOCUMENT = { meta: { 'api-version': '1.1' }, name: 'demo', versions: ['1.0'], files: [{
  filename: FILENAME, url: UPSTREAM, hashes: { sha256: 'a'.repeat(64), md5: 'c'.repeat(32) },
  'requires-python': '>=3.9,<4', yanked: 'use "1.1" instead',
  'core-metadata': { sha256: 'b'.repeat(64) }, 'dist-info-metadata': { sha256: 'b'.repeat(64) }, size: 200000,
}, { filename: 'demo-1.0.tar.gz', url: 'https://files.pythonhosted.org/packages/source.tar.gz' }] };
const copy = value => JSON.parse(JSON.stringify(value));
const request = (fields = {}) => ({ url: 'https://pypi.org/simple/demo/', method: 'GET', headers: [],
  pypi: { operation: 'project', session: SESSION, baseUrl: BASE, project: 'demo', format: 'json', ...fields } });
const fileRequest = (path = ROUTE, fields = {}) => ({ url: 'https://files.pythonhosted.org' + path.slice(6),
  method: 'GET', headers: [], pypi: { operation: 'file', session: SESSION, baseUrl: BASE, path, ...fields } });
const closeRequest = (fields = {}) => ({ url: 'https://pypi.org/', method: 'GET', headers: [],
  pypi: { operation: 'close', session: SESSION, baseUrl: BASE, ...fields } });
const json = async () => Response.json(DOCUMENT);
const bytes = async response => {
  const reader = response.body.getReader(), chunks = [];
  for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(Buffer.from(part.value)); }
  return Buffer.concat(chunks);
};
async function call(processor, req = request(), remote = json, controller = new AbortController()) {
  const opened = await processor.open(req, controller, remote);
  try { return { ...opened.response, bytes: await bytes(opened.response) }; }
  finally { opened.release(); }
}
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('JSON preserves every per-file field, hashes and wheel-only selection', () => {
  const original = copy(DOCUMENT);
  const encoded = encodeProject('demo', DOCUMENT, BASE, 'json');
  const result = JSON.parse(Buffer.from(encoded.bytes));
  assert.equal(result.files.length, 1);
  assert.deepEqual({ ...result.files[0], url: original.files[0].url }, original.files[0]);
  assert.equal(result.files[0].url, BASE + ROUTE + '#sha256=' + 'a'.repeat(64));
  assert.deepEqual(DOCUMENT, original);
  assert.equal(encoded.additions.get(ROUTE), true);
  assert.equal(encoded.contentType, JSON_TYPE);
  original.files[0].url += '#md5=original';
  assert.match(JSON.parse(Buffer.from(encodeProject('demo', original, BASE, 'json').bytes)).files[0].url, /#md5=original$/);
});

test('HTML escapes attributes and preserves yanked, Python and both sidecar hashes', () => {
  const result = encodeProject('demo', DOCUMENT, BASE, 'html');
  const body = Buffer.from(result.bytes).toString();
  assert.equal(result.contentType, HTML_TYPE);
  assert.match(body, /data-requires-python="&gt;=3.9,&lt;4"/);
  assert.match(body, /data-yanked="use &quot;1.1&quot; instead"/);
  assert.match(body, /data-core-metadata="sha256=bbbb/);
  assert.match(body, /data-dist-info-metadata="sha256=bbbb/);
  assert.ok(!body.includes('tar.gz'));
  for (const yanked of ['', true]) {
    const doc = copy(DOCUMENT); doc.files[0].yanked = yanked;
    assert.match(Buffer.from(encodeProject('demo', doc, BASE, 'html').bytes).toString(), /data-yanked=""/);
  }
});

test('download origins, credentials and traversal fail before URL normalization', () => {
  const invalid = ['https://evil.example/packages/', 'http://files.pythonhosted.org/packages/',
    'https://files.pythonhosted.org.evil.example/packages/', 'https://secret@files.pythonhosted.org/packages/',
    'https://@files.pythonhosted.org/packages/',
    'https://files.pythonhosted.org:8443/packages/', 'https://files.pythonhosted.org/private/',
    'https://files.pythonhosted.org/packages/%2e%2e/', 'https://files.pythonhosted.org/packages/a/../',
    'https://files.pythonhosted.org/packages/%2f..%2f/', 'https://files.pythonhosted.org/packages/a\\',
    'https://files.pythonhosted.org/packages/%00/', 'https://files.pythonhosted.org/packages/\r/',
    'https://files.pythonhosted.org/packages/%5c/'];
  for (const prefix of invalid) {
    const doc = copy(DOCUMENT); doc.files[0].url = prefix + FILENAME;
    assert.throws(() => encodeProject('demo', doc, BASE, 'json'), { code: 'blocked' }, prefix);
  }
  const doc = copy(DOCUMENT); doc.files[0].url += '?token=secret';
  assert.throws(() => encodeProject('demo', doc, BASE, 'json'), { code: 'blocked' });
});

test('network-path URLs, port 443, and escaped matching filenames retain exact routes', () => {
  for (const url of [UPSTREAM.replace('https:', ''), UPSTREAM.replace('.org/', '.org:443/'), UPSTREAM.replace('demo-', 'd%65mo-')]) {
    const doc = copy(DOCUMENT); doc.files[0].url = url;
    const result = encodeProject('demo', doc, BASE, 'json');
    const route = '/files' + new URL(url, 'https://pypi.org').pathname;
    assert.ok(result.additions.has(route));
    assert.equal(new URL(JSON.parse(Buffer.from(result.bytes)).files[0].url).pathname, route);
  }
  const doc = copy(DOCUMENT); doc.files[0].filename = 'different.whl';
  assert.throws(() => encodeProject('demo', doc, BASE, 'json'), /filename does not match/);
});

test('sessions isolate origins, caches and advertised file permissions', async () => {
  const processor = createPyPIProcessor();
  const a = await call(processor);
  const other = { session: 'b'.repeat(32), baseUrl: 'http://127.0.0.1:23456' };
  let downloads = 0;
  const wheel = async () => { downloads++; return new Response('wheel'); };
  await assert.rejects(call(processor, fileRequest(ROUTE, other), wheel), { code: 'blocked' });
  await assert.rejects(call(processor, request({ baseUrl: other.baseUrl })), /origin changed/);
  const b = await call(processor, request(other));
  assert.ok(JSON.parse(a.bytes).files[0].url.startsWith(BASE + '/files/'));
  assert.ok(JSON.parse(b.bytes).files[0].url.startsWith(other.baseUrl + '/files/'));
  await call(processor, fileRequest(), wheel);
  await call(processor, fileRequest(ROUTE + '.metadata', other), wheel);
  assert.equal(downloads, 2);
  await call(processor, closeRequest());
  await assert.rejects(call(processor, fileRequest(), wheel), { code: 'blocked' });
  assert.equal(processor.status.sessions, 1);
  processor.stop();
  assert.equal(processor.status.cacheBytes, 0);
  assert.equal(processor.status.wheels, 0);
});

test('invalid loopback origins and unknown operations never allocate or fetch', async () => {
  const processor = createPyPIProcessor();
  const remote = () => { throw new Error('unexpected fetch'); };
  for (const baseUrl of ['http://localhost:12345', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://127.0.0.1:0123', 'http://127.0.0.1:12345/', 'http://127.0.0.1:12345?x',
    'http://user@127.0.0.1:12345', 'https://127.0.0.1:12345']) {
    await assert.rejects(call(processor, request({ baseUrl }), remote), { code: 'blocked' });
  }
  await assert.rejects(call(processor, fileRequest(), remote), { code: 'blocked' });
  await assert.rejects(call(processor, request({ operation: 'other' }), remote), { code: 'blocked' });
  await assert.rejects(call(processor, request({ session: [SESSION] }), remote), { code: 'blocked' });
  await call(processor, closeRequest(), remote);
  assert.equal(processor.status.sessions, 0);
});

test('sidecars require advertised metadata with Python-compatible false values and exact paths', async () => {
  for (const metadata of [false, {}, [], null, 0, '']) {
    const processor = createPyPIProcessor();
    const doc = copy(DOCUMENT); doc.files[0]['core-metadata'] = metadata;
    await call(processor, request(), async () => Response.json(doc));
    await assert.rejects(call(processor, fileRequest(ROUTE + '.metadata')), { code: 'blocked' });
    await call(processor, fileRequest(), async () => new Response('wheel'));
  }
  const processor = createPyPIProcessor();
  const oldField = copy(DOCUMENT); delete oldField.files[0]['core-metadata'];
  await call(processor, request(), async () => Response.json(oldField));
  await call(processor, fileRequest(ROUTE + '.metadata'), async () => new Response('legacy metadata'));
  await call(processor);
  for (const path of [ROUTE + '.metadata.metadata', ROUTE + '.metadata/', ROUTE + '%2emetadata',
    ROUTE.replace('/123/', '/unadvertised/') + '.metadata'])
    await assert.rejects(call(processor, fileRequest(path)), { code: 'blocked' });
  const doc = copy(DOCUMENT); doc.files[0]['core-metadata'] = false;
  await call(processor, request({ format: 'html' }), async () => Response.json(doc));
  await call(processor, fileRequest(ROUTE + '.metadata'), async () => new Response('metadata'));
  assert.equal(processor.status.wheels, 1);
});

test('registration and encoding failures are atomic and release empty sessions', async () => {
  const processor = createPyPIProcessor({ limits: { ...PYPI_LIMITS, sessionWheels: 1, cacheBytes: 0 } });
  await call(processor);
  const tooMany = copy(DOCUMENT);
  tooMany.files[0]['core-metadata'] = false;
  tooMany.files.push({ ...tooMany.files[0], url: UPSTREAM.replace('/123/', '/456/') });
  await assert.rejects(call(processor, request(), async () => Response.json(tooMany)), /wheel limit/);
  assert.equal(processor.status.wheels, 1);
  await call(processor, fileRequest(ROUTE + '.metadata'), async () => new Response('metadata'));
  await assert.rejects(call(processor, fileRequest(ROUTE.replace('/123/', '/456/'))), { code: 'blocked' });
  const invalid = copy(DOCUMENT); invalid.files.push({ filename: 'bad.whl', url: 'https://evil.example/bad.whl' });
  const clean = createPyPIProcessor();
  await assert.rejects(call(clean, request(), async () => Response.json(invalid)), { code: 'blocked' });
  assert.equal(clean.status.wheels, 0);
  assert.equal(clean.status.sessions, 0);
});

test('malformed UTF-8, oversized input and oversized output never cache or authorize', async () => {
  const invalidUTF8 = Buffer.concat([Buffer.from('{"files":[],"name":"'), Buffer.from([255]), Buffer.from('"}')]);
  for (const [limits, body] of [
    [PYPI_LIMITS, invalidUTF8], [PYPI_LIMITS, '{invalid'],
    [{ ...PYPI_LIMITS, projectBytes: 10 }, JSON.stringify(DOCUMENT)],
    [{ ...PYPI_LIMITS, encodedBytes: 10 }, JSON.stringify(DOCUMENT)],
  ]) {
    const processor = createPyPIProcessor({ limits });
    await assert.rejects(call(processor, request(), async () => new Response(body)));
    assert.equal(processor.status.cacheBytes, 0);
    assert.equal(processor.status.wheels, 0);
    assert.equal(processor.status.sessions, 0);
  }
});

test('global cache uses LRU byte and entry bounds across sessions', async () => {
  const oneSize = encodeProject('demo', DOCUMENT, BASE, 'json').bytes.byteLength;
  const processor = createPyPIProcessor({ limits: { ...PYPI_LIMITS, cacheBytes: oneSize * 2, cacheEntries: 2 } });
  let calls = 0;
  const remote = async () => { calls++; return Response.json(DOCUMENT); };
  for (const session of ['a', 'b', 'a', 'c', 'a', 'b']) {
    await call(processor, request({ session: session.repeat(32) }), remote);
    assert.ok(processor.status.cacheBytes <= oneSize * 2);
    assert.ok(processor.status.cacheEntries <= 2);
  }
  assert.equal(calls, 4);
  assert.equal(processor.status.cacheHits, 2);
  const noCache = createPyPIProcessor({ limits: { ...PYPI_LIMITS, cacheBytes: 1 } });
  await call(noCache);
  assert.equal(noCache.status.cacheBytes, 0);
  assert.equal(noCache.status.wheels, 1);
});

test('global session, wheel and registry-byte limits cannot multiply per install', async () => {
  for (const limits of [{ ...PYPI_LIMITS, sessions: 1 }, { ...PYPI_LIMITS, wheels: 1 },
    { ...PYPI_LIMITS, registryBytes: ROUTE.length * 2 + 48 }]) {
    const processor = createPyPIProcessor({ limits });
    await call(processor);
    await assert.rejects(call(processor, request({ session: 'b'.repeat(32) })), /limit|sessions/);
    assert.equal(processor.status.sessions, 1);
    assert.equal(processor.status.wheels, 1);
  }
});

test('four concurrent callers share work while a cancelled original caller releases only itself', async () => {
  const processor = createPyPIProcessor();
  const entered = gate(), release = gate();
  let calls = 0, upstreamSignal;
  const remote = async (_url, options) => {
    calls++; upstreamSignal = options.signal; entered.resolve();
    await release.promise; return Response.json(DOCUMENT);
  };
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const tasks = controllers.map(controller => call(processor, request(), remote, controller));
  await entered.promise;
  controllers[0].abort();
  await assert.rejects(tasks[0], { code: 'cancelled' });
  assert.equal(upstreamSignal.aborted, false);
  release.resolve();
  const results = await Promise.all(tasks.slice(1));
  assert.ok(results.every(result => result.bytes.equals(results[0].bytes)));
  assert.equal(calls, 1);
  assert.equal(processor.status.shared, 3);
});

test('failed shared work releases every caller and retry starts fresh', async () => {
  const processor = createPyPIProcessor();
  const release = gate();
  let calls = 0;
  const remote = async () => { calls++; await release.promise; throw new Error('fixture failure'); };
  const tasks = Array.from({ length: 4 }, () => call(processor, request(), remote));
  const outcomes = Promise.allSettled(tasks);
  release.resolve();
  assert.ok((await outcomes).every(result => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal(processor.status.sessions, 0);
  await call(processor);
  assert.equal(processor.status.projects, 1);
});

test('close and stop prevent ignored-abort continuations repopulating state after same-ID reuse', async () => {
  for (const action of ['close', 'stop']) {
    const processor = createPyPIProcessor();
    const release = gate(), entered = gate();
    const old = call(processor, request(), async () => { entered.resolve(); await release.promise; return Response.json(DOCUMENT); });
    const rejected = assert.rejects(old, /cancelled|closed/);
    await entered.promise;
    if (action === 'close') await call(processor, closeRequest()); else processor.stop();
    await rejected;
    await call(processor, request(), async () => Response.json({ files: [] }));
    release.resolve();
    await nextTurn();
    assert.equal(processor.status.wheels, 0);
    assert.equal(processor.status.projects, 1);
    await assert.rejects(call(processor, fileRequest()), { code: 'blocked' });
  }
});

test('all cancelled callers abort upstream and permit an immediate retry', async () => {
  const processor = createPyPIProcessor();
  const entered = gate(), release = gate();
  const controller = new AbortController();
  let signal;
  const pending = call(processor, request(), async (_url, options) => {
    signal = options.signal; entered.resolve(); await release.promise; return Response.json(DOCUMENT);
  }, controller);
  const rejected = assert.rejects(pending, /cancelled/);
  await entered.promise;
  controller.abort(); await rejected;
  assert.equal(signal.aborted, true);
  await call(processor);
  release.resolve(); await nextTurn();
  assert.equal(processor.status.projects, 1);
  assert.equal(processor.status.wheels, 1);
});

test('idle expiry reclaims authorization but keeps active work alive', async () => {
  let time = 0;
  const processor = createPyPIProcessor({ now: () => time, limits: { ...PYPI_LIMITS, idleMs: 10 } });
  const opened = await processor.open(request(), new AbortController(), json);
  time = 20;
  assert.equal(processor.status.sessions, 1);
  opened.release();
  time = 31;
  assert.equal(processor.status.sessions, 0);
  assert.equal(processor.status.cacheBytes, 0);
  assert.equal(processor.status.registryBytes, 0);
  await assert.rejects(call(processor, fileRequest()), { code: 'blocked' });
});

test('upstream error statuses remain distinct and redirects never authorize or cache', async () => {
  const processor = createPyPIProcessor();
  for (const status of [404, 403, 500]) {
    const result = await call(processor, request(), async () => new Response('error', { status }));
    assert.equal(result.status, status);
  }
  await assert.rejects(call(processor, request(), async () => ({ status: 200, url: 'https://evil.example/', body: null })), { code: 'blocked' });
  assert.equal(processor.status.wheels, 0);
  assert.equal(processor.status.cacheBytes, 0);
});
