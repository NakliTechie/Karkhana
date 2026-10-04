// A replica of the persistent disk in a directory: the Folder rung of the storage
// ladder (a folder the user picks) or any directory handle with the same API.
//
// Layout under <dir>/karkhana-disk/:
//   manifest.json   { format, diskId, seq, size, chunkBytes, chunks: [sha256 | null], savedAt }
//   chunks/<sha256> one chunk's bytes, stored once however many chunks share them
// A chunk is written before the manifest that names it, and createWritable()
// replaces a file only on close(), so a reader always sees a complete manifest
// whose chunks exist. Chunks no manifest names are deleted after each commit.

import { REPL } from './chunk-tracker.js';

export const FORMAT = 1;
const DIR = 'karkhana-disk';
const enc = new TextEncoder();

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

async function writeFile(dir, name, bytes) {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function readManifest(base) {
  try {
    const file = await (await base.getFileHandle('manifest.json')).getFile();
    const manifest = JSON.parse(await file.text());
    return manifest.format === FORMAT ? manifest : null;
  } catch (error) {
    if (error.name === 'NotFoundError' || error instanceof SyntaxError) return null;
    throw error;
  }
}

// The replica's identity, without opening a writer: { diskId, seq, size, savedAt } or null.
export async function describeReplica(dir) {
  const base = await dir.getDirectoryHandle(DIR).catch(() => null);
  const manifest = base && await readManifest(base);
  return manifest && { diskId: manifest.diskId, seq: manifest.seq, size: manifest.size, savedAt: manifest.savedAt };
}

// Receives a ChunkTracker's messages and keeps the replica current. Rejects a
// directory that already holds another disk's replica: overwriting it would
// destroy that backup.
export class Replica {
  static async open(dir, diskId) {
    const base = await dir.getDirectoryHandle(DIR, { create: true });
    const chunks = await base.getDirectoryHandle('chunks', { create: true });
    const manifest = await readManifest(base);
    if (manifest && manifest.diskId !== diskId) {
      throw Object.assign(new Error('this folder holds a backup of another Karkhana disk'), { code: 'other-disk', diskId: manifest.diskId });
    }
    return new Replica(base, chunks, manifest || { format: FORMAT, diskId, seq: 0, size: 0, chunkBytes: 0, chunks: [], savedAt: null });
  }

  constructor(base, chunks, manifest) {
    Object.assign(this, { base, chunks, committed: manifest, draft: null, failed: null, queue: Promise.resolve() });
    this.stats = { commits: 0, chunksWritten: 0, bytesWritten: 0, lastError: null };
  }

  // Messages are handled strictly in order; repl is the tracker's shared array.
  receive(message, repl) {
    this.queue = this.queue.then(() => this.#handle(message, repl)).catch((error) => {
      this.stats.lastError = error.message;
      this.failed = message.seq;
      this.draft = null;
      Atomics.store(repl, REPL.FAILED, message.seq);
    });
    return this.queue;
  }

  async #handle(message, repl) {
    if (message.type === 'chunk') Atomics.sub(repl, REPL.INFLIGHT, 1);
    if (message.seq === this.failed) return;
    if (message.type === 'begin') {
      const count = Math.ceil(message.size / message.chunkBytes);
      if (this.committed.chunkBytes && this.committed.chunkBytes !== message.chunkBytes) throw new Error('chunk size changed');
      const chunks = this.committed.chunks.slice(0, count);
      while (chunks.length < count) chunks.push(null);
      this.draft = { ...this.committed, size: message.size, chunkBytes: message.chunkBytes, chunks };
    } else if (message.type === 'chunk') {
      const hash = await sha256Hex(message.bytes);
      if (!(await this.chunks.getFileHandle(hash).catch(() => null))) {
        await writeFile(this.chunks, hash, message.bytes);
        this.stats.chunksWritten++;
        this.stats.bytesWritten += message.bytes.byteLength;
      }
      this.draft.chunks[message.index] = hash;
    } else if (message.type === 'end') {
      const manifest = { ...this.draft, seq: this.committed.seq + 1, savedAt: new Date().toISOString() };
      await writeFile(this.base, 'manifest.json', enc.encode(JSON.stringify(manifest)));
      this.committed = manifest;
      this.draft = null;
      this.stats.commits++;
      Atomics.store(repl, REPL.COMMITTED, message.seq);
      await this.#collect();
    }
  }

  async #collect() {
    const live = new Set(this.committed.chunks);
    const stale = [];
    for await (const name of this.chunks.keys()) if (!live.has(name)) stale.push(name);
    for (const name of stale) await this.chunks.removeEntry(name);
  }
}

// Writes the replica's disk image to a sync access handle (truncated first).
// Returns { diskId, size }. Chunks the manifest never filled are zeros.
export async function restoreReplica(dir, handle) {
  const base = await dir.getDirectoryHandle(DIR);
  const manifest = await readManifest(base);
  if (!manifest) throw new Error('no Karkhana disk backup in this folder');
  const chunks = await base.getDirectoryHandle('chunks');
  handle.truncate(0);
  handle.truncate(manifest.size);
  for (let index = 0; index < manifest.chunks.length; index++) {
    const hash = manifest.chunks[index];
    if (!hash) continue;
    const bytes = new Uint8Array(await (await (await chunks.getFileHandle(hash)).getFile()).arrayBuffer());
    if (await sha256Hex(bytes) !== hash) throw new Error(`backup chunk ${index} is damaged`);
    handle.write(bytes, { at: index * manifest.chunkBytes });
  }
  handle.flush();
  return { diskId: manifest.diskId, size: manifest.size };
}
