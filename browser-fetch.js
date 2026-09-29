// Direct HTTP downloads over the existing 9p mount. No guest external TCP/TLS.
// The guest owns request/ack/cancel files; the browser owns ready/chunk files.
// Publish bytes first, then a generation + request + sequence commit marker.
import { createPyPIProcessor } from './pypi-metadata.js';
export const FETCH_LIMITS = Object.freeze({ slots: 4, chunkBytes: 256 * 1024,
  requestBytes: 16384, responseHeaderBytes: 16384, readBytes: 16 * 1024 * 1024,
  maxTimeoutMs: 600000, pollMs: 20 });
const ORIGINS = new Set(['https://pypi.org', 'https://files.pythonhosted.org']);
const HEADER_NAMES = new Set(['accept', 'range', 'if-range', 'if-none-match', 'if-modified-since']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => Object.assign(new Error(message), { code });
const owners = new WeakMap();

export function createBrowserFetchBridge(FS, { root = '/persist/.karkhana-net',
  fetchImpl = globalThis.fetch, generation = globalThis.crypto.randomUUID(),
  scripts = {}, limits = FETCH_LIMITS, pypiOptions = {} } = {}) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0'))
    throw new Error('bridge root must be an absolute path');
  const components = [];
  for (const part of root.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') components.pop(); else components.push(part);
  }
  root = '/' + components.join('/');
  if (root === '/') throw new Error('bridge root must be a dedicated directory');
  if (typeof generation !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(generation))
    throw new Error('invalid bridge generation');
  for (const [name, maximum] of Object.entries(FETCH_LIMITS)) {
    const value = limits[name];
    if (!Number.isInteger(value) || value < (name === 'maxTimeoutMs' ? 1000 : 1)
        || value > (name === 'pollMs' ? 1000 : maximum)) throw new Error(`invalid bridge limit: ${name}`);
  }
  const generationPrefix = generation.slice(0, 24);
  let running = false, timer, sweepTimer, directory, rootIdentity;
  let pypi = createPyPIProcessor(pypiOptions), slots = [];
  let registry = owners.get(FS);
  if (!registry) owners.set(FS, registry = new Map());
  const owner = {};
  function retire() {
    if (running || stats.active) return;
    for (const slot of slots) {
      for (const name of ['request', 'request-ready', 'ready', 'chunk', 'ack', 'cancel']) {
        try { write(`${slot.path}/${name}`, ''); } catch (_) {}
        try { FS.unlink(`${slot.path}/${name}`); } catch (_) {}
      }
      try { FS.rmdir(slot.path); } catch (_) {}
    }
    if (directory) { try { FS.rmdir(directory); } catch (_) {} }
    if (registry.get(rootIdentity) === owner) registry.delete(rootIdentity);
  }
  async function abortable(signal, operation) {
    if (signal.aborted) throw new Error('request aborted');
    let aborted;
    const interrupt = new Promise((_, reject) => {
      aborted = () => reject(new Error('request aborted'));
      signal.addEventListener('abort', aborted, { once: true });
    });
    try { return await Promise.race([operation(), interrupt]); }
    finally { signal.removeEventListener('abort', aborted); }
  }
  const stats = { requests: 0, completed: 0, failed: 0, bytes: 0, active: 0 };
  function mkdir(path) { try { FS.mkdir(path); } catch (e) { if (!FS.stat(path).mode) throw e; } }
  function write(path, value) { FS.writeFile(path, typeof value === 'string' ? encoder.encode(value) : value); }
  function read(path, maximum) {
    // Check size before readFile allocates, including on a malicious guest write.
    if (FS.stat(path).size > maximum) throw new Error('bridge file exceeds size limit');
    return FS.readFile(path);
  }
  const text = (path, maximum = 256) => decoder.decode(read(path, maximum));
  const marker = (id) => `${generation}:${id}`;
  function current(slot, task) {
    return running && slot.current === task && text(`${slot.path}/request-ready`) === task.token;
  }
  function check(slot, task) {
    if (!current(slot, task)) throw new Error('request replaced or bridge stopped');
    if (task.controller.signal.aborted) throw new Error(task.reason || 'request aborted');
    if (text(`${slot.path}/cancel`) === task.token) {
      task.controller.abort(); throw new Error('request cancelled');
    }
  }
  function validate(request, task) {
    if (!request || typeof request !== 'object' || request.protocol !== 2 || request.generation !== generation || request.id !== task.id)
      throw new Error('request identity mismatch');
    if (typeof request.url !== 'string' || request.url.length > 8192) throw new Error('invalid URL');
    const url = new URL(request.url);
    const authority = request.url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i)?.[1];
    if (url.username || url.password || authority?.includes('@') || !ORIGINS.has(url.origin))
      throw failure('blocked', 'only HTTPS pypi.org and files.pythonhosted.org downloads are supported');
    if (!['GET', 'HEAD'].includes(request.method)) throw failure('blocked', 'only GET and HEAD are supported');
    if (!Array.isArray(request.headers) || request.headers.length > 16) throw new Error('invalid headers');
    const headers = new Headers();
    for (const pair of request.headers) {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== 'string') ||
          pair[1].length > 2048 || !HEADER_NAMES.has(pair[0].toLowerCase()))
        throw failure('blocked', 'unsupported request header');
      headers.append(pair[0], pair[1]);
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > limits.maxTimeoutMs)
      throw new Error('timeout must be between 1 and 600 seconds');
    return { url, headers };
  }
  async function publish(slot, task, fields, bytes) {
    check(slot, task);
    if (bytes) write(`${slot.path}/chunk`, bytes);
    const frame = { generation, id: task.id, seq: task.seq++, ...fields };
    const encoded = JSON.stringify(frame);
    if (encoder.encode(encoded).length > limits.responseHeaderBytes) throw new Error('response metadata exceeds size limit');
    write(`${slot.path}/ready`, encoded);
    if (fields.kind === 'done') return;
    task.awaiting = frame.seq;
    const ack = `${task.token}:${frame.seq}`;
    for (;;) {
      check(slot, task);
      if (text(`${slot.path}/ack`) === ack) { task.awaiting = undefined; return; }
      await pause(limits.pollMs);
    }
  }
  async function serve(slot, task) {
    let timeout, reader, release;
    stats.requests++; stats.active++;
    try {
      const request = JSON.parse(text(`${slot.path}/request`, limits.requestBytes));
      const { url, headers } = validate(request, task);
      timeout = setTimeout(() => { task.reason = 'request timed out'; task.controller.abort(); }, request.timeoutMs);
      check(slot, task);
      const fetchRemote = async (href, options) => {
        const signal = options.signal;
        const response = await abortable(signal, () => {
          const pending = Promise.resolve(fetchImpl(href, {
            credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', redirect: 'error',
            cache: 'no-store', ...options }));
          // A custom fetch can settle after cancellation. Discard that body too.
          void pending.then(late => {
            if (signal.aborted) void Promise.resolve().then(() => late.body?.cancel?.()).catch(() => {});
          }, () => {});
          return pending;
        });
        // Both the direct path and metadata processor receive abort-aware reads.
        // The metadata processor still owns its session release in open/finally.
        let upstream, cancellation;
        const cancel = () => {
          signal.removeEventListener('abort', onAbort);
          return cancellation ||= Promise.resolve().then(() => upstream ? upstream.cancel() : response.body?.cancel?.());
        };
        const onAbort = () => { void cancel().catch(() => {}); };
        const body = response.body && {
          getReader() {
            upstream = response.body.getReader();
            return { read: () => abortable(signal, () => upstream.read()), cancel };
          },
          cancel,
        };
        if (body) {
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
        return { type: response.type, status: response.status, headers: response.headers,
          url: response.url, redirected: response.redirected, body };
      };
      let response;
      if (request.pypi !== undefined) {
        const opened = await pypi.open(request, task.controller, fetchRemote);
        response = opened.response; release = opened.release;
      } else {
        response = await fetchRemote(url.href, { method: request.method, headers, signal: task.controller.signal });
      }
      check(slot, task);
      if (response.type === 'opaque' || response.status === 0) throw new Error('opaque response is unsupported');
      if (response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 304))
        throw failure('blocked', 'redirect responses are unsupported');
      // Fetch decodes Content-Encoding before exposing bytes. Those wire headers
      // no longer describe this stream and must not reach the loopback adapter.
      const responseHeaders = [...response.headers].filter(([name]) =>
        !['content-encoding', 'content-length', 'set-cookie', 'set-cookie2'].includes(name.toLowerCase()));
      await publish(slot, task, { kind: 'headers', status: response.status,
        headers: responseHeaders, url: response.url || url.href });
      if (response.body && request.method !== 'HEAD') {
        reader = response.body.getReader();
        // Fetch often returns small network fragments. Coalesce them before a
        // 9p publication so each fragment does not require another guest ACK.
        // One reusable chunk plus the bounded current browser read are held.
        const chunk = new Uint8Array(limits.chunkBytes);
        let filled = 0;
        for (;;) {
          const result = await reader.read();
          check(slot, task);
          if (result.done) break;
          if (result.value.byteLength > limits.readBytes) throw new Error('browser stream chunk exceeds size limit');
          for (let offset = 0; offset < result.value.byteLength;) {
            const copied = Math.min(limits.chunkBytes - filled, result.value.byteLength - offset);
            chunk.set(result.value.subarray(offset, offset + copied), filled);
            offset += copied; filled += copied;
            if (filled === limits.chunkBytes) {
              await publish(slot, task, { kind: 'chunk', size: filled }, chunk);
              stats.bytes += filled;
              // Publication waits for ACK before this buffer can be reused.
              filled = 0;
            }
          }
        }
        if (filled) {
          await publish(slot, task, { kind: 'chunk', size: filled }, chunk.subarray(0, filled));
          stats.bytes += filled;
        }
      }
      await publish(slot, task, { kind: 'done' });
      stats.completed++;
    } catch (error) {
      stats.failed++;
      // Errors remain distinct from EOF. Never let an old async continuation
      // overwrite the ready marker belonging to a replacement request.
      try {
        if (current(slot, task)) {
          const unacknowledged = task.awaiting !== undefined &&
            text(`${slot.path}/ack`) !== `${task.token}:${task.awaiting}`;
          write(`${slot.path}/ready`, JSON.stringify({ generation,
            id: task.id, seq: unacknowledged ? task.awaiting : task.seq,
            kind: 'error', code: task.reason ? 'timeout' : task.controller.signal.aborted ? 'cancelled' : error.code || 'network',
            error: task.reason || String(error.message).slice(0, 512) }));
        }
      } catch (_) { /* corrupt guest-owned files cannot affect other slots */ }
    } finally {
      clearTimeout(timeout);
      task.controller.abort();
      release?.();
      if (reader) { try { void reader.cancel().catch(() => {}); } catch (_) {} }
      if (slot.current === task) slot.current = null;
      stats.active--;
      retire();
    }
  }
  function poll() {
    if (!running) return;
    for (const slot of slots) {
      try {
        const token = text(`${slot.path}/request-ready`);
        if (slot.current && text(`${slot.path}/cancel`) === slot.current.token) slot.current.controller.abort();
        if (!token || token === slot.seen || !token.startsWith(`${generation}:`)) continue;
        const id = token.slice(generation.length + 1);
        if (!/^[a-f0-9]{32}$/.test(id)) continue;
        // Drain cancellation before replacing a task, keeping active fetches
        // bounded even when a guest repeatedly abandons and reuses one slot.
        if (slot.current) { slot.current.controller.abort(); continue; }
        slot.seen = token;
        const task = { id, token, controller: new AbortController(), seq: 0 };
        slot.current = task;
        void serve(slot, task);
      } catch (_) { /* a malformed slot must not stop the bridge */ }
    }
    timer = setTimeout(poll, stats.active ? limits.pollMs : 100);
  }
  return {
    start() {
      if (running) return;
      if (stats.active) throw new Error('bridge is draining; retry start after active requests finish');
      mkdir(root);
      const stat = FS.stat(root);
      if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino))
        throw new Error('bridge filesystem must expose stable device and inode identities');
      rootIdentity = `${stat.dev}:${stat.ino}`;
      if (registry.has(rootIdentity) && registry.get(rootIdentity) !== owner)
        throw new Error('bridge root already has an owner');
      registry.set(rootIdentity, owner);
      try {
        mkdir(`${root}/bin`);
        // Even caller-supplied generation hints get a fresh, unguessable identity.
        // Retired descriptors and delayed clients can never address the next run.
        generation = `${generationPrefix}_${globalThis.crypto.randomUUID()}`;
        directory = `${root}/${generation}`;
        mkdir(directory);
        slots = Array.from({ length: limits.slots }, (_, index) => ({
          path: `${directory}/${index}`, seen: '', current: null,
        }));
        pypi = createPyPIProcessor(pypiOptions);
        for (const [name, source] of Object.entries(scripts)) write(`${root}/${name}`, source);
        for (const [command, script] of [['kfetch', 'kfetch.py'], ['kpip-fast', 'kpip_fast.py']]) {
          write(`${root}/bin/${command}`, `#!/bin/sh\nexec python3 '${root.replaceAll("'", "'\\''")}/${script}' "$@"\n`);
          FS.chmod(`${root}/bin/${command}`, 0o755);
        }
        for (const slot of slots) {
          mkdir(slot.path);
          for (const name of ['request', 'request-ready', 'ready', 'chunk', 'ack', 'cancel']) write(`${slot.path}/${name}`, '');
        }
        // Publish configuration last, after every mailbox is ready.
        write(`${root}/config.json`, JSON.stringify({ protocol: 2, available: true, generation,
          slots: limits.slots, chunkBytes: limits.chunkBytes, maxTimeoutMs: limits.maxTimeoutMs,
          pypiMetadata: 1 }));
        running = true; poll();
        sweepTimer = setInterval(() => pypi.sweep(), 30000);
      } catch (error) { running = false; retire(); throw error; }
    },
    stop() {
      if (!running) return;
      running = false; clearTimeout(timer); clearInterval(sweepTimer);
      // Keep version/generation visible while making new guest calls fail fast.
      try { write(`${root}/config.json`, JSON.stringify({ protocol: 2, available: false, generation })); } catch (_) {}
      for (const slot of slots) slot.current?.controller.abort();
      pypi.stop();
      retire();
    },
    get status() { return { available: running, protocol: 2, ...stats, pypi: pypi.status }; },
  };
}
