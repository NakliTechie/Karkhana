// Host checks for the persistent disk (disk/opfs-disk.js + disk/opfs-disk-worker.js).
// The real worker module runs in a Node worker thread against a file-backed
// stand-in for OPFS that keeps its rules: one sync access handle per file,
// NotFoundError on a missing entry, move() to publish a file. The main-thread
// client is the shipped OpfsDisk, unchanged.
// Run: node qemu-build/test-opfs-disk.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker as NodeWorker } from 'node:worker_threads';
import {
  BOUNCE_BYTES, DiskError, ERRNO, isQcow2, mountOpfsDisk, openOpfsDisk,
} from './disk/opfs-disk.js';

const WORKER = new URL('./disk/opfs-disk-worker.js', import.meta.url);
// openOpfsDisk checks for OPFS on the page; the worker thread supplies the real stand-in.
Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory() {} } }, configurable: true });
const QCOW2 = [0x51, 0x46, 0x49, 0xfb];

// Installed in the worker thread before the real worker module loads.
const BOOTSTRAP = `
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
const { root, lockDir, quotaBytes, templateBytes } = workerData;
// Handles are exclusive across threads, as OPFS handles are across tabs.
const lockOf = (file) => path.join(lockDir, encodeURIComponent(path.relative(root, file)));
const err = (name, msg) => new DOMException(msg, name);
class SyncHandle {
  constructor(file) { this.file = file; this.lock = lockOf(file); fs.closeSync(fs.openSync(this.lock, 'wx')); this.fd = fs.openSync(file, 'r+'); }
  read(view, { at }) { return fs.readSync(this.fd, view, 0, view.byteLength, at); }
  write(view, { at }) {
    if (quotaBytes && at + view.byteLength > quotaBytes) throw err('QuotaExceededError', 'quota');
    return fs.writeSync(this.fd, view, 0, view.byteLength, at);
  }
  truncate(n) { fs.ftruncateSync(this.fd, n); }
  getSize() { return fs.fstatSync(this.fd).size; }
  flush() { fs.fsyncSync(this.fd); globalThis.__flushes = (globalThis.__flushes || 0) + 1; }
  close() { fs.closeSync(this.fd); fs.rmSync(this.lock); }
}
class FileHandle {
  constructor(file) { this.file = file; }
  async createSyncAccessHandle() {
    if (fs.existsSync(lockOf(this.file))) throw err('NoModificationAllowedError', 'busy');
    return new SyncHandle(this.file);
  }
  async move(name) { const to = path.join(path.dirname(this.file), name); fs.renameSync(this.file, to); this.file = to; }
}
class DirHandle {
  constructor(dir) { this.dir = dir; }
  async getDirectoryHandle(name, { create } = {}) {
    const d = path.join(this.dir, name);
    if (!fs.existsSync(d)) { if (!create) throw err('NotFoundError', name); fs.mkdirSync(d); }
    return new DirHandle(d);
  }
  async getFileHandle(name, { create } = {}) {
    const f = path.join(this.dir, name);
    if (!fs.existsSync(f)) { if (!create) throw err('NotFoundError', name); fs.writeFileSync(f, ''); }
    return new FileHandle(f);
  }
}
Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => new DirHandle(root) } } });
globalThis.fetch = async () => new Response(templateBytes);
globalThis.self = globalThis;
self.postMessage = (m) => parentPort.postMessage(m);
parentPort.once('message', async (data) => {
  await import(${JSON.stringify(WORKER.href)});
  self.onmessage({ data });
});
`;

// Browser-shaped Worker over worker_threads, for openOpfsDisk.
function workerClass(root, lockDir, bootstrap, { quotaBytes = 0, template }) {
  return class {
    constructor() {
      this.thread = new NodeWorker(bootstrap,
        { workerData: { root, lockDir, quotaBytes, templateBytes: template } });
      this.thread.on('message', (data) => this.onmessage?.({ data }));
      this.thread.on('error', (error) => this.onerror?.({ message: String(error) }));
    }
    postMessage(data) { this.thread.postMessage(data); }
    terminate() { this.thread.terminate(); }
  };
}

function template(size = 3 * BOUNCE_BYTES + 12345) {
  const bytes = new Uint8Array(size);
  bytes.set(QCOW2);
  for (let i = 4; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

async function withDisk(options, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'karkhana-opfs-'));
  const lockDir = await mkdtemp(path.join(tmpdir(), 'karkhana-opfs-locks-'));
  const saved = globalThis.Worker;
  const bootstrap = path.join(lockDir, 'bootstrap.mjs');
  await writeFile(bootstrap, BOOTSTRAP);
  globalThis.Worker = workerClass(root, lockDir, bootstrap, options);
  const opened = [];
  const open = async () => {
    const disk = await openOpfsDisk({ workerUrl: 'unused', templateUrl: 'http://template.invalid/kdisk.qcow2.gz' });
    opened.push(disk);
    return disk;
  };
  try {
    await fn({ root, open, file: path.join(root, 'karkhana-disk', 'disk.qcow2') });
  } finally {
    for (const disk of opened) { try { disk.close(); } catch { /* already closed */ } }
    globalThis.Worker = saved;
    await rm(root, { recursive: true, force: true });
    await rm(lockDir, { recursive: true, force: true });
  }
}

test('a new disk is seeded from the gzip template and published atomically', async () => {
  const image = template();
  await withDisk({ template: gzipSync(image) }, async ({ root, open, file }) => {
    const disk = await open();
    assert.equal(disk.created, true);
    assert.equal(disk.size, image.length);
    assert.deepEqual(await readdir(path.join(root, 'karkhana-disk')), ['disk.qcow2']);
    const back = new Uint8Array(image.length);
    assert.equal(disk.read(back, 0, image.length, 0), image.length);
    assert.deepEqual(back, image);
    disk.close();
    assert.deepEqual(new Uint8Array(await readFile(file)), image);
    const again = await open();
    assert.equal(again.created, false, 'an existing disk is reused, not reseeded');
  });
});

test('an uncompressed template is accepted as served', async () => {
  const image = template(4096);
  await withDisk({ template: image }, async ({ open }) => {
    const disk = await open();
    assert.equal(disk.size, 4096);
  });
});

test('reads and writes cross bounce-buffer boundaries into HEAP8-style views', async () => {
  await withDisk({ template: gzipSync(template()) }, async ({ open, file }) => {
    const disk = await open();
    const heap = new Int8Array(new SharedArrayBuffer(4 * BOUNCE_BYTES));
    const len = 2 * BOUNCE_BYTES + 777;
    const at = BOUNCE_BYTES - 5;
    for (let i = 0; i < len; i++) heap[100 + i] = (i * 13) & 0xff;
    assert.equal(disk.write(heap, 100, len, at), len);
    const out = new Int8Array(new SharedArrayBuffer(4 * BOUNCE_BYTES));
    assert.equal(disk.read(out, 9, len, at), len);
    assert.deepEqual(out.subarray(9, 9 + len), heap.subarray(100, 100 + len));
    disk.flush();
    disk.close();
    const raw = await readFile(file);
    assert.equal(raw[at + 1], (13) & 0xff);
  });
});

test('writes past the end grow the disk; reads stop at the end', async () => {
  const image = template(8192);
  await withDisk({ template: image }, async ({ open }) => {
    const disk = await open();
    const buf = new Uint8Array(16).fill(0xab);
    assert.equal(disk.write(buf, 0, 16, 65536), 16);
    assert.equal(disk.size, 65536 + 16);
    const out = new Uint8Array(64);
    assert.equal(disk.read(out, 0, 64, 65536 - 8), 24);
    assert.deepEqual([...out.subarray(0, 8)], new Array(8).fill(0), 'the gap reads as zeros');
    assert.deepEqual([...out.subarray(8, 24)], new Array(16).fill(0xab));
    assert.equal(disk.read(out, 0, 64, disk.size + 10), 0);
    disk.truncate(4096);
    assert.equal(disk.size, 4096);
  });
});

test('a second opener gets busy, the code the page turns into scratch mode', async () => {
  await withDisk({ template: template(4096) }, async ({ open }) => {
    await open();
    await assert.rejects(open(), (error) => error.code === 'busy');
  });
});

test('a reload waits for the previous page to release the disk', async () => {
  await withDisk({ template: template(4096) }, async ({ open }) => {
    const previous = await open();
    const next = open();
    setTimeout(() => previous.close(), 600);
    const disk = await next;
    assert.equal(disk.created, false);
    assert.equal(disk.size, 4096);
  });
});

test('a file that is not qcow2 is refused rather than handed to QEMU', async () => {
  await withDisk({ template: template(4096) }, async ({ open, file }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, new Uint8Array(4096));
    await assert.rejects(open(), (error) => error.code === 'failed' && /not a qcow2 image/.test(error.message));
  });
});

test('a quota failure surfaces as ENOSPC, not a hang', async () => {
  await withDisk({ template: template(4096), quotaBytes: 1 << 20 }, async ({ open }) => {
    const disk = await open();
    const buf = new Uint8Array(4096);
    assert.throws(() => disk.write(buf, 0, 4096, 2 << 20), (error) => error instanceof DiskError && error.errno === ERRNO.ENOSPC);
    assert.equal(disk.stats.errors, 1);
    assert.equal(disk.write(buf, 0, 4096, 8192), 4096, 'the disk keeps working after the error');
  });
});

test('isQcow2 checks the magic', () => {
  assert.equal(isQcow2(new Uint8Array(QCOW2)), true);
  assert.equal(isQcow2(new Uint8Array([0x1f, 0x8b, 0, 0])), false);
});

// A stand-in for the subset of Emscripten's FS that mountOpfsDisk touches.
function fakeFS() {
  let inode = 1;
  class ErrnoError extends Error { constructor(errno) { super(`errno ${errno}`); this.errno = errno; } }
  const FS = {
    ErrnoError,
    mounts: {},
    createNode(parent, name, mode) {
      const node = { name, mode, id: inode++, atime: 1, mtime: 2, ctime: 3 };
      node.parent = parent || node;
      node.mount = node.parent.mount;
      return node;
    },
    mkdir(p) { if (FS.mounts[p]) throw new ErrnoError(20); },
    mount(type, opts, mountpoint) {
      const mount = { type, opts };
      const root = type.mount(mount);
      root.mount = mount;
      FS.mounts[mountpoint] = root;
    },
  };
  return FS;
}

test('mountOpfsDisk maps the Emscripten FS ops onto the disk', async () => {
  await withDisk({ template: template(8192) }, async ({ open }) => {
    const disk = await open();
    const FS = fakeFS();
    mountOpfsDisk(FS, disk);
    const root = FS.mounts['/kdisk'];
    assert.deepEqual(root.node_ops.readdir(root), ['.', '..', 'disk.qcow2']);
    assert.throws(() => root.node_ops.lookup(root, 'other'), (e) => e.errno === ERRNO.ENOENT);
    const file = root.node_ops.lookup(root, 'disk.qcow2');
    assert.equal(root.node_ops.lookup(root, 'disk.qcow2'), file, 'one node per file');
    assert.equal(file.mount, root.mount, 'fsync finds the mount type through the file node');
    const st = file.node_ops.getattr(file);
    assert.equal(st.size, 8192);
    assert.equal(st.mode & 0o170000, 0o100000);
    assert.ok(st.mtime instanceof Date);
    const stream = { node: file, position: 100 };
    assert.equal(file.stream_ops.llseek(stream, 0, 2), 8192);
    assert.equal(file.stream_ops.llseek(stream, 5, 1), 105);
    assert.throws(() => file.stream_ops.llseek(stream, 0, 3), (e) => e.errno === ERRNO.EINVAL);
    const heap = new Int8Array(new SharedArrayBuffer(64));
    heap.set([1, 2, 3, 4], 8);
    assert.equal(file.stream_ops.write(stream, heap, 8, 4, 8192), 4);
    assert.equal(file.node_ops.getattr(file).size, 8196);
    const out = new Int8Array(new SharedArrayBuffer(64));
    assert.equal(file.stream_ops.read(stream, out, 0, 4, 8192), 4);
    assert.deepEqual([...out.subarray(0, 4)], [1, 2, 3, 4]);
    file.node_ops.setattr(file, { size: 4096, timestamp: 99 });
    assert.equal(disk.size, 4096);
    assert.equal(file.mtime, 99);
    let synced;
    root.mount.type.syncfs(root.mount, false, (error) => { synced = error; });
    assert.equal(synced, null);
    assert.equal(disk.stats.flushes, 1);
    disk.close();
    assert.throws(() => file.stream_ops.read(stream, out, 0, 4, 0), (e) => e instanceof FS.ErrnoError && e.errno === ERRNO.EIO);
  });
});
