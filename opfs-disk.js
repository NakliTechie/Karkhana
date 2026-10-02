// Persistent guest disk: a qcow2 image in the origin-private file system (OPFS),
// exposed to QEMU as /kdisk/disk.qcow2.
//
// QEMU runs on a pthread, and Emscripten proxies its file syscalls to the page's
// main thread. OPFS synchronous access handles exist only in workers, and the
// main thread may not block in Atomics.wait. So a dedicated worker holds the
// handle, and the main thread hands it each request through shared memory and
// spins until the answer arrives: about 11 µs for a 4 KiB read in Chrome.
//
// qcow2 is sparse by format, so a disk costs only the clusters it uses. A raw
// sparse file would not do: OPFS quota counts a file's full logical length.

export const BOUNCE_BYTES = 1 << 20;
export const OP = { READ: 1, WRITE: 2, TRUNCATE: 3, FLUSH: 4, CLOSE: 5 };
export const STATE = { IDLE: 0, REQUEST: 1, DONE: 2 };
// Int32 control slots, and Float64 slots for 53-bit offsets.
export const CTL = { STATE: 0, OP: 1, ERRNO: 2 };
export const META = { POS: 0, LEN: 1, RESULT: 2 };
// Emscripten errno values (not Linux's): FS.ErrnoError takes these.
export const ERRNO = { EPERM: 63, ENOENT: 44, EIO: 29, EINVAL: 28, ENOSPC: 51 };

const CALL_TIMEOUT_MS = 30_000;
const QCOW2_MAGIC = [0x51, 0x46, 0x49, 0xfb];

export class DiskError extends Error {
  constructor(errno, message) {
    super(message);
    this.errno = errno;
  }
}

export const isQcow2 = (bytes) => QCOW2_MAGIC.every((b, i) => bytes[i] === b);

// The starting image ships gzip-compressed. A server that sets
// Content-Encoding hands back the image already inflated, so check the magic.
export async function fetchDiskTemplate(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`disk template: HTTP ${response.status}`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(inflated).arrayBuffer());
  }
  if (!isQcow2(bytes)) throw new Error('disk template is not a qcow2 image');
  return bytes;
}

// The main-thread side. Every method is synchronous, as Emscripten's FS needs.
export class OpfsDisk {
  constructor({ worker, ctl, meta, bounce, size, created }) {
    Object.assign(this, { worker, ctl, meta, bounce, size, created });
    this.dead = false;
    this.stats = { reads: 0, writes: 0, bytesRead: 0, bytesWritten: 0, flushes: 0, errors: 0 };
  }

  call(op, pos = 0, len = 0) {
    if (this.dead) throw new DiskError(ERRNO.EIO, 'disk worker stopped');
    const { ctl, meta } = this;
    meta[META.POS] = pos;
    meta[META.LEN] = len;
    ctl[CTL.OP] = op;
    Atomics.store(ctl, CTL.STATE, STATE.REQUEST);
    Atomics.notify(ctl, CTL.STATE);
    const deadline = performance.now() + CALL_TIMEOUT_MS;
    for (let spins = 1; Atomics.load(ctl, CTL.STATE) !== STATE.DONE; spins++) {
      if ((spins & 0xffff) === 0 && performance.now() > deadline) {
        this.dead = true;
        throw new DiskError(ERRNO.EIO, 'disk worker did not answer');
      }
    }
    Atomics.store(ctl, CTL.STATE, STATE.IDLE);
    const errno = ctl[CTL.ERRNO];
    if (errno) {
      this.stats.errors++;
      throw new DiskError(errno, `disk operation ${op} failed`);
    }
    return meta[META.RESULT];
  }

  // buffer is an Int8Array (Emscripten's HEAP8) or a Uint8Array.
  read(buffer, offset, length, position) {
    length = Math.max(0, Math.min(length, this.size - position));
    let done = 0;
    while (done < length) {
      const n = this.call(OP.READ, position + done, Math.min(length - done, BOUNCE_BYTES));
      if (n === 0) break;
      buffer.set(new buffer.constructor(this.bounce, 0, n), offset + done);
      done += n;
    }
    this.stats.reads++;
    this.stats.bytesRead += done;
    return done;
  }

  write(buffer, offset, length, position) {
    let done = 0;
    while (done < length) {
      const want = Math.min(length - done, BOUNCE_BYTES);
      new buffer.constructor(this.bounce, 0, want).set(buffer.subarray(offset + done, offset + done + want));
      const n = this.call(OP.WRITE, position + done, want);
      done += n;
      if (n < want) break;
    }
    this.size = Math.max(this.size, position + done);
    this.stats.writes++;
    this.stats.bytesWritten += done;
    return done;
  }

  truncate(size) {
    this.size = this.call(OP.TRUNCATE, size);
  }

  flush() {
    this.call(OP.FLUSH);
    this.stats.flushes++;
  }

  close() {
    if (this.dead) return;
    try { this.call(OP.CLOSE); } finally {
      this.dead = true;
      this.worker.terminate();
    }
  }
}

// Opens (creating from the template when absent) dir/name in OPFS. Rejects
// with error.code 'busy' when another tab holds the disk, 'unsupported' when
// the browser lacks OPFS sync handles, and 'failed' otherwise.
export async function openOpfsDisk({ workerUrl, templateUrl, dir = 'karkhana-disk', name = 'disk.qcow2' }) {
  if (typeof SharedArrayBuffer === 'undefined' || !navigator.storage?.getDirectory) {
    throw Object.assign(new Error('this browser has no OPFS or shared memory'), { code: 'unsupported' });
  }
  const ctl = new Int32Array(new SharedArrayBuffer(4 * 4));
  const meta = new Float64Array(new SharedArrayBuffer(8 * 4));
  const bounce = new SharedArrayBuffer(BOUNCE_BYTES);
  const worker = new Worker(workerUrl, { type: 'module', name: 'karkhana-disk' });
  const opened = await new Promise((resolve) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = (event) => resolve({ ok: false, code: 'failed', error: event.message || 'disk worker failed to load' });
    worker.postMessage({ ctl: ctl.buffer, meta: meta.buffer, bounce, dir, name, templateUrl: String(templateUrl) });
  });
  worker.onmessage = worker.onerror = null;
  if (!opened.ok) {
    worker.terminate();
    throw Object.assign(new Error(opened.error), { code: opened.code });
  }
  return new OpfsDisk({ worker, ctl, meta, bounce, size: opened.size, created: opened.created });
}

// Mounts a one-file filesystem at mountpoint whose file is the disk. fsync on
// the file reaches syncfs, which flushes the OPFS handle.
export function mountOpfsDisk(FS, disk, mountpoint = '/kdisk', name = 'disk.qcow2') {
  const DIR = 0o040755;
  const FILE = 0o100644;
  const fsError = (error) => (error instanceof DiskError ? new FS.ErrnoError(error.errno) : error);
  const guard = (fn) => (...args) => {
    try { return fn(...args); } catch (error) { throw fsError(error); }
  };
  const attr = (node, size) => ({
    dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size,
    atime: new Date(node.atime), mtime: new Date(node.mtime), ctime: new Date(node.ctime),
    blksize: 4096, blocks: Math.ceil(size / 4096),
  });
  const setTimes = (node, a) => {
    for (const key of ['atime', 'mtime', 'ctime']) if (a[key] !== undefined) node[key] = a[key];
    if (a.timestamp !== undefined) node.mtime = node.ctime = a.timestamp;
  };
  const refuse = () => { throw new FS.ErrnoError(ERRNO.EPERM); };

  const fileNodeOps = {
    getattr: (node) => attr(node, disk.size),
    setattr: guard((node, a) => {
      if (a.size !== undefined) disk.truncate(a.size);
      setTimes(node, a);
    }),
  };
  const fileStreamOps = {
    read: guard((stream, buffer, offset, length, position) => disk.read(buffer, offset, length, position)),
    write: guard((stream, buffer, offset, length, position) => disk.write(buffer, offset, length, position)),
    llseek(stream, offset, whence) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2) position += disk.size;
      else if (whence !== 0) throw new FS.ErrnoError(ERRNO.EINVAL);
      if (position < 0) throw new FS.ErrnoError(ERRNO.EINVAL);
      return position;
    },
  };
  let file = null;
  const dirNodeOps = {
    getattr: (node) => attr(node, 4096),
    setattr: setTimes,
    lookup(parent, entry) {
      if (entry !== name) throw new FS.ErrnoError(ERRNO.ENOENT);
      if (!file) {
        file = FS.createNode(parent, name, FILE, 0);
        file.node_ops = fileNodeOps;
        file.stream_ops = fileStreamOps;
      }
      return file;
    },
    readdir: () => ['.', '..', name],
    mknod: refuse, rename: refuse, unlink: refuse, rmdir: refuse, symlink: refuse,
  };
  const type = {
    mount() {
      const root = FS.createNode(null, '/', DIR, 0);
      root.node_ops = dirNodeOps;
      root.stream_ops = {};
      return root;
    },
    syncfs(mount, populate, done) {
      try { disk.flush(); done(null); } catch (error) { done(fsError(error)); }
    },
  };
  try { FS.mkdir(mountpoint); } catch (error) { /* already present */ }
  FS.mount(type, {}, mountpoint);
}
