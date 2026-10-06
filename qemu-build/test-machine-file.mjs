// Host checks for machine files (disk/machine-file.js): a disk and a RAM state
// written as one gzip stream and read back unchanged.
// Run: node qemu-build/test-machine-file.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { MACHINE_MAGIC, readMachine, writeMachine } from './disk/machine-file.js';
import { MemDisk } from './disk/mem-disk.js';

const PAGE = 4096;
const contents = (disk) => { const out = new Uint8Array(disk.size); disk.read(out, 0, disk.size, 0); return out; };

function sample(pages, seed) {
  const disk = new MemDisk(new Uint8Array(0), { pageBytes: PAGE });
  for (let i = 0; i < pages; i += 2) {
    const bytes = Uint8Array.from({ length: PAGE }, (_, j) => (i * 31 + j * seed) & 0xff || 1);
    disk.write(bytes, 0, PAGE, i * PAGE);
  }
  disk.write(new Uint8Array([9, 9]), 0, 2, pages * PAGE + 100); // a short tail page
  return disk;
}

// A WritableStream that keeps what it is given, as a file would.
function sink() {
  const parts = [];
  const stream = new WritableStream({ write(chunk) { parts.push(chunk); } });
  return { stream, blob: () => new Blob(parts) };
}

test('a machine written and read back has the same disk, state and header', async () => {
  const disk = sample(9, 7);
  const state = sample(5, 13);
  const out = sink();
  await writeMachine(out.stream, { disk, state, header: { engine: 'karkhana-engine-test', savedAt: 1 } });
  const blob = out.blob();
  assert.ok(blob.size < disk.size + state.size, 'compressed');
  const back = await readMachine(blob, { pageBytes: PAGE });
  assert.equal(back.header.engine, 'karkhana-engine-test');
  assert.equal(back.header.format, 1);
  assert.deepEqual(contents(back.disk), contents(disk));
  assert.deepEqual(contents(back.state), contents(state));
  assert.ok(!back.disk.pages.has(1), 'a gap stays a gap');
});

test('a file that is not a machine, or ends early, is refused', async () => {
  const gz = (text) => new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const blobOf = async (stream) => new Blob([await new Response(stream).arrayBuffer()]);
  await assert.rejects(readMachine(await blobOf(gz('hello\n{}\n'))), /not a Karkhana machine file/);
  const head = `${MACHINE_MAGIC}\n${JSON.stringify({ format: 1, diskBytes: 3 * PAGE, stateBytes: PAGE })}\n`;
  await assert.rejects(readMachine(await blobOf(gz(head + 'short'))), /ends early/);
});
