// Karkhana service worker — storage ladder + host independence.
// 1) Cache-first for the big immutable artifacts (.wasm/.data/.gzip): the 550MB+
//    guest bundle downloads once and then loads from Cache Storage (LocalMind
//    model-caching pattern).
// 2) COOP/COEP headers on every response (coi-serviceworker pattern): SharedArrayBuffer
//    works on static hosts that can't set headers (GitHub Pages, R2, etc.).
const CACHE = 'karkhana-engine-v1';
const BIG = /\.(wasm|data|gzip)$/;

// 3) BYOK agent bridge: the guest's agent talks to http(s)://api.karkhana.internal;
//    the network proxy's outbound fetch lands here, and we rewrite it to the
//    user's configured endpoint + inject the Authorization header. The key lives
//    in browser-side IndexedDB and never enters the VM.
const AI_HOST = 'api.karkhana.internal';

const idbGet = (key) => new Promise((resolve) => {
  const open = indexedDB.open('karkhana', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => resolve(null);
  open.onsuccess = () => {
    const tx = open.result.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  };
});

// GP tier from inside the guest: endpoint 'builtin:nano' relays the prompt to a
// window client, which asks on-device Gemini Nano and replies over a MessageChannel.
const nanoViaClient = async (request) => {
  let prompt = '';
  try {
    const body = await request.json();
    prompt = (body.messages || []).map((m) => (m.role === 'system' ? '[instructions] ' : '') + m.content).join('\n');
  } catch (e) { prompt = 'Say: send JSON {messages:[...]} to this endpoint.'; }
  const clientsList = await self.clients.matchAll({ type: 'window' });
  if (!clientsList.length) return new Response(JSON.stringify({ error: 'karkhana: no page open for nano' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  const ch = new MessageChannel();
  const reply = new Promise((resolve) => {
    ch.port1.onmessage = (e) => resolve(e.data);
    setTimeout(() => resolve({ ok: false, error: 'nano timeout (120s)' }), 120000);
  });
  clientsList[0].postMessage({ type: 'karkhana-nano', prompt }, [ch.port2]);
  const res = await reply;
  if (!res.ok) return new Response(JSON.stringify({ error: res.error }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({
    id: 'karkhana-nano', object: 'chat.completion', model: 'gemini-nano-on-device',
    choices: [{ index: 0, message: { role: 'assistant', content: res.answer }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const bridgeAi = async (request) => {
  const cfg = await idbGet('ai-agent');
  if (!cfg || !cfg.endpoint) {
    return new Response(JSON.stringify({ error: 'karkhana: no agent endpoint configured (Settings -> Agent AI)' }),
                        { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  if (cfg.endpoint === 'builtin:nano') return nanoViaClient(request);
  const url = new URL(request.url);
  const target = cfg.endpoint.replace(/\/$/, '') + url.pathname + url.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  if (cfg.key) headers.set('Authorization', 'Bearer ' + cfg.key);
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : await request.arrayBuffer(),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'karkhana bridge fetch failed: ' + err.message }),
                        { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
};

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  if (e.data === 'karkhana-clear-cache') e.waitUntil(caches.delete(CACHE));
});

const withCoi = (resp) => {
  if (resp.status === 0) return resp; // opaque
  const headers = new Headers(resp.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
};

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.hostname === AI_HOST) { e.respondWith(bridgeAi(e.request)); return; }
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (BIG.test(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(e.request);
      if (hit) return withCoi(hit);
      const resp = await fetch(e.request);
      // waitUntil keeps the worker alive while the (large) clone streams to cache
      if (resp.ok) e.waitUntil(cache.put(e.request, resp.clone()).catch((err) => console.warn('cache.put failed', err)));
      return withCoi(resp);
    })());
  } else {
    e.respondWith(fetch(e.request).then(withCoi));
  }
});
