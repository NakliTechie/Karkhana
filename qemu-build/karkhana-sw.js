// Karkhana service worker — storage ladder + host independence.
// 1) Cache-first for the big immutable artifacts (.wasm/.data/.gzip): the 550MB+
//    guest bundle downloads once and then loads from Cache Storage (LocalMind
//    model-caching pattern).
// 2) COOP/COEP headers on every response (coi-serviceworker pattern): SharedArrayBuffer
//    works on static hosts that can't set headers (GitHub Pages, R2, etc.).
const CACHE = 'karkhana-engine-v1';
const BIG = /\.(wasm|data|gzip)$/;

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
