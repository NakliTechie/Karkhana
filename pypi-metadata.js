// PyPI index work runs in the browser, outside the emulated guest CPU.
// Authorization belongs to an install session and its exact loopback origin.
export const PYPI_LIMITS = Object.freeze({ projectBytes: 16 * 1024 * 1024,
  encodedBytes: 32 * 1024 * 1024, cacheBytes: 16 * 1024 * 1024, cacheEntries: 128,
  sessions: 8, sessionWheels: 200000, wheels: 400000,
  registryBytes: 128 * 1024 * 1024, idleMs: 600000 });
export const JSON_TYPE = 'application/vnd.pypi.simple.v1+json';
export const HTML_TYPE = 'application/vnd.pypi.simple.v1+html';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const truthy = value => object(value) ? Object.keys(value).length > 0 : Array.isArray(value) ? value.length > 0 : !!value;
const failure = (message, code = 'network') => Object.assign(new Error(message), { code });
const blocked = message => failure(message, 'blocked');
const checkSignal = signal => { if (signal.aborted) throw failure('request cancelled', 'cancelled'); };
const hashFragment = hashes => {
  if (!object(hashes)) return '';
  const key = Object.hasOwn(hashes, 'sha256') ? 'sha256' : Object.keys(hashes)[0];
  return key ? `${key}=${hashes[key]}` : '';
};
const escapeHTML = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[character]);

function wheelURL(original, project, filename) {
  if (typeof original !== 'string' || original.length > 8192 || /[\\\x00-\x20\x7f]/.test(original))
    throw blocked('Invalid download URL in PyPI metadata');
  // WHATWG URL removes dot segments. Inspect the original spelling first,
  // including escaped separators and backslashes, before normalization.
  let decoded;
  try { decoded = decodeURIComponent(original.split(/[?#]/, 1)[0]); }
  catch (_) { throw blocked('Invalid escaped download URL'); }
  if (/[\\\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..'))
    throw blocked('Blocked download traversal in PyPI metadata');
  const authority = original.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/]*)/i)?.[1];
  if (authority?.includes('@')) throw blocked('Blocked download credentials in PyPI metadata');
  let url;
  try { url = new URL(original, `https://pypi.org/simple/${project}/`); }
  catch (_) { throw blocked('Invalid download URL in PyPI metadata'); }
  if (url.origin !== 'https://files.pythonhosted.org' || url.username || url.password ||
      url.search || !url.pathname.startsWith('/packages/'))
    throw blocked('Blocked download origin or path in PyPI metadata');
  let advertised;
  try { advertised = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1)); }
  catch (_) { throw blocked('Invalid escaped wheel filename'); }
  if (advertised !== filename) throw failure('Download filename does not match PyPI metadata');
  return url;
}

function projectHTML(document) {
  const parts = [`<!doctype html><html><head><meta name="pypi:repository-version" content="${escapeHTML(document.meta?.['api-version'] ?? '1.0')}"></head><body>`];
  for (const entry of document.files) {
    const attributes = { href: entry.url };
    if (entry['requires-python'] != null) attributes['data-requires-python'] = entry['requires-python'];
    if (entry.yanked === true || typeof entry.yanked === 'string')
      attributes['data-yanked'] = typeof entry.yanked === 'string' ? entry.yanked : '';
    for (const key of ['core-metadata', 'dist-info-metadata']) {
      if (truthy(entry[key])) attributes[`data-${key}`] = object(entry[key]) ? hashFragment(entry[key]) : 'true';
    }
    const attrs = Object.entries(attributes).map(([key, value]) => `${key}="${escapeHTML(value)}"`).join(' ');
    parts.push(`<a ${attrs}>${escapeHTML(entry.filename)}</a>`);
  }
  parts.push('</body></html>');
  return parts.join('\n');
}

// Also exported for deterministic host/browser profiles without guest work.
export function encodeProject(project, document, baseUrl, format, limits = PYPI_LIMITS) {
  if (!object(document) || !Array.isArray(document.files)) throw failure('Invalid PyPI project metadata');
  const files = [], additions = new Map();
  for (const entry of document.files) {
    if (!object(entry) || typeof entry.filename !== 'string') throw failure('Invalid file entry in PyPI metadata');
    if (!entry.filename.endsWith('.whl')) continue;
    const url = wheelURL(entry.url, project, entry.filename);
    const route = '/files' + url.pathname;
    const metadata = Object.hasOwn(entry, 'core-metadata') ? entry['core-metadata'] : entry['dist-info-metadata'];
    additions.set(route, truthy(metadata) || additions.get(route) === true);
    const fragment = url.hash.slice(1) || hashFragment(entry.hashes);
    files.push({ ...entry, url: baseUrl + route + (fragment ? '#' + fragment : '') });
  }
  const result = { ...document, files };
  const bytes = encoder.encode(format === 'json' ? JSON.stringify(result) : projectHTML(result));
  if (bytes.byteLength > limits.encodedBytes) throw failure('Encoded PyPI metadata exceeds size limit');
  return { bytes, additions, contentType: format === 'json' ? JSON_TYPE : HTML_TYPE };
}

function byteResponse(url, bytes = new Uint8Array(), contentType = JSON_TYPE, status = 200) {
  return { status, url, headers: new Headers({ 'content-type': contentType }), body: {
    getReader() {
      let offset = 0;
      return { async read() {
        if (offset === bytes.byteLength) return { done: true };
        const value = bytes.subarray(offset, offset + 256 * 1024);
        offset += value.byteLength;
        return { value, done: false };
      }, async cancel() { offset = bytes.byteLength; } };
    },
  } };
}

export function createPyPIProcessor({ limits = PYPI_LIMITS, now = Date.now } = {}) {
  const sessions = new Map(), cache = new Map();
  let cacheBytes = 0, wheelCount = 0, registryBytes = 0;
  const stats = { projects: 0, cacheHits: 0, shared: 0, inputBytes: 0, outputBytes: 0 };
  function evict(key) {
    const item = cache.get(key);
    if (item) { cacheBytes -= item.bytes.byteLength; cache.delete(key); }
  }
  function close(session) {
    sessions.delete(session.id);
    for (const controller of session.controllers) controller.abort();
    for (const pending of session.pending.values()) pending.controller.abort();
    for (const [key, item] of cache) if (item.session === session) evict(key);
    wheelCount -= session.files.size; registryBytes -= session.registryBytes;
    session.files.clear(); session.pending.clear();
  }
  function sweep() {
    for (const session of sessions.values())
      if (!session.controllers.size && now() - session.touched > limits.idleMs) close(session);
  }
  function validate(request) {
    const p = request.pypi;
    if (!object(p) || typeof p.session !== 'string' || !/^[a-f0-9]{32}$/.test(p.session) ||
        typeof p.baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(p.baseUrl) ||
        Number(p.baseUrl.slice(p.baseUrl.lastIndexOf(':') + 1)) > 65535)
      throw blocked('Invalid PyPI session or loopback origin');
    if (p.operation === 'project') {
      if (typeof p.project !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.project) ||
          !['json', 'html'].includes(p.format) || request.url !== `https://pypi.org/simple/${p.project}/` ||
          request.method !== 'GET') throw blocked('Invalid PyPI project request');
    } else if (p.operation === 'file') {
      if (typeof p.path !== 'string' || !p.path.startsWith('/files/packages/') ||
          request.url !== 'https://files.pythonhosted.org' + p.path.slice('/files'.length))
        throw blocked('Invalid PyPI file route');
    } else if (p.operation === 'close') {
      if (request.url !== 'https://pypi.org/' || request.method !== 'GET') throw blocked('Invalid PyPI session close');
    } else throw blocked('Unsupported PyPI operation');
    return p;
  }
  function alive(session, signal) {
    checkSignal(signal);
    if (sessions.get(session.id) !== session) throw blocked('PyPI session is closed');
  }
  function commit(session, encoded, signal) {
    alive(session, signal);
    let added = 0, bytes = 0;
    for (const route of encoded.additions.keys()) {
      if (!session.files.has(route)) { added++; bytes += route.length * 2 + 48; }
    }
    if (session.files.size + added > limits.sessionWheels || wheelCount + added > limits.wheels ||
        registryBytes + bytes > limits.registryBytes) throw failure('Package metadata exceeds this session\'s wheel limit', 'capacity');
    for (const [route, metadata] of encoded.additions)
      session.files.set(route, metadata || session.files.get(route) === true);
    wheelCount += added; registryBytes += bytes; session.registryBytes += bytes;
  }
  async function produce(session, p, fetchRemote, signal) {
    const url = `https://pypi.org/simple/${p.project}/`;
    const response = await fetchRemote(url, { method: 'GET', headers: new Headers({ accept: JSON_TYPE }), signal });
    alive(session, signal);
    if (response.type === 'opaque' || response.status === 0) throw failure('Opaque PyPI response is unsupported');
    if (response.url && response.url !== url) throw blocked('Blocked PyPI metadata redirect');
    if (response.status !== 200) {
      if (response.body) void response.body.cancel().catch(() => {});
      return { status: response.status, bytes: new Uint8Array(), contentType: JSON_TYPE };
    }
    const reader = response.body?.getReader();
    let size = 0;
    const chunks = [];
    try {
      if (reader) for (;;) {
        const next = await reader.read();
        alive(session, signal);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limits.projectBytes) throw failure('PyPI project metadata exceeds size limit');
        chunks.push(next.value);
      }
    } finally { if (reader) void reader.cancel().catch(() => {}); }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    let document;
    try { document = JSON.parse(decoder.decode(data)); }
    catch (_) { throw failure('PyPI did not return valid JSON metadata'); }
    const encoded = encodeProject(p.project, document, session.baseUrl, p.format, limits);
    commit(session, encoded, signal);
    stats.projects++; stats.inputBytes += size; stats.outputBytes += encoded.bytes.byteLength;
    return { bytes: encoded.bytes, contentType: encoded.contentType, status: 200 };
  }
  async function project(session, p, fetchRemote, signal) {
    const key = `${session.id}:${p.project}:${p.format}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key); cache.set(key, cached); stats.cacheHits++;
      return cached;
    }
    let pending = session.pending.get(key);
    if (!pending) {
      pending = { controller: new AbortController(), users: 0 };
      session.pending.set(key, pending);
      pending.promise = produce(session, p, fetchRemote, pending.controller.signal).then(result => {
        alive(session, pending.controller.signal);
        if (result.status === 200 && result.bytes.byteLength <= limits.cacheBytes) {
          while (cache.size && (cacheBytes + result.bytes.byteLength > limits.cacheBytes || cache.size >= limits.cacheEntries))
            evict(cache.keys().next().value);
          if (limits.cacheEntries > 0) {
            cache.set(key, { ...result, session }); cacheBytes += result.bytes.byteLength;
          }
        }
        return result;
      }).finally(() => { if (session.pending.get(key) === pending) session.pending.delete(key); });
    } else stats.shared++;
    pending.users++;
    let abort;
    try {
      checkSignal(signal);
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(failure('request cancelled', 'cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      });
      return await Promise.race([pending.promise, cancelled]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      if (--pending.users === 0) {
        pending.controller.abort();
        if (session.pending.get(key) === pending) session.pending.delete(key);
      }
    }
  }
  return {
    async open(request, controller, fetchRemote) {
      sweep();
      const p = validate(request);
      let session = sessions.get(p.session);
      if (session && session.baseUrl !== p.baseUrl) throw blocked('PyPI session loopback origin changed');
      if (p.operation === 'close') {
        if (session) close(session);
        return { response: byteResponse(request.url), release() {} };
      }
      if (!session) {
        if (p.operation !== 'project') throw blocked('Unknown PyPI install session');
        if (sessions.size >= limits.sessions) throw failure('Too many PyPI install sessions', 'capacity');
        session = { id: p.session, baseUrl: p.baseUrl, files: new Map(), pending: new Map(),
          controllers: new Set(), touched: now(), registryBytes: 0 };
        sessions.set(session.id, session);
      }
      session.controllers.add(controller);
      const release = () => { session.controllers.delete(controller); session.touched = now(); };
      try {
        alive(session, controller.signal);
        let response;
        if (p.operation === 'project') {
          const result = await project(session, p, fetchRemote, controller.signal);
          alive(session, controller.signal);
          response = byteResponse(request.url, result.bytes, result.contentType, result.status);
        } else {
          const sidecar = p.path.endsWith('.metadata');
          const route = sidecar ? p.path.slice(0, -'.metadata'.length) : p.path;
          if (!session.files.has(route) || (sidecar && !session.files.get(route)))
            throw blocked('Download was not advertised by this session\'s PyPI index');
          response = await fetchRemote(request.url, { method: request.method,
            headers: new Headers(), signal: controller.signal });
          alive(session, controller.signal);
          if (response.url && response.url !== request.url) throw blocked('Blocked PyPI download redirect');
        }
        return { response, release };
      } catch (error) {
        release();
        // Failed first project requests should not consume session capacity.
        if (!session.files.size && !session.controllers.size && !session.pending.size && sessions.get(session.id) === session)
          close(session);
        throw error;
      }
    },
    stop() { for (const session of sessions.values()) close(session); },
    sweep,
    get status() { sweep(); return { ...stats, sessions: sessions.size, wheels: wheelCount, registryBytes,
      cacheBytes, cacheEntries: cache.size }; },
  };
}
