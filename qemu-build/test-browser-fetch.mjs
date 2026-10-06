// Low-cost host tests: run the actual Python mailbox client against the JS
// service without booting QEMU or rebuilding its multi-gigabyte heap.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync,
  chmodSync, rmSync, existsSync, unlinkSync, rmdirSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syntheticProject } from './fixtures/pypi-project.mjs';

const sourcePath = process.env.BROWSER_FETCH_SOURCE || new URL('./net/browser-fetch.js', import.meta.url);
const clientPath = process.env.KFETCH_TEST_CLIENT || new URL('./guest/kfetch.py', import.meta.url).pathname;
const metadataURL = 'data:text/javascript;base64,' + readFileSync(new URL('./net/pypi-metadata.js', import.meta.url)).toString('base64');
// npm-tree.js imports semver.mjs; a data: module has no base URL, so inline both.
const semverURL = 'data:text/javascript;base64,' + readFileSync(new URL('./net/semver.mjs', import.meta.url)).toString('base64');
const npmTreeURL = 'data:text/javascript;base64,' + Buffer.from(readFileSync(new URL('./net/npm-tree.js', import.meta.url), 'utf8')
  .replace("'./semver.mjs'", JSON.stringify(semverURL))).toString('base64');
const source = Buffer.from(readFileSync(sourcePath, 'utf8').replace("'./pypi-metadata.js'", JSON.stringify(metadataURL))
  .replace("'./npm-tree.js'", JSON.stringify(npmTreeURL)));
const { createBrowserFetchBridge, FETCH_LIMITS } = await import(`data:text/javascript;base64,${source.toString('base64')}`);
const generation = '6a8d81c1-b0bd-4d42-b0bc-f52168f114a6';
const id = 'a'.repeat(32);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = check();
    if (result) return result;
    await sleep(5);
  }
  throw new Error('test condition timed out');
}

function fixture(t, fetchImpl, pypiOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'karkhana-fetch-test-'));
  const root = join(directory, 'mailbox');
  const FS = { mkdir: mkdirSync, stat: statSync, readFile: path => new Uint8Array(readFileSync(path)),
    writeFile: writeFileSync, chmod: chmodSync, unlink: unlinkSync, rmdir: rmdirSync };
  const bridge = createBrowserFetchBridge(FS, { root, generation, fetchImpl, pypiOptions,
    limits: { ...FETCH_LIMITS, pollMs: 2 } });
  bridge.start();
  t.after(() => { bridge.stop(); rmSync(directory, { recursive: true, force: true }); });
  const config = JSON.parse(readFileSync(join(root, 'config.json')));
  const actualGeneration = config.generation;
  const path = name => join(root, ...(config.protocol === 2 ? [actualGeneration] : []), '0', name);
  const write = (name, value) => writeFileSync(path(name), typeof value === 'string' ? value : JSON.stringify(value));
  function request(override = {}, requestId = id) {
    write('request', { protocol: config.protocol, generation: actualGeneration, id: requestId, method: 'GET',
      url: 'https://files.pythonhosted.org/packages/example.whl', headers: [], timeoutMs: 3000, ...override });
    write('request-ready', `${actualGeneration}:${requestId}`);
  }
  const frame = () => { try { return JSON.parse(readFileSync(path('ready'))); } catch (_) { return null; } };
  function pythonRaw(args) {
    const child = spawn('python3', args, { env: { ...process.env, KARKHANA_FETCH_ROOT: root } });
    let stdout = [], stderr = '';
    child.stdout.on('data', data => stdout.push(data));
    child.stderr.on('data', data => { stderr += data; });
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => resolve({ code, stdout: Buffer.concat(stdout), stderr }));
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return completion;
  }
  const python = args => pythonRaw([clientPath, ...args]);
  return { bridge, FS, generation: actualGeneration, token: `${actualGeneration}:${id}`, directory, root, path, write, request, frame, python, pythonRaw };
}

test('Python client streams binary bytes and commits the output only after EOF', async t => {
  const bytes = Buffer.alloc(1048609);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  let options;
  const f = fixture(t, async (url, init) => {
    options = init;
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': '17' } });
  });
  const output = join(f.directory, 'result.whl');
  const result = await f.python(['-f', '-o', output, 'https://files.pythonhosted.org/packages/example.whl']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readFileSync(output), bytes);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.mode, 'cors');
  assert.equal(options.redirect, 'error');
  await until(() => f.bridge.status.completed === 1);
  assert.equal(f.bridge.status.bytes, bytes.length);
});

test('four Python clients stream isolated bytes while a fifth waits for a free slot', { timeout: 15000 }, async t => {
  const payloads = Array.from({ length: 5 }, (_, client) => {
    const bytes = Buffer.alloc(FETCH_LIMITS.chunkBytes * 2 + 137 + client * 53);
    for (let offset = 0; offset < bytes.length; offset++)
      bytes[offset] = ((offset * 17 + client * 79) ^ (offset >>> 8)) & 255;
    return bytes;
  });
  const gates = payloads.map(() => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  });
  t.after(() => gates.forEach(gate => gate.release()));
  const calls = [], blocked = new Set();
  let maxActive = 0;
  const f = fixture(t, async url => {
    const client = Number(new URL(url).pathname.match(/client-(\d)\.whl$/)?.[1]);
    assert.ok(Number.isInteger(client) && client < payloads.length, url);
    calls.push(client);
    maxActive = Math.max(maxActive, f.bridge.status.active);
    let offset = 0, released = false;
    return { status: 200, url, headers: new Headers(), body: { getReader: () => ({
      async read() {
        // Hold every stream after its first browser fragment. All first four
        // consumers own live slots before the fifth process enters the CLI.
        if (offset && !released) {
          blocked.add(client);
          await gates[client].promise;
          released = true;
        }
        if (offset === payloads[client].length) return { done: true };
        await sleep(client % 3);
        const end = Math.min(offset + (offset ? FETCH_LIMITS.chunkBytes + 37 : 257), payloads[client].length);
        const value = payloads[client].subarray(offset, end);
        offset = end;
        return { done: false, value };
      },
      async cancel() { gates[client].release(); },
    }) } };
  });
  const outputs = payloads.map((_, client) => join(f.directory, `client-${client}.whl`));
  const args = client => ['-f', '--max-time', '10', '-o', outputs[client],
    `https://files.pythonhosted.org/packages/client-${client}.whl`];
  const clients = payloads.slice(0, 4).map((_, client) => f.python(args(client)));
  await until(() => blocked.size === 4);
  assert.equal(f.bridge.status.active, 4);

  const fifthStarted = join(f.directory, 'fifth-started');
  // The marker confirms Python has started before testing queue behavior.
  // runpy executes the unchanged kfetch CLI, including its real file locks.
  const launchFifth = `
import pathlib, runpy, sys
sys.argv = ${JSON.stringify([clientPath, ...args(4)])}
pathlib.Path(${JSON.stringify(fifthStarted)}).write_text('ready')
runpy.run_path(sys.argv[0], run_name='__main__')
`;
  let fifthFinished = false;
  clients.push(f.pythonRaw(['-c', launchFifth]).then(result => { fifthFinished = true; return result; }));
  await until(() => existsSync(fifthStarted));
  await sleep(100);
  assert.equal(fifthFinished, false);
  assert.deepEqual([...calls].sort(), [0, 1, 2, 3]);
  assert.equal(f.bridge.status.active, 4);
  assert.ok(outputs.every(output => !existsSync(output)), 'partial streams must not publish output files');

  // Release just one client. The queued fifth must reuse that slot while
  // the other three remain blocked, without seeing their response bytes.
  gates[2].release();
  const released = await clients[2];
  assert.equal(released.code, 0, released.stderr);
  assert.deepEqual(readFileSync(outputs[2]), payloads[2]);
  await until(() => blocked.has(4));
  assert.equal(f.bridge.status.active, 4);
  assert.equal(fifthFinished, false);

  gates.forEach(gate => gate.release());
  const results = await Promise.all(clients);
  for (const [client, result] of results.entries()) {
    assert.equal(result.code, 0, `client ${client}: ${result.stderr}`);
    assert.deepEqual(readFileSync(outputs[client]), payloads[client]);
  }
  await until(() => f.bridge.status.active === 0);
  assert.deepEqual([...calls].sort(), [0, 1, 2, 3, 4]);
  assert.equal(maxActive, 4);
  assert.equal(f.bridge.status.completed, 5);
  assert.equal(f.bridge.status.failed, 0);
  assert.equal(f.bridge.status.bytes, payloads.reduce((total, bytes) => total + bytes.length, 0));
});

test('headers and each bounded chunk require acknowledgement before reading ahead', async t => {
  let reads = 0;
  const payload = new Uint8Array(FETCH_LIMITS.chunkBytes + 9).fill(231);
  const f = fixture(t, async () => ({ status: 200, headers: new Headers({ 'content-encoding': 'gzip', 'content-length': '2' }),
    body: { getReader: () => ({ read: async () => ++reads === 1 ? { value: payload, done: false } : { done: true }, cancel: async () => {} }) } }));
  f.request();
  const header = await until(() => f.frame()?.kind === 'headers' && f.frame());
  assert.deepEqual(header.headers, []);
  await sleep(30);
  assert.equal(reads, 0);
  f.write('ack', `${f.token}:0`);
  const chunk = await until(() => f.frame()?.kind === 'chunk' && f.frame());
  assert.equal(chunk.size, FETCH_LIMITS.chunkBytes);
  await sleep(30);
  assert.equal(reads, 1);
  assert.equal(f.frame().seq, 1);
  f.write('ack', `${f.token}:1`);
  await until(() => f.frame()?.seq === 2);
  assert.equal(f.frame().size, 9);
  f.write('ack', `${f.token}:2`);
  await until(() => f.frame()?.kind === 'done');
  assert.equal(reads, 2);
});

test('small browser fragments coalesce into bounded binary chunks without reading past an unacknowledged chunk', async t => {
  const fragmentBytes = 23017;
  const payload = Buffer.alloc(FETCH_LIMITS.chunkBytes * 3 + 317);
  for (let i = 0; i < payload.length; i++) payload[i] = ((i * 37) ^ (i >>> 8)) & 255;
  let offset = 0, reads = 0;
  const f = fixture(t, async () => ({ status: 200, headers: new Headers(), body: {
    getReader: () => ({
      read: async () => {
        reads++;
        if (offset === payload.length) return { done: true };
        const end = Math.min(offset + fragmentBytes, payload.length);
        const value = payload.subarray(offset, end);
        offset = end;
        return { done: false, value };
      },
      cancel: async () => {},
    }),
  } }));
  f.request();
  await until(() => f.frame()?.kind === 'headers');
  assert.equal(reads, 0);
  f.write('ack', `${f.token}:0`);
  await until(() => f.frame()?.kind === 'chunk');
  assert.equal(f.frame().size, FETCH_LIMITS.chunkBytes);
  assert.equal(reads, Math.ceil(FETCH_LIMITS.chunkBytes / fragmentBytes));
  const firstReads = reads;
  await sleep(30);
  assert.equal(reads, firstReads, 'a full unacknowledged chunk stops upstream reads');
  const chunks = [];
  for (let seq = 1; seq <= 4; seq++) {
    const frame = await until(() => f.frame()?.seq === seq && f.frame());
    assert.equal(frame.kind, 'chunk');
    assert.equal(frame.size, seq === 4 ? 317 : FETCH_LIMITS.chunkBytes);
    chunks.push(readFileSync(f.path('chunk')));
    f.write('ack', `${f.token}:${seq}`);
  }
  const done = await until(() => f.frame()?.kind === 'done' && f.frame());
  assert.equal(done.seq, 5, 'many browser reads require only four guest chunk ACKs');
  assert.deepEqual(Buffer.concat(chunks), payload);
  assert.equal(reads, Math.ceil(payload.length / fragmentBytes) + 1);
  assert.equal(f.bridge.status.bytes, payload.length);
});

test('a mid-stream failure leaves an existing output intact and returns nonzero', async t => {
  let reads = 0;
  const f = fixture(t, async () => ({ status: 200, headers: new Headers(),
    body: { getReader: () => ({ read: async () => {
      if (++reads === 1) return { value: new Uint8Array(FETCH_LIMITS.chunkBytes + 3).fill(128), done: false };
      throw new Error('connection lost');
    }, cancel: async () => {} }) } }));
  const output = join(f.directory, 'result.whl');
  writeFileSync(output, 'previous good file');
  const result = await f.python(['-o', output, 'https://files.pythonhosted.org/packages/example.whl']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /connection lost/);
  assert.equal(readFileSync(output, 'utf8'), 'previous good file');
});

test('disallowed origins, userinfo, methods and credential headers never call fetch', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return new Response('no'); });
  const cases = [{ url: 'http://pypi.org/simple/' }, { url: 'https://127.0.0.1/' },
    { url: 'https://api.karkhana.internal/v1/' }, { url: 'https://pypi.org.evil.example/' },
    { url: 'https://user:pass@pypi.org/simple/' }, { url: 'https://@pypi.org/simple/' },
    { method: 'POST' }, { headers: [['Authorization', 'secret']] }];
  for (let i = 0; i < cases.length; i++) {
    const requestId = i.toString(16).padStart(32, '0');
    f.request(cases[i], requestId);
    const frame = await until(() => f.frame()?.id === requestId && f.frame()?.kind === 'error' && f.frame());
    assert.match(frame.error, /supported|header/);
    assert.equal(frame.code, 'blocked');
  }
  assert.equal(calls, 0);
});

test('stale generation markers cannot start a request', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return new Response('no'); });
  f.request();
  f.write('request-ready', `old-generation:${id}`);
  await sleep(150);
  assert.equal(calls, 0);
  assert.equal(f.frame(), null);
});

test('reusing a cancelled slot cannot publish the previous request response', async t => {
  let firstResolve, calls = 0;
  const f = fixture(t, async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { firstResolve = resolve; });
    return new Response('new request');
  });
  f.request();
  await until(() => firstResolve);
  const replacement = 'b'.repeat(32);
  f.write('cancel', f.token);
  f.request({}, replacement);
  // Simulate fetch completing after its signal was aborted.
  firstResolve(new Response('stale secret bytes'));
  await until(() => f.frame()?.id === replacement);
  assert.equal(f.frame().kind, 'headers');
  assert.equal(f.bridge.status.active, 1);
  f.write('ack', `${f.generation}:${replacement}:0`);
  await until(() => f.frame()?.kind === 'chunk');
  assert.equal(readFileSync(f.path('chunk'), 'utf8'), 'new request');
});

test('oversized requests fail without a fetch or unbounded read', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return new Response('no'); });
  f.write('request', 'x'.repeat(FETCH_LIMITS.requestBytes + 1));
  f.write('request-ready', f.token);
  await until(() => f.frame()?.kind === 'error');
  assert.match(f.frame().error, /size limit/);
  assert.equal(calls, 0);
});

test('a stalled consumer gets an explicit timeout on the sequence it awaits', async t => {
  const f = fixture(t, async () => new Response('body'));
  f.request({ timeoutMs: 1000 });
  await until(() => f.frame()?.kind === 'headers');
  await until(() => f.frame()?.kind === 'error');
  assert.equal(f.frame().seq, 0);
  assert.match(f.frame().error, /timed out/);
  assert.equal(f.frame().code, 'timeout');
});

test('HEAD returns response headers without reading response bytes', async t => {
  let read = false;
  const f = fixture(t, async () => ({ status: 200, headers: new Headers({ etag: 'test' }),
    body: { getReader: () => { read = true; throw new Error('unexpected read'); } } }));
  const result = await f.python(['-I', 'https://pypi.org/simple/example/']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.toString(), /etag: test/);
  assert.equal(read, false);
});

test('HTTP errors stay HTTP errors and --fail does not create a result file', async t => {
  const f = fixture(t, async () => new Response('missing', { status: 404 }));
  const output = join(f.directory, 'missing.whl');
  const result = await f.python(['-f', '-o', output, 'https://pypi.org/simple/missing/']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 404/);
  assert.equal(existsSync(output), false);
});

test('actual loopback adapter, Python client and JS transport preserve index hashes and wheel bytes', async t => {
  const wheel = Buffer.from([0, 1, 0, 255, 128, 13, 10, 226]);
  const upstream = 'https://files.pythonhosted.org/packages/a/demo-1.0-py3-none-any.whl';
  const calls = [];
  const f = fixture(t, async (url, options) => {
    calls.push(url);
    if (url === 'https://pypi.org/simple/demo/') {
      assert.equal(options.headers.get('Accept'), 'application/vnd.pypi.simple.v1+json');
      return Response.json({ meta: { 'api-version': '1.0' }, name: 'demo', files: [{
        filename: 'demo-1.0-py3-none-any.whl', url: upstream + '#sha256=abc',
        hashes: { sha256: 'abc' }, 'requires-python': '>=3.8', yanked: false,
      }] });
    }
    assert.equal(url, upstream);
    return new Response(wheel);
  });
  const script = `
import sys, threading, http.client, json, base64
from urllib.parse import urlsplit
sys.path.insert(0, ${JSON.stringify(new URL('./guest/', import.meta.url).pathname)})
from kpip_fast import PackageIndex, IndexServer
from kfetch import fetch
with IndexServer(PackageIndex(fetch)) as server:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
        connection.request('GET', '/simple/demo/', headers={'Accept': 'application/vnd.pypi.simple.v1+json'})
        response = connection.getresponse()
        assert response.status == 200, response.read()
        document = json.loads(response.read())
        connection.close()
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
        connection.request('GET', urlsplit(document['files'][0]['url']).path)
        response = connection.getresponse()
        assert response.status == 200, response.read()
        data = response.read()
        connection.close()
        print(json.dumps({'document': document, 'body': base64.b64encode(data).decode()}))
    finally:
        server.shutdown()
        thread.join()
        server.index.close(server.base_url)
`;
  const result = await f.pythonRaw(['-c', script]);
  assert.equal(result.code, 0, result.stderr);
  const received = JSON.parse(result.stdout);
  assert.deepEqual(Buffer.from(received.body, 'base64'), wheel);
  assert.equal(received.document.files[0].hashes.sha256, 'abc');
  assert.match(received.document.files[0].url, /#sha256=abc$/);
  assert.deepEqual(calls, ['https://pypi.org/simple/demo/', upstream]);
  assert.equal(f.bridge.status.pypi.sessions, 0);
  assert.equal(f.bridge.status.pypi.cacheBytes, 0);
});

test('large encoded projects cross multiple mailbox chunks and browser retries share cached bytes', async t => {
  let requests = 0;
  const f = fixture(t, async url => {
    assert.equal(url, 'https://pypi.org/simple/metadata-fixture/');
    requests++;
    return Response.json(syntheticProject(600));
  });
  const script = `
import sys, threading, http.client, json
sys.path.insert(0, ${JSON.stringify(new URL('./guest/', import.meta.url).pathname)})
from kpip_fast import PackageIndex, IndexServer
from kfetch import fetch
with IndexServer(PackageIndex(fetch)) as server:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        replies = []
        for _ in range(2):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
            connection.request('GET', '/simple/metadata-fixture/', headers={'Accept': 'application/vnd.pypi.simple.v1+json'})
            response = connection.getresponse()
            assert response.status == 200, response.read()
            assert response.getheader('Transfer-Encoding') == 'chunked'
            replies.append(response.read())
            connection.close()
        assert replies[0] == replies[1]
        document = json.loads(replies[0])
        assert len(document['files']) == 600
        assert all(entry['url'].startswith(server.base_url + '/files/') for entry in document['files'])
        print(len(replies[0]))
    finally:
        server.shutdown()
        thread.join()
        server.index.close(server.base_url)
`;
  const result = await f.pythonRaw(['-c', script]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Number(result.stdout) > FETCH_LIMITS.chunkBytes);
  assert.equal(requests, 1);
  assert.equal(f.bridge.status.pypi.projects, 1);
  assert.equal(f.bridge.status.pypi.cacheHits, 1);
  assert.equal(f.bridge.status.pypi.sessions, 0);
});


test('a body read that ignores abort still releases the slot on its total deadline', async t => {
  let cancelled = 0;
  const f = fixture(t, async () => ({ status: 200, headers: new Headers(), body: {
    getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => { cancelled++; } }),
  } }));
  f.request({ timeoutMs: 1000 });
  await until(() => f.frame()?.kind === 'headers');
  f.write('ack', `${f.token}:0`);
  await until(() => f.frame()?.kind === 'error', 2500);
  assert.equal(f.frame().code, 'timeout');
  await until(() => f.bridge.status.active === 0);
  assert.equal(cancelled, 1);
});

test('stop/restart retires files and rejects stale ownership without changing the new config', async t => {
  const f = fixture(t, async () => new Response('new'));
  const initial = JSON.parse(readFileSync(join(f.root, 'config.json')));
  f.bridge.start();
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'config.json'))), initial);
  const competing = createBrowserFetchBridge(f.FS, { root: f.root });
  t.after(() => competing.stop());
  assert.throws(() => competing.start(), /owner/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'config.json'))), initial);
  f.bridge.stop();
  assert.equal(existsSync(join(f.root, initial.generation)), false);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'config.json'))).available, false);
  f.bridge.start();
  const next = JSON.parse(readFileSync(join(f.root, 'config.json')));
  assert.notEqual(next.generation, initial.generation);
  assert.equal(next.protocol, 2);
  assert.equal(next.available, true);
  const result = await f.python(['https://pypi.org/simple/demo/']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.toString(), 'new');
  f.bridge.stop();
  competing.start();
  const successor = readFileSync(join(f.root, 'config.json'), 'utf8');
  f.bridge.stop();
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), successor);
  competing.stop();
  assert.deepEqual(readdirSync(f.root).sort(), ['bin', 'config.json']);
});


test('redirect responses fail explicitly while conditional 304 remains supported', async t => {
  const f = fixture(t, async url => url.includes('unchanged')
    ? new Response(null, { status: 304, headers: { etag: 'same' } })
    : new Response('redirect body', { status: 302, headers: { location: 'https://example.invalid/' } }));
  const redirected = await f.python(['https://pypi.org/simple/redirect/']);
  assert.equal(redirected.code, 1);
  assert.match(redirected.stderr, /redirect/);
  assert.equal(redirected.stdout.length, 0);
  const unchanged = await f.python(['-I', 'https://pypi.org/simple/unchanged/']);
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.match(unchanged.stdout.toString(), /HTTP 304/);
  assert.equal(f.bridge.status.active, 0);
});


test('equivalent root paths share ownership', async t => {
  const f = fixture(t, async () => new Response('owned'));
  const before = readFileSync(join(f.root, 'config.json'), 'utf8');
  const competing = createBrowserFetchBridge(f.FS, { root: f.root + '/./' });
  t.after(() => competing.stop());
  assert.throws(() => competing.start(), /owner/);
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), before);
});

test('cancelled PyPI wheel fetches do not prevent idle session expiry', async t => {
  let clock = 1000, fileStarted = false;
  const wheelUrl = 'https://files.pythonhosted.org/packages/a/demo-1.0-py3-none-any.whl';
  const f = fixture(t, async url => {
    if (url.startsWith('https://pypi.org/simple/')) return Response.json({ name: 'demo', files: [{
      filename: 'demo-1.0-py3-none-any.whl', url: wheelUrl, hashes: {sha256: 'a'.repeat(64)},
    }] });
    fileStarted = true;
    return new Promise(() => {});
  }, { now: () => clock });
  const session = 'c'.repeat(32), baseUrl = 'http://127.0.0.1:12345';
  const guest = `
import sys
sys.path.insert(0, ${JSON.stringify(new URL('./guest/', import.meta.url).pathname)})
from kfetch import fetch, BridgeError
session = {"session": "${session}", "baseUrl": "${baseUrl}"}
with fetch('https://pypi.org/simple/demo/', timeout=3, pypi={**session, 'operation':'project', 'project':'demo', 'format':'json'}) as response:
    assert b'demo' in b''.join(response.iter_chunks())
try:
    with fetch('${wheelUrl}', timeout=1, pypi={**session, 'operation':'file', 'path':'/files/packages/a/demo-1.0-py3-none-any.whl'}) as response:
        b''.join(response.iter_chunks())
except BridgeError as error:
    assert error.code == 'timeout', error
else:
    raise AssertionError('stalled file must time out')
`;
  const result = await f.pythonRaw(['-c', guest]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fileStarted, true);
  await until(() => f.bridge.status.active === 0);
  clock += 24 * 60 * 60 * 1000;
  assert.equal(f.bridge.status.pypi.sessions, 0);
  assert.equal(f.bridge.status.pypi.wheels, 0);
  assert.equal(f.bridge.status.pypi.cacheBytes, 0);
});


test('symlinked root aliases share ownership', async t => {
  const f = fixture(t, async () => new Response('owned'));
  const alias = join(f.directory, 'alias');
  symlinkSync(f.root, alias);
  const competing = createBrowserFetchBridge(f.FS, { root: alias });
  t.after(() => competing.stop());
  const before = readFileSync(join(f.root, 'config.json'), 'utf8');
  assert.throws(() => competing.start(), /owner/);
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), before);
});

test('cancelling unacknowledged headers cancels the unopened response body once', async t => {
  let cancelled = 0;
  const f = fixture(t, async () => ({ status: 200, headers: new Headers(), body: {
    cancel: async () => { cancelled++; },
    getReader: () => { throw new Error('headers have not been acknowledged'); },
  } }));
  f.request();
  await until(() => f.frame()?.kind === 'headers');
  f.write('cancel', f.token);
  await until(() => f.bridge.status.active === 0);
  assert.equal(cancelled, 1);
});

test('knpm gets an npm tree bundle through the mailbox and serves documents and tarballs from loopback', async t => {
  const tarball = Buffer.from([31, 139, 8, 0, 255, 0, 1, 2, 3]);
  const corgi = (name, deps = {}) => ({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0',
    dependencies: deps, dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-1.0.0.tgz` } } } });
  const docs = { demo: corgi('demo', { '@s/dep': '^1' }), '@s/dep': corgi('@s/dep') };
  const calls = [];
  const f = fixture(t, async (url, options) => {
    calls.push(url);
    const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length));
    if (docs[name]) {
      assert.match(new Headers(options.headers).get('accept'), /^application\/vnd\.npm\.install-v1\+json/);
      return Response.json(docs[name]);
    }
    assert.equal(url, 'https://registry.npmjs.org/@s/dep/-/dep-1.0.0.tgz');
    return new Response(tarball);
  });
  const script = `
import sys, threading, http.client, json, base64
sys.path.insert(0, ${JSON.stringify(new URL('./guest/', import.meta.url).pathname)})
from knpm import Registry, Server, REGISTRY
from kfetch import fetch
with fetch(REGISTRY + '/', [], 'GET', 30, npm={'specs': ['demo']}) as response:
    bundle = json.loads(b''.join(response.iter_chunks()))
server = Server(Registry(fetch, bundle))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    def get(path):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=10)
        connection.request('GET', path)
        response = connection.getresponse()
        return response.status, response.read()
    status, dep = get('/@s%2fdep')
    assert status == 200, dep
    url = json.loads(dep)['versions']['1.0.0']['dist']['tarball']
    status, data = get(url.split(str(server.server_address[1]), 1)[1])
    assert status == 200, data
    print(json.dumps({'packages': bundle['packages'], 'tarball': url, 'body': base64.b64encode(data).decode(), 'stats': server.registry.stats}))
finally:
    server.shutdown()
`;
  const result = await f.pythonRaw(['-c', script]);
  assert.equal(result.code, 0, result.stderr);
  const received = JSON.parse(result.stdout);
  assert.equal(received.packages, 2);
  assert.match(received.tarball, /^http:\/\/127\.0\.0\.1:\d+\/-\/t\/@s\/dep\/-\/dep-1\.0\.0\.tgz$/);
  assert.deepEqual(Buffer.from(received.body, 'base64'), tarball);
  assert.deepEqual(received.stats, { bundled: 1, fetched: 0, tarballs: 1, missing: 0 });
  assert.deepEqual(calls.sort(), ['https://registry.npmjs.org/@s%2fdep', 'https://registry.npmjs.org/@s/dep/-/dep-1.0.0.tgz', 'https://registry.npmjs.org/demo'].sort());
});
