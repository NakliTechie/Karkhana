// Host-only check of the BYOK bridge: the model configured in the settings panel
// must reach the endpoint. Runs the service worker's real fetch handler in a vm
// context with a fake IndexedDB and a mock fetch; no browser, no QEMU.
// Run: node qemu-build/test-agent-bridge.mjs
// KARKHANA_SW_SOURCE can point at another worker copy for regression checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(process.env.KARKHANA_SW_SOURCE || new URL('./karkhana-sw.js', import.meta.url), 'utf8');
const published = readFileSync(new URL('../karkhana-sw.js', import.meta.url), 'utf8');
const agentSource = readFileSync(new URL('./guest/agent.py', import.meta.url), 'utf8');
const AI = 'http://api.karkhana.internal';
const decode = (body) => typeof body === 'string' ? body : new TextDecoder().decode(body);

// The guest's sentinel model name, read from the agent source so this test
// cannot drift from what /usr/bin/agent actually sends.
const guestDefault = /MODEL = os\.environ\.get\("KARKHANA_MODEL", "([^"]+)"\)/.exec(agentSource);
assert.ok(guestDefault, 'agent.py must read KARKHANA_MODEL with a default');
assert.match(agentSource, /payload = \{"model": MODEL, "messages": messages\}/, 'agent.py payload shape changed');
const DEFAULT = guestDefault[1];

function fakeIndexedDB(cfg) {
  const store = {
    get(key) {
      const req = {};
      queueMicrotask(() => { req.result = key === 'ai-agent' ? cfg : undefined; req.onsuccess?.(); });
      return req;
    },
  };
  return { open() {
    const open = { result: { transaction: () => ({ objectStore: () => store }) } };
    queueMicrotask(() => open.onsuccess?.());
    return open;
  } };
}

// Load the worker script and return a function that dispatches one FetchEvent.
function worker(cfg, fetchImpl) {
  const listeners = {};
  const context = vm.createContext({
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {},
      clients: { matchAll: async () => [], claim: async () => {} } },
    indexedDB: fakeIndexedDB(cfg), fetch: fetchImpl,
    Response, Headers, Request, URL, TextDecoder, MessageChannel, setTimeout, console,
    caches: {}, location: new URL('https://karkhana.example/'),
  });
  vm.runInContext(source, context, { filename: 'karkhana-sw.js' });
  assert.equal(typeof listeners.fetch, 'function', 'worker must register a fetch listener');
  return (request) => {
    let response;
    listeners.fetch({ request, respondWith: (p) => { response = p; }, waitUntil() {} });
    assert.ok(response, 'bridge host must be answered by the worker');
    return response;
  };
}

function recorder(status = 200) {
  const calls = [];
  const fetchImpl = async (target, init) => {
    calls.push({ target, init, body: init.body === undefined ? undefined : decode(init.body) });
    return new Response(JSON.stringify({ id: 'upstream', choices: [] }), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const chat = (payload, path = '/v1/chat/completions') => new Request(AI + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});
const guestPayload = (model = DEFAULT) => ({
  model, messages: [{ role: 'user', content: 'list the cwd' }],
  tools: [{ type: 'function', function: { name: 'run_command', parameters: { type: 'object' } } }],
});

test('configured model replaces the guest default on chat completions', async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ endpoint: 'http://127.0.0.1:11434/', model: 'qwen3.5:4b' }, fetchImpl);
  const response = await dispatch(chat(guestPayload()));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.model, 'qwen3.5:4b');
  assert.deepEqual(sent, { ...guestPayload(), model: 'qwen3.5:4b' });
  assert.equal(calls[0].init.headers.get('authorization'), null);
  assert.equal(calls[0].init.headers.get('content-type'), 'application/json');
  assert.equal(calls[0].init.headers.get('content-length'), null);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'upstream', choices: [] });
});

test('an explicit guest model is forwarded as sent', async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ endpoint: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' }, fetchImpl);
  await dispatch(chat(guestPayload('llama3.1:8b')));
  assert.equal(JSON.parse(calls[0].body).model, 'llama3.1:8b');
});

test('a missing model field receives the configured model', async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ endpoint: 'https://openrouter.ai/api', model: 'deepseek/deepseek-chat' }, fetchImpl);
  const { model, ...noModel } = guestPayload();
  await dispatch(chat(noModel));
  assert.deepEqual(JSON.parse(calls[0].body), { ...noModel, model: 'deepseek/deepseek-chat' });
});

test('no configured model leaves the body byte-identical', async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ endpoint: 'http://127.0.0.1:11434', model: '' }, fetchImpl);
  const raw = JSON.stringify(guestPayload());
  await dispatch(chat(raw));
  assert.notEqual(typeof calls[0].init.body, 'string');
  assert.equal(calls[0].body, raw);
});

test('other paths and non-JSON bodies pass through unchanged', async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ endpoint: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' }, fetchImpl);
  const embeddings = JSON.stringify({ model: DEFAULT, input: 'x' });
  await dispatch(chat(embeddings, '/v1/embeddings'));
  assert.equal(calls[0].target, 'http://127.0.0.1:11434/v1/embeddings');
  assert.equal(calls[0].body, embeddings);
  await dispatch(chat('not json at all'));
  assert.equal(calls[1].body, 'not json at all');
  await dispatch(chat('[1,2,3]'));
  assert.equal(calls[2].body, '[1,2,3]');
  await dispatch(new Request(AI + '/v1/models?x=1', { method: 'GET' }));
  assert.equal(calls[3].target, 'http://127.0.0.1:11434/v1/models?x=1');
  assert.equal(calls[3].init.body, undefined);
});

test('the key becomes the Authorization header and never enters the body', async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ endpoint: 'https://openrouter.ai/api', model: 'deepseek/deepseek-chat', key: 'sk-test-123' }, fetchImpl);
  await dispatch(chat(guestPayload()));
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer sk-test-123');
  assert.equal(calls[0].init.headers.get('host'), null);
  assert.ok(!calls[0].body.includes('sk-test-123'));
});

test("the guest's placeholder bearer token is replaced, never forwarded", async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ endpoint: 'http://127.0.0.1:8899', model: 'everyday', key: 'frl_test' }, fetchImpl);
  const request = chat(guestPayload());
  request.headers.set('Authorization', 'Bearer karkhana-bridge');
  await dispatch(request);
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer frl_test');
  assert.equal(calls[0].init.headers.get('x-api-key'), null);
});

test('an Anthropic-protocol call gets the key as x-api-key, and only there', async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ endpoint: 'https://api.anthropic.com', key: 'sk-ant-test' }, fetchImpl);
  await dispatch(new Request(AI + '/v1/messages', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'karkhana-bridge', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [] }) }));
  assert.equal(calls[0].target, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers.get('x-api-key'), 'sk-ant-test');
  assert.equal(calls[0].init.headers.get('authorization'), null);
  assert.equal(calls[0].init.headers.get('anthropic-dangerous-direct-browser-access'), 'true');
  assert.equal(JSON.parse(calls[0].body).model, 'claude-sonnet-5', 'messages bodies are not rewritten');
});

test('the Anthropic browser opt-in goes to anthropic.com only', async () => {
  const { calls, fetchImpl } = recorder();
  await worker({ endpoint: 'https://openrouter.ai/api', key: 'k' }, fetchImpl)(chat(guestPayload()));
  assert.equal(calls[0].init.headers.get('anthropic-dangerous-direct-browser-access'), null);
});

test('with no key configured, the placeholder passes through for keyless runtimes', async () => {
  const { calls, fetchImpl } = recorder();
  const request = chat(guestPayload());
  request.headers.set('Authorization', 'Bearer karkhana-bridge');
  await worker({ endpoint: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' }, fetchImpl)(request);
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer karkhana-bridge');
});

test('a missing endpoint answers 503 without an upstream call', async () => {
  const { calls, fetchImpl } = recorder();
  const dispatch = worker({ model: 'qwen3.5:4b' }, fetchImpl);
  const response = await dispatch(chat(guestPayload()));
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
  assert.match((await response.json()).error, /no agent endpoint configured/);
});

test('an upstream failure answers 502 with the bridge error', async () => {
  const dispatch = worker({ endpoint: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' },
    async () => { throw new Error('ECONNREFUSED'); });
  const response = await dispatch(chat(guestPayload()));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /ECONNREFUSED/);
});

test('the published worker matches the source except for the cache stamp', () => {
  const stamp = /karkhana-engine-[0-9a-z]+'/g;
  assert.equal(published.replace(stamp, "karkhana-engine-X'"), source.replace(stamp, "karkhana-engine-X'"));
});
