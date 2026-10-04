// Dirty-chunk tracking and consistent snapshots of the persistent disk, for the
// storage ladder's replicas (Folder now, Crate later). Pure logic: the disk
// worker supplies chunk reads, bitmap persistence and a message sink.
//
// A snapshot is point-in-time. begin() takes the dirty set and clears it; the
// chunks then leave in idle moments via pump(), a few at a time. If the guest
// writes into a chunk that has not left yet, beforeWrite() first keeps a copy
// of its snapshot-time bytes. The replica therefore receives exactly the disk
// as it was at begin(): crash-consistent, like a closed tab.
//
// Progress comes back through a shared Int32Array written by the replica:
// INFLIGHT counts chunks sent but not yet stored; COMMITTED and FAILED name the
// last snapshot that landed or failed. A failed snapshot's chunks turn dirty again.

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const REPL = { INFLIGHT: 0, COMMITTED: 1, FAILED: 2 };

const chunksFor = (size, chunkBytes) => Math.ceil(size / chunkBytes);

export class ChunkTracker {
  // dirty: the persisted bitmap (one byte per chunk), or null when none was
  // kept, in which case every chunk starts dirty.
  constructor({ size, dirty, readChunk, persist, send, repl, chunkBytes = CHUNK_BYTES, maxInflight = 4, seq = 0 }) {
    Object.assign(this, { readChunk, persist, send, repl, chunkBytes, maxInflight, seq });
    const count = chunksFor(size, chunkBytes);
    this.dirty = new Uint8Array(count);
    if (dirty) this.dirty.set(dirty.subarray(0, count));
    else this.dirty.fill(1);
    if (dirty && dirty.length < count) this.dirty.fill(1, dirty.length);
    this.snap = null;
    this.cow = new Map();
  }

  get active() { return this.snap !== null; }

  // Call before a write of len bytes at pos lands on the disk.
  beforeWrite(pos, len) {
    if (len <= 0) return;
    const first = Math.floor(pos / this.chunkBytes);
    const last = Math.floor((pos + len - 1) / this.chunkBytes);
    this.#preserveAndMark(first, last);
  }

  // Call before the disk is truncated or extended to size.
  beforeTruncate(oldSize, size) {
    const from = Math.floor(Math.min(oldSize, size) / this.chunkBytes);
    const to = Math.max(chunksFor(oldSize, this.chunkBytes), chunksFor(size, this.chunkBytes)) - 1;
    if (to >= from) this.#preserveAndMark(from, to);
  }

  #preserveAndMark(first, last) {
    if (last >= this.dirty.length) {
      const grown = new Uint8Array(last + 1);
      grown.set(this.dirty);
      this.dirty = grown;
    }
    let changed = false;
    for (let c = first; c <= last; c++) {
      if (this.snap && this.snap.pending.has(c) && !this.cow.has(c)) this.cow.set(c, this.readChunk(c, this.snap.size));
      if (!this.dirty[c]) { this.dirty[c] = 1; changed = true; }
    }
    if (changed) this.persist(this.dirty);
  }

  markAll() {
    this.dirty.fill(1);
    this.persist(this.dirty);
  }

  // Starts a snapshot of a disk of size bytes. Returns its chunk count, or -1
  // while the previous snapshot is still in flight.
  begin(size) {
    this.settle();
    if (this.snap) return -1;
    const count = chunksFor(size, this.chunkBytes);
    const list = [];
    for (let c = 0; c < Math.min(count, this.dirty.length); c++) if (this.dirty[c]) list.push(c);
    for (const c of list) this.dirty[c] = 0;
    this.persist(this.dirty);
    this.snap = { seq: ++this.seq, size, list, next: 0, pending: new Set(list), ended: false };
    this.send({ type: 'begin', seq: this.seq, size, chunkBytes: this.chunkBytes, count: list.length });
    return list.length;
  }

  // Sends what the replica has room for. Returns whether a snapshot is still open.
  pump() {
    this.settle();
    const snap = this.snap;
    if (!snap) return false;
    while (snap.next < snap.list.length && Atomics.load(this.repl, REPL.INFLIGHT) < this.maxInflight) {
      const c = snap.list[snap.next++];
      const bytes = this.cow.get(c) ?? this.readChunk(c, snap.size);
      this.cow.delete(c);
      snap.pending.delete(c);
      Atomics.add(this.repl, REPL.INFLIGHT, 1);
      this.send({ type: 'chunk', seq: snap.seq, index: c, bytes }, [bytes.buffer]);
    }
    if (snap.next === snap.list.length && !snap.ended) {
      snap.ended = true;
      this.send({ type: 'end', seq: snap.seq });
    }
    return true;
  }

  // Closes the snapshot once the replica reports on it.
  settle() {
    const snap = this.snap;
    if (!snap) return;
    if (Atomics.load(this.repl, REPL.FAILED) === snap.seq) {
      for (const c of snap.list) if (c < this.dirty.length) this.dirty[c] = 1;
      this.persist(this.dirty);
      this.cow.clear();
      this.snap = null;
    } else if (Atomics.load(this.repl, REPL.COMMITTED) === snap.seq) {
      this.snap = null;
    }
  }
}
