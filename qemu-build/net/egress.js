// Egress: reach hosts that send no CORS headers (Debian mirrors, rustup, Go
// downloads, the crates index, GitHub release assets) through the user's own
// relay Worker. The Worker is naklios's nakli-egress, deployed on the user's
// Cloudflare account; Karkhana never relays anyone's traffic.
//
// The in-page network stack (stack.js) asks routes(url) for each guest request.
// Listed hosts go through the Worker as a signed envelope; everything else keeps
// the direct browser fetch. Protocol: nakli-egress/src/lib.js (canonicalString,
// verifyEnvelope). The Worker enforces its own allowlist and SSRF guard; this
// list only decides what is sent there.

// The Worker refuses responses over 50 MB, so large GETs are fetched in ranges.
export const RANGE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding',
  'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer']);
const NULL_BODY = new Set([101, 204, 205, 304]);

export const DEFAULT_EGRESS_HOSTS = [
  'deb.debian.org', 'security.debian.org',
  'static.rust-lang.org', 'index.crates.io',
  'dl.google.com', 'go.dev',
  'github.com', 'codeload.github.com', '*.githubusercontent.com',
];

const enc = new TextEncoder();
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

// Byte-for-byte nakli-egress's canonicalHeaders/canonicalString.
export function canonicalString({ method, url, headers, bodySha256, nonce, ts }) {
  const h = Object.entries(headers || {})
    .map(([k, v]) => [String(k).toLowerCase(), String(v)])
    .filter(([k]) => !HOP_BY_HOP.has(k))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}:${v}`).join('\n');
  return [String(method || 'GET').toUpperCase(), String(url || ''), h,
    String(bodySha256 || ''), String(nonce || ''), String(ts || '')].join('\n');
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))));
}

const sha256Hex = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// Exact host, or '*.base' for base and its subdomains; http(s) only.
export function hostListed(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return hosts.some((raw) => {
    const rule = String(raw).toLowerCase().trim();
    if (rule.startsWith('*.')) return host === rule.slice(2) || host.endsWith(rule.slice(1));
    return rule !== '' && host === rule;
  });
}

const parseRange = (value) => {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || '');
  return m ? { start: +m[1], end: +m[2], total: +m[3] } : null;
};

export function createEgress({ workerUrl, secret, hosts = DEFAULT_EGRESS_HOSTS, fetchImpl = (...a) => fetch(...a) }) {
  if (!workerUrl || !secret) throw new Error('egress needs a Worker URL and its secret');
  const stats = { requests: 0, bytes: 0, failed: 0 };

  // One signed round trip; resolves to { status, statusText, headers, body }.
  async function relay(url, method, headers, body) {
    const bytes = body ? new Uint8Array(body) : new Uint8Array(0);
    const nonce = 'k' + crypto.getRandomValues(new Uint32Array(2)).join('') + Date.now().toString(36);
    const ts = Date.now();
    const bodySha256 = bytes.length ? await sha256Hex(bytes) : '';
    const sig = await hmacHex(secret, canonicalString({ method, url, headers, bodySha256, nonce, ts }));
    const response = await fetchImpl(workerUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify({ url, method, headers, body: bytes.length ? toB64(bytes) : null, nonce, ts, sig }),
    });
    const reply = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!reply.ok) throw new TypeError(`egress: ${reply.error || 'relay failed'}`);
    return { ...reply, body: reply.body ? fromB64(reply.body) : new Uint8Array(0) };
  }

  // A GET without its own Range is fetched in RANGE_BYTES pieces, then
  // reassembled as the 200 the guest asked for.
  async function relayGet(url, headers) {
    if (Object.keys(headers).some((k) => k.toLowerCase() === 'range')) return relay(url, 'GET', headers);
    const first = await relay(url, 'GET', { ...headers, Range: `bytes=0-${RANGE_BYTES - 1}` });
    const range = first.status === 206 && parseRange(first.headers['content-range'] ?? first.headers['Content-Range']);
    if (first.status === 416) return relay(url, 'GET', headers);
    if (!range) return first;
    const parts = [first.body];
    for (let at = range.end + 1; at < range.total; at += RANGE_BYTES) {
      const end = Math.min(at + RANGE_BYTES, range.total) - 1;
      const part = await relay(url, 'GET', { ...headers, Range: `bytes=${at}-${end}` });
      if (part.status !== 206 || part.body.length !== end - at + 1) throw new TypeError(`egress: range ${at}-${end} of ${url} failed`);
      parts.push(part.body);
    }
    const body = new Uint8Array(range.total);
    let off = 0;
    for (const p of parts) { body.set(p, off); off += p.length; }
    const out = { ...first.headers };
    for (const k of Object.keys(out)) if (['content-range', 'content-length'].includes(k.toLowerCase())) delete out[k];
    out['content-length'] = String(range.total);
    return { status: 200, statusText: 'OK', headers: out, body };
  }

  // fetch()-shaped: returns a Response. Redirects are followed here, because
  // the Worker returns them rather than leave its allowlist. fullHeaders are the
  // guest's own headers, sent through the Worker; init is the CORS-safe request
  // used if a redirect leaves the egress hosts.
  async function egressFetch(url, init = {}, fullHeaders = init.headers) {
    let method = String(init.method || 'GET').toUpperCase();
    let body = method === 'GET' || method === 'HEAD' ? null : init.body;
    const headers = { ...(fullHeaders || {}) };
    stats.requests++;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const r = method === 'GET' ? await relayGet(url, headers) : await relay(url, method, headers, body);
        const location = r.headers.location ?? r.headers.Location;
        if (r.status >= 300 && r.status < 400 && location && init.redirect !== 'manual') {
          url = new URL(location, url).href;
          if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) { method = 'GET'; body = null; }
          if (!hostListed(url, hosts)) return redirectedResponse(await fetchImpl(url, { ...init, method, body }), url);
          continue;
        }
        stats.bytes += r.body.length;
        const response = new Response(NULL_BODY.has(r.status) || method === 'HEAD' ? null : r.body,
          { status: r.status, statusText: r.statusText || '', headers: r.headers });
        return redirectedResponse(response, url, hop > 0);
      }
      throw new TypeError(`egress: more than ${MAX_REDIRECTS} redirects`);
    } catch (error) {
      stats.failed++;
      throw error;
    }
  }

  function redirectedResponse(response, url, redirected = true) {
    Object.defineProperty(response, 'url', { value: url });
    Object.defineProperty(response, 'redirected', { value: redirected });
    return response;
  }

  return {
    stats,
    hosts,
    routes: (url) => hostListed(url, hosts),
    fetch: egressFetch,
  };
}
