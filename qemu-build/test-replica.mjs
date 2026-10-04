// Host checks for the storage ladder's replica path: disk/chunk-tracker.js
// (dirty chunks, consistent snapshots) and disk/replica.js (content-addressed
// chunks, manifest commits, restore), against an in-memory directory with the
// File System Access API's shape.
// Run: node qemu-build/test-replica.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkTracker, REPL } from './disk/chunk-tracker.js';
import { Replica, describeReplica, restoreReplica } from './disk/replica.js';

const CHUNK = 1024;
const notFound = (name) => new DOMException(name, 'NotFoundError');

// A directory handle backed by Maps; createWritable replaces the file on close().
class MemDir {
  constructor() { this.dirs = new Map(); this.files = new Map(); }
  async getDirectoryHandle(name, { create } = {}) {
    if (!this.dirs.has(name)) { if (!create) throw notFound(name); this.dirs.set(name, new MemDir()); }
    return this.dirs.get(name);
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.files.has(name)) { if (!create) throw notFound(name); this.files.set(name, new Uint8Array(0)); }
    const dir = this;
    return {
      getFile: async () => { const b = dir.files.get(name); return { size: b.length, text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer }; },
      createWritable: async () => { const parts = []; return { write: async (b) => parts.push(new Uint8Array(b)), close: async () => dir.files.set(name, concat(parts)) }; },
    };
  }
  async removeEntry(name) { this.files.delete(name); this.dirs.delete(name); }
  async *keys() { yield* this.files.keys(); yield* this.dirs.keys(); }
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// A sync-access-handle stand-in over a growable buffer.
class MemHandle {
  constructor(bytes = new Uint8Array(0)) { this.bytes = bytes; }
  getSize() { return this.bytes.length; }
  truncate(n) { const b = new Uint8Array(n); b.set(this.bytes.subarray(0, n)); this.bytes = b; }
  write(src, { at }) { if (at + src.length > this.bytes.length) this.truncate(at + src.length); this.bytes.set(src, at); return src.length; }
  read(dst, { at }) { const n = Math.max(0, Math.min(dst.length, this.bytes.length - at)); dst.set(this.bytes.subarray(at, at + n)); return n; }
  flush() {}
}

const randomDisk = (chunks, extra = 100) => {
  const b = new Uint8Array(chunks * CHUNK + extra);
  for (let i = 0; i < b.length; i++) b[i] = (i * 7919 + 13) & 0xff;
  return b;
};

// A disk, its tracker, and a replica connected the way the workers connect them.
function rig(bytes, { dirty = null, diskId = 'disk-a', dir = new MemDir(), maxInflight = 2 } = {}) {
  const disk = new MemHandle(bytes);
  const repl = new Int32Array(new SharedArrayBuffer(16));
  const sent = [];
  const persisted = [];
  let replica;
  const tracker = new ChunkTracker({
    size: disk.getSize(), dirty, chunkBytes: CHUNK, maxInflight, repl,
    readChunk: (c, size) => { const b = new Uint8Array(Math.max(0, Math.min(CHUNK, size - c * CHUNK))); disk.read(b, { at: c * CHUNK }); return b; },
    persist: (map) => persisted.push(map.slice()),
    send: (message) => { sent.push(message); replica?.receive(message, repl); },
  });
  const write = (at, data) => { tracker.beforeWrite(at, data.length); disk.write(data, { at }); };
  // Pumps until the replica has committed the open snapshot.
  const drain = async () => {
    for (let i = 0; i < 10_000 && tracker.active; i++) { tracker.pump(); await replica.queue; tracker.settle(); }
    assert.equal(tracker.active, false, 'snapshot settled');
  };
  return {
    disk, repl, sent, persisted, tracker, write, drain, dir,
    attach: async () => { replica = await Replica.open(dir, diskId); return replica; },
  };
}

test('a disk with no bitmap starts all-dirty; a snapshot sends every chunk, a few at a time', async () => {
  const r = rig(randomDisk(5));
  assert.equal(r.tracker.begin(r.disk.getSize()), 6);
  assert.equal(r.tracker.begin(r.disk.getSize()), -1, 'one snapshot at a time');
  r.tracker.pump();
  assert.equal(r.sent.filter((m) => m.type === 'chunk').length, 2, 'bounded by maxInflight');
  assert.equal(r.sent.at(-1).bytes.length, CHUNK);
  Atomics.store(r.repl, REPL.INFLIGHT, 0);
  r.tracker.pump(); Atomics.store(r.repl, REPL.INFLIGHT, 0);
  r.tracker.pump();
  const chunks = r.sent.filter((m) => m.type === 'chunk');
  assert.deepEqual(chunks.map((m) => m.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(chunks.at(-1).bytes.length, 100, 'the tail chunk is short');
  assert.equal(r.sent.at(-1).type, 'end');
});

test('a guest write during a snapshot does not leak into it', async () => {
  const bytes = randomDisk(4, 0);
  const before = bytes.slice();
  const r = rig(bytes);
  await r.attach();
  r.tracker.begin(r.disk.getSize());
  r.tracker.pump(); // chunks 0 and 1 leave; 2 and 3 are still pending
  r.write(2 * CHUNK + 5, new Uint8Array(10).fill(0xee));
  r.write(0, new Uint8Array(4).fill(0xdd)); // already sent: only dirties chunk 0 again
  await r.drain();
  const restored = new MemHandle();
  await restoreReplica(r.dir, restored);
  assert.deepEqual(restored.bytes, before, 'the replica is the disk as it was at begin()');
  assert.equal(r.tracker.begin(r.disk.getSize()), 2, 'chunks 0 and 2 wait for the next snapshot');
});

test('later snapshots copy only changed chunks, store equal chunks once, and drop stale ones', async () => {
  const bytes = new Uint8Array(6 * CHUNK);
  for (let c = 0; c < 6; c++) bytes.fill(c % 3, c * CHUNK, (c + 1) * CHUNK); // three distinct chunk contents
  const r = rig(bytes);
  const replica = await r.attach();
  r.tracker.begin(r.disk.getSize());
  await r.drain();
  assert.equal(replica.stats.chunksWritten, 3, 'six chunks, three contents');
  r.write(4 * CHUNK, new Uint8Array(CHUNK).fill(9));
  assert.equal(r.tracker.begin(r.disk.getSize()), 1);
  await r.drain();
  assert.equal(replica.stats.chunksWritten, 4);
  assert.equal(replica.committed.seq, 2);
  const chunkDir = r.dir.dirs.get('karkhana-disk').dirs.get('chunks');
  assert.equal(chunkDir.files.size, 4, 'content 1 is still used by chunk 1');
  r.write(1 * CHUNK, new Uint8Array(CHUNK).fill(9));
  r.tracker.begin(r.disk.getSize());
  await r.drain();
  assert.equal(chunkDir.files.size, 3, 'the stale content-1 chunk is collected');
  const restored = new MemHandle();
  await restoreReplica(r.dir, restored);
  assert.deepEqual(restored.bytes, r.disk.bytes);
});

test('a failed snapshot leaves the last commit standing and turns its chunks dirty again', async () => {
  const r = rig(randomDisk(3, 0));
  const replica = await r.attach();
  r.tracker.begin(r.disk.getSize());
  await r.drain();
  const good = replica.committed;
  r.write(CHUNK, new Uint8Array(8).fill(1));
  replica.chunks.getFileHandle = async () => { throw new Error('disk full'); };
  r.tracker.begin(r.disk.getSize());
  for (let i = 0; i < 20 && r.tracker.active; i++) { r.tracker.pump(); await replica.queue; r.tracker.settle(); }
  assert.equal(r.tracker.active, false);
  assert.equal(replica.committed, good, 'the manifest was not touched');
  assert.equal(replica.stats.lastError, 'disk full');
  assert.equal(Atomics.load(r.repl, REPL.INFLIGHT), 0);
  assert.equal(r.tracker.dirty[1], 1, 'chunk 1 waits for the next attempt');
});

test("a folder holding another disk's backup is refused, not overwritten", async () => {
  const dir = new MemDir();
  const a = rig(randomDisk(2), { dir });
  await a.attach();
  a.tracker.begin(a.disk.getSize());
  await a.drain();
  assert.equal((await describeReplica(dir)).diskId, 'disk-a');
  const b = rig(randomDisk(2), { dir, diskId: 'disk-b' });
  await assert.rejects(b.attach(), (e) => e.code === 'other-disk' && e.diskId === 'disk-a');
});

test('restore detects a damaged chunk', async () => {
  const r = rig(randomDisk(2));
  await r.attach();
  r.tracker.begin(r.disk.getSize());
  await r.drain();
  const chunkDir = r.dir.dirs.get('karkhana-disk').dirs.get('chunks');
  const [name] = chunkDir.files.keys();
  chunkDir.files.set(name, new Uint8Array(CHUNK));
  await assert.rejects(restoreReplica(r.dir, new MemHandle()), /damaged/);
});

test('a kept bitmap carries dirty chunks across restarts; growth is dirty', () => {
  const r = rig(randomDisk(4, 0), { dirty: Uint8Array.from([0, 1, 0, 0]) });
  r.write(4 * CHUNK, new Uint8Array(10)); // grows the disk by a chunk
  assert.deepEqual([...r.persisted.at(-1)], [0, 1, 0, 0, 1]);
  assert.equal(r.tracker.begin(r.disk.getSize()), 2);
});
