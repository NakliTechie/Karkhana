// Host checks for the scratch disk and its promotion (disk/mem-disk.js): the
// in-memory disk a scratch tab runs on, and the copy that moves a running guest
// onto a persistent disk without a reboot.
// Run: node qemu-build/test-mem-disk.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { DiskError, ERRNO } from './disk/opfs-disk.js';
import { MemDisk, promote } from './disk/mem-disk.js';

const PAGE = 256;

// A deterministic generator, so a failing interleaving can be replayed.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return (n) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s % n; };
}

const contents = (disk) => {
  const out = new Uint8Array(disk.size);
  disk.read(out, 0, disk.size, 0);
  return out;
};

const image = (pages, fill = (i) => (i * 7 + 3) & 0xff) => Uint8Array.from({ length: pages * PAGE + 17 }, (_, i) => fill(i));

test('a scratch disk reads back its image and holds no all-zero pages', () => {
  const bytes = image(4);
  bytes.fill(0, PAGE, 2 * PAGE);
  const disk = new MemDisk(bytes, { pageBytes: PAGE });
  assert.equal(disk.size, bytes.length);
  assert.deepEqual([...disk.pages.keys()], [0, 2, 3, 4]);
  assert.deepEqual(contents(disk), bytes);
});

test('reads and writes cross pages through HEAP8-style views', () => {
  const disk = new MemDisk(image(2), { pageBytes: PAGE });
  const heap = new Int8Array(new SharedArrayBuffer(4 * PAGE));
  for (let i = 0; i < 3 * PAGE; i++) heap[10 + i] = (i * 13) & 0xff;
  assert.equal(disk.write(heap, 10, 3 * PAGE, PAGE - 5), 3 * PAGE);
  assert.equal(disk.size, 4 * PAGE - 5);
  const out = new Int8Array(new SharedArrayBuffer(4 * PAGE));
  assert.equal(disk.read(out, 1, 3 * PAGE, PAGE - 5), 3 * PAGE);
  assert.deepEqual(out.subarray(1, 1 + 3 * PAGE), heap.subarray(10, 10 + 3 * PAGE));
  assert.equal(disk.read(out, 0, 64, disk.size + 3), 0, 'reads stop at the end');
});

test('a gap reads as zeros, and a shrink then regrow does not bring old bytes back', () => {
  const disk = new MemDisk(image(1), { pageBytes: PAGE });
  disk.write(new Uint8Array([9]), 0, 1, 10 * PAGE);
  const gap = new Uint8Array(PAGE);
  disk.read(gap, 0, PAGE, 5 * PAGE);
  assert.ok(gap.every((b) => b === 0));
  assert.ok(!disk.pages.has(5), 'reading a gap allocates nothing');
  disk.truncate(PAGE / 2);
  assert.deepEqual([...disk.pages.keys()], [0]);
  disk.truncate(3 * PAGE);
  const back = contents(disk);
  assert.deepEqual(back.subarray(0, PAGE / 2), image(1).subarray(0, PAGE / 2));
  assert.ok(back.subarray(PAGE / 2).every((b) => b === 0));
});

test('the memory limit surfaces as ENOSPC, after a short write', () => {
  const disk = new MemDisk(new Uint8Array(PAGE).fill(1), { pageBytes: PAGE, limit: 3 * PAGE });
  const buf = new Uint8Array(4 * PAGE).fill(2);
  assert.equal(disk.write(buf, 0, 4 * PAGE, PAGE), 2 * PAGE, 'two more pages fit');
  assert.throws(() => disk.write(buf, 0, 1, 3 * PAGE), (e) => e instanceof DiskError && e.errno === ERRNO.ENOSPC);
  assert.equal(disk.write(buf, 0, 8, 8), 8, 'held pages stay writable');
});

// The guest's side of a promotion: random writes, growth and the odd shrink,
// run at every point where promote() yields.
function guest(disk, next) {
  return () => {
    for (let n = next(4); n > 0; n--) {
      const roll = next(20);
      if (roll === 0) disk.truncate(next(disk.size + 1));
      else if (roll === 1) disk.truncate(disk.size + next(3 * PAGE));
      else {
        const len = 1 + next(2 * PAGE);
        const at = next(disk.size + PAGE);
        disk.write(Uint8Array.from({ length: len }, () => next(256)), 0, len, at);
      }
    }
    return Promise.resolve();
  };
}

test('promotion copies a disk the guest keeps writing, and swaps in the same task', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = rng(seed);
    const from = new MemDisk(image(6 + next(20)), { pageBytes: PAGE });
    const to = new MemDisk(new Uint8Array(3 * PAGE).fill(0xee), { pageBytes: PAGE });
    let swapped = null;
    await promote(from, to, {
      pagesPerStep: 1 + next(3),
      pause: guest(from, next),
      swap: (disk) => { swapped = { disk, at: contents(from) }; },
    });
    assert.equal(swapped?.disk, to, `seed ${seed}: swap() received the new disk`);
    assert.equal(to.size, from.size, `seed ${seed}: size`);
    assert.deepEqual(contents(to), swapped.at, `seed ${seed}: the new disk equals the guest's disk at the swap`);
    assert.equal(from.changed, null, 'tracking stops');
  }
});

test('a failed copy leaves the guest on its scratch disk', async () => {
  const from = new MemDisk(image(8), { pageBytes: PAGE });
  const to = new MemDisk(new Uint8Array(0), { pageBytes: PAGE, limit: 3 * PAGE });
  let swapped = false;
  await assert.rejects(promote(from, to, { swap: () => { swapped = true; } }), (e) => e.errno === ERRNO.ENOSPC);
  assert.equal(swapped, false);
  assert.equal(from.changed, null);
  assert.deepEqual(contents(from), image(8));
});

test('copyOf takes a disk as it stands, page by page, and skips zero pages', () => {
  const source = new MemDisk(image(5), { pageBytes: PAGE });
  source.write(new Uint8Array(PAGE), 0, PAGE, 2 * PAGE); // page 2 now all zeros
  const copy = MemDisk.copyOf(source, { pageBytes: PAGE });
  assert.equal(copy.size, source.size);
  assert.ok(!copy.pages.has(2), 'a zero page is not held');
  assert.deepEqual(contents(copy), contents(source));
  copy.write(new Uint8Array([1, 2, 3]), 0, 3, 0);
  assert.notDeepEqual(contents(copy), contents(source), 'the copy is independent');
  assert.throws(() => MemDisk.copyOf(source, { pageBytes: PAGE, limit: 2 * PAGE }), (e) => e.errno === ERRNO.ENOSPC);
});

test('a disk written to a file and read back is the same disk, gaps included', async () => {
  const disk = new MemDisk(image(3), { pageBytes: PAGE });
  disk.write(new Uint8Array([7]), 0, 1, 9 * PAGE + 3);
  let file = new Uint8Array(0);
  const writable = {
    async write({ type, position, data }) {
      assert.equal(type, 'write');
      if (position + data.length > file.length) { const grown = new Uint8Array(position + data.length); grown.set(file); file = grown; }
      file.set(data, position);
    },
    async truncate(size) { const t = new Uint8Array(size); t.set(file.subarray(0, size)); file = t; },
  };
  await disk.writeTo(writable);
  assert.equal(file.length, disk.size);
  const back = await MemDisk.fromFile(new Blob([file]), { pageBytes: PAGE });
  assert.deepEqual([...back.pages.keys()].sort((a, b) => a - b), [...disk.pages.keys()].sort((a, b) => a - b));
  assert.deepEqual(contents(back), contents(disk));
});
