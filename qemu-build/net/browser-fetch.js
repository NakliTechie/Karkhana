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

export function createBrowserFetchBridge(FS, { root = '/persist/.karkhana-net',
  fetchImpl = globalThis.fetch, generation = globalThis.crypto.randomUUID(),
  scripts = {}, limits = FETCH_LIMITS, pypiOptions = {} } = {}) {
  let running = false, timer, sweepTimer;
  const pypi = createPyPIProcessor(pypiOptions);
  const slots = Array.from({ length: limits.slots }, (_, index) => ({
    path: `${root}/${index}`, seen: '', current: null,
  }));
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
    if (request.protocol !== 1 || request.generation !== generation || request.id !== task.id)
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
      const fetchRemote = (href, options) => fetchImpl(href, {
        credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', redirect: 'error',
        cache: 'no-store', ...options });
      let response;
      if (request.pypi !== undefined) {
        const opened = await pypi.open(request, task.controller, fetchRemote);
        response = opened.response; release = opened.release;
      } else {
        response = await fetchRemote(url.href, { method: request.method, headers, signal: task.controller.signal });
      }
      check(slot, task);
      if (response.type === 'opaque' || response.status === 0) throw new Error('opaque response is unsupported');
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
      mkdir(root); mkdir(`${root}/bin`);
      write(`${root}/config.json`, JSON.stringify({ protocol: 1, generation,
        slots: limits.slots, chunkBytes: limits.chunkBytes, maxTimeoutMs: limits.maxTimeoutMs,
        pypiMetadata: 1 }));
      for (const [name, source] of Object.entries(scripts)) write(`${root}/${name}`, source);
      for (const [command, script] of [['kfetch', 'kfetch.py'], ['kpip-fast', 'kpip_fast.py']]) {
        write(`${root}/bin/${command}`, `#!/bin/sh\nexec python3 ${root}/${script} "$@"\n`);
        FS.chmod(`${root}/bin/${command}`, 0o755);
      }
      for (const slot of slots) {
        mkdir(slot.path);
        for (const name of ['request', 'request-ready', 'ready', 'chunk', 'ack', 'cancel']) write(`${slot.path}/${name}`, '');
      }
      running = true; poll();
      sweepTimer = setInterval(() => pypi.sweep(), 30000);
    },
    stop() {
      running = false; clearTimeout(timer); clearInterval(sweepTimer);
      for (const slot of slots) slot.current?.controller.abort();
      pypi.stop();
    },
    get status() { return { available: running, protocol: 1, ...stats, pypi: pypi.status }; },
  };
}
