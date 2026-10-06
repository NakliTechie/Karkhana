// Scratch guest disk: the qcow2 template held in memory, in pages, so a tab
// that keeps nothing still runs on a real disk instead of tmpfs. Nothing
// survives the tab, and the OPFS disk is never touched.
//
// "Keep this machine" turns a scratch tab persistent without a reboot:
// promote() copies the pages into a new OPFS disk while the guest keeps
// writing, then re-copies what changed and switches the mount in one task.
// Guest I/O reaches the disk through the main thread, so no guest write can
// land between the last copy and the switch: the guest never sees a change.

import { DiskError, ERRNO } from './opfs-disk.js';

export const PAGE_BYTES = 1 << 20;
// Pages live in the page's memory, beside the emulator's 3000 MB heap.
// Past this the guest gets ENOSPC, before the tab runs out of memory.
export const SCRATCH_LIMIT_BYTES = 2 * 1024 ** 3;

const isZero = (bytes) => bytes.every((b) => b === 0);

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
