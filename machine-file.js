// A machine file: one running Karkhana machine, its disk and its RAM, as they
// stood at one instant, so another browser or device can resume it mid-command.
//
// Layout, gzip-compressed: a magic line, a JSON header line, the disk image
// (diskBytes), then QEMU's migration stream (stateBytes). Both parts travel as
// MemDisks (mem-disk.js): pages of memory, with all-zero pages never held.

import { MemDisk } from './mem-disk.js';

export const MACHINE_MAGIC = 'karkhana-machine 1';

const textOf = (s) => new TextEncoder().encode(s);

// Each page of a disk in order, zeros for pages it does not hold.
function* pagesOf(disk) {
  const zeros = new Uint8Array(disk.pageBytes);
  for (let i = 0, at = 0; at < disk.size; i++, at += disk.pageBytes) {
    yield (disk.pages.get(i) || zeros).subarray(0, Math.min(disk.pageBytes, disk.size - at));
  }
}

// Writes a machine to a WritableStream (an OPFS or picked file's writable),
// which it closes. header is stored as given, beside the two sizes.
export async function writeMachine(writable, { disk, state, header = {} }) {
  const head = { ...header, format: 1, diskBytes: disk.size, stateBytes: state.size };
  const parts = (function* () {
    yield textOf(MACHINE_MAGIC + '\n' + JSON.stringify(head) + '\n');
    yield* pagesOf(disk);
    yield* pagesOf(state);
  })();
  const source = new ReadableStream({
    pull(controller) {
      const next = parts.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value.slice());
    },
  });
  await source.pipeThrough(new CompressionStream('gzip')).pipeTo(writable);
}

// Exact reads from a byte stream.
class Bytes {
  constructor(stream) {
    this.reader = stream.getReader();
    this.chunk = new Uint8Array(0);
  }

  async fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error('the machine file ends early');
    this.chunk = value;
  }

  async line() {
    const parts = [];
    for (;;) {
      if (!this.chunk.length) await this.fill();
      const end = this.chunk.indexOf(10);
      if (end >= 0) {
        parts.push(this.chunk.subarray(0, end));
        this.chunk = this.chunk.subarray(end + 1);
        return new TextDecoder().decode(concat(parts));
      }
      parts.push(this.chunk);
      this.chunk = new Uint8Array(0);
      if (parts.reduce((n, p) => n + p.length, 0) > 1 << 20) throw new Error('not a machine file');
    }
  }

  async readInto(target) {
    for (let at = 0; at < target.length;) {
      if (!this.chunk.length) await this.fill();
      const n = Math.min(this.chunk.length, target.length - at);
      target.set(this.chunk.subarray(0, n), at);
      this.chunk = this.chunk.subarray(n);
      at += n;
    }
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function readDisk(bytes, size, options) {
  const disk = new MemDisk(new Uint8Array(0), options);
  const page = new Uint8Array(disk.pageBytes);
  for (let at = 0; at < size; at += disk.pageBytes) {
    const part = page.subarray(0, Math.min(disk.pageBytes, size - at));
    await bytes.readInto(part);
    if (part.some((b) => b !== 0)) disk.write(part, 0, part.length, at);
  }
  disk.truncate(size);
  disk.minSize = size;
  return disk;
}

// Reads a machine file (a Blob or File). Resolves to { header, disk, state }.
export async function readMachine(blob, options) {
  const bytes = new Bytes(blob.stream().pipeThrough(new DecompressionStream('gzip')));
  if ((await bytes.line()) !== MACHINE_MAGIC) throw new Error('not a Karkhana machine file');
  const header = JSON.parse(await bytes.line());
  const disk = await readDisk(bytes, header.diskBytes, options);
  const state = await readDisk(bytes, header.stateBytes, options);
  return { header, disk, state };
}
