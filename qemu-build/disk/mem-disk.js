// Scratch guest disk: the qcow2 template held in memory, in pages, so a tab
// that keeps nothing still runs on a real disk instead of tmpfs. Nothing
// survives the tab, and the OPFS disk is never touched.
//
// "Keep this machine" turns a scratch tab persistent without a reboot:
// promote() copies the pages into a new OPFS disk while the guest keeps
// writing, then re-copies what changed and switches the mount in one task.
// Guest I/O reaches the disk through the main thread, so no guest write can
// land between the last copy and the switch: the guest never sees a change.
//
// "Fork this machine" and the reverse of keeping (a tab giving up the saved
// disk) both take copyOf(): a synchronous, so point-in-time, copy of a disk.

import { DiskError, ERRNO } from './opfs-disk.js';

export const PAGE_BYTES = 1 << 20;
// Pages live in the page's memory, beside the emulator's 3000 MB heap.
// Past this the guest gets ENOSPC, before the tab runs out of memory.
export const SCRATCH_LIMIT_BYTES = 2 * 1024 ** 3;

// Word-wise where the view is aligned: a fork scans the whole disk.
function isZero(bytes) {
  let i = 0;
  if (bytes.byteOffset % 4 === 0) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
    for (const w of words) if (w !== 0) return false;
    i = words.length << 2;
  }
  for (; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}

export class MemDisk {
  constructor(image, { limit = SCRATCH_LIMIT_BYTES, pageBytes = PAGE_BYTES } = {}) {
    this.pageBytes = pageBytes;
    this.limit = limit;
    this.size = image.length;
    this.pages = new Map();
    for (let i = 0, at = 0; at < image.length; i++, at += pageBytes) {
      const part = image.subarray(at, at + pageBytes);
      if (!isZero(part)) this.page(i).set(part);
    }
    // While a promotion runs: pages written since it began, and the smallest
    // size the disk had meanwhile.
    this.changed = null;
    this.minSize = this.size;
  }

  // A copy of any disk with read(buffer, offset, length, position): an
  // OpfsDisk or a MemDisk. Synchronous, so no guest write lands mid-copy;
  // ENOSPC when the copy would pass the limit.
  static copyOf(source, options) {
    const copy = new MemDisk(new Uint8Array(0), options);
    const buf = new Uint8Array(copy.pageBytes);
    for (let i = 0, at = 0; at < source.size; i++, at += copy.pageBytes) {
      const part = buf.subarray(0, source.read(buf, 0, Math.min(copy.pageBytes, source.size - at), at));
      if (!isZero(part)) copy.page(i).set(part);
    }
    copy.size = copy.minSize = source.size;
    return copy;
  }

  // From a File or Blob holding an image, a page at a time.
  static async fromFile(file, options) {
    const disk = new MemDisk(new Uint8Array(0), options);
    for (let i = 0, at = 0; at < file.size; i++, at += disk.pageBytes) {
      const part = new Uint8Array(await file.slice(at, at + disk.pageBytes).arrayBuffer());
      if (!isZero(part)) disk.page(i).set(part);
    }
    disk.size = disk.minSize = file.size;
    return disk;
  }

  // Into a FileSystemWritableFileStream; gaps between pages read as zeros.
  async writeTo(writable) {
    for (const i of [...this.pages.keys()].sort((a, b) => a - b)) {
      const at = i * this.pageBytes;
      await writable.write({ type: 'write', position: at, data: this.pages.get(i).subarray(0, Math.min(this.pageBytes, this.size - at)) });
    }
    await writable.truncate(this.size);
  }

  get bytesHeld() { return this.pages.size * this.pageBytes; }

  page(i) {
    let page = this.pages.get(i);
    if (!page) {
      if (this.bytesHeld + this.pageBytes > this.limit) throw new DiskError(ERRNO.ENOSPC, 'scratch disk is full');
      page = new Uint8Array(this.pageBytes);
      this.pages.set(i, page);
    }
    return page;
  }

  // buffer is an Int8Array (Emscripten's HEAP8) or a Uint8Array.
  read(buffer, offset, length, position) {
    length = Math.max(0, Math.min(length, this.size - position));
    const out = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
    for (let done = 0; done < length;) {
      const at = position + done;
      const i = Math.floor(at / this.pageBytes);
      const within = at - i * this.pageBytes;
      const n = Math.min(length - done, this.pageBytes - within);
      const page = this.pages.get(i);
      if (page) out.set(page.subarray(within, within + n), done);
      else out.fill(0, done, done + n);
      done += n;
    }
    return length;
  }

  write(buffer, offset, length, position) {
    const src = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
    let done = 0;
    try {
      while (done < length) {
        const at = position + done;
        const i = Math.floor(at / this.pageBytes);
        const within = at - i * this.pageBytes;
        const n = Math.min(length - done, this.pageBytes - within);
        this.page(i).set(src.subarray(done, done + n), within);
        this.changed?.add(i);
        done += n;
        this.size = Math.max(this.size, at + n);
      }
    } catch (error) {
      if (done === 0) throw error;
    }
    return done;
  }

  truncate(size) {
    if (size < this.size) {
      const keep = Math.ceil(size / this.pageBytes);
      for (const i of [...this.pages.keys()]) if (i >= keep) this.pages.delete(i);
      const tail = size % this.pageBytes;
      const last = this.pages.get(keep - 1);
      if (tail && last) last.fill(0, tail);
      this.minSize = Math.min(this.minSize, size);
    }
    this.size = size;
  }

  flush() {}
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

function copyPage(from, to, i) {
  const at = i * from.pageBytes;
  const n = Math.min(from.pageBytes, from.size - at);
  const page = from.pages.get(i);
  if (n > 0 && page && to.write(page, 0, n, at) !== n) throw new DiskError(ERRNO.ENOSPC, 'disk is full');
}

// Copies the scratch disk `from` into `to` (an empty-able disk with the same
// read/write/truncate interface, normally a new OpfsDisk) while the guest keeps
// writing to `from`, then calls swap(to) in the same task as the final copy.
// Yields to the page every pagesPerStep pages, through pause().
export async function promote(from, to, { swap, pause = nextTask, pagesPerStep = 4, onProgress = () => {} }) {
  from.changed = new Set();
  from.minSize = from.size;
  try {
    to.truncate(0);
    const pages = [...from.pages.keys()].sort((a, b) => a - b);
    for (let k = 0; k < pages.length; k++) {
      copyPage(from, to, pages[k]);
      if ((k + 1) % pagesPerStep === 0 && k + 1 < pages.length) {
        onProgress(k + 1, pages.length);
        await pause();
      }
    }
    // Nothing below yields, so the guest cannot write until swap() has run.
    // A shrink during the copy leaves stale pages past minSize: cut them, then
    // re-copy every page written since the copy began.
    if (to.size > from.minSize) to.truncate(from.minSize);
    for (const i of [...from.changed].sort((a, b) => a - b)) copyPage(from, to, i);
    to.truncate(from.size);
    swap(to);
  } finally {
    from.changed = null;
  }
}
