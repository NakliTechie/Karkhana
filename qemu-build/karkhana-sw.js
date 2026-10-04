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
// The guest's agent sends "model": $KARKHANA_MODEL, which defaults to "default";
// a validating provider (Ollama, OpenRouter) rejects that name with 404. The
// panel's model fills in on chat-completions requests. An explicit guest choice
// (KARKHANA_MODEL set) is forwarded as sent.
const CHAT_PATH = /\/chat\/completions$/;
const DEFAULT_MODEL = 'default';

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

// Returns the raw bytes untouched, or a JSON string with cfg.model substituted.
const withConfiguredModel = async (request, url, cfg) => {
  const raw = await request.arrayBuffer();
  if (!cfg.model || request.method !== 'POST' || !CHAT_PATH.test(url.pathname)) return raw;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch (e) { return raw; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return raw;
  if (payload.model && payload.model !== DEFAULT_MODEL) return raw;
  return JSON.stringify({ ...payload, model: cfg.model });
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
  // The guest holds only a placeholder key (KARKHANA_KEY_PLACEHOLDER in its env).
  // Anthropic-protocol clients send it as x-api-key, everyone else as a bearer
  // token; the real key replaces it in the same header and enters no other.
  if (cfg.key && headers.has('x-api-key')) headers.set('x-api-key', cfg.key);
  else if (cfg.key) headers.set('Authorization', 'Bearer ' + cfg.key);
  // Anthropic refuses browser-originated calls without this opt-in header.
  if (/(^|\.)anthropic\.com$/.test(new URL(target).hostname)) headers.set('anthropic-dangerous-direct-browser-access', 'true');
  const body = (request.method === 'GET' || request.method === 'HEAD') ? undefined
    : await withConfiguredModel(request, url, cfg);
  if (typeof body === 'string') headers.delete('content-length'); // rewritten; fetch recomputes it
  try {
    return await fetch(target, { method: request.method, headers, body });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'karkhana bridge fetch failed: ' + err.message }),
                        { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
};

self.addEventListener('install', (e) => self.skipWaiting());
// Every publish renames CACHE (publish.sh stamps the engine id), so the previous
// engine's cache is dead weight: ~600 MB per superseded engine per visitor.
// Drop every karkhana-engine-* cache that is not this one.
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys())
    if (k.startsWith('karkhana-engine-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

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
    // Everything that is not the engine is small and unversioned, and Cloudflare
    // Pages serves it with max-age=14400 that a _headers rule cannot override —
    // so a returning visitor ran a stale dist/stack.js for up to four hours with
    // nothing to invalidate it. Revalidating here is the invalidation: 'no-cache'
    // forces a conditional request, which is a 304 whenever nothing changed.
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .catch(() => fetch(e.request))   // some request modes reject the option
        .then(withCoi)
    );
  }
});
