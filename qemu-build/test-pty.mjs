// Exercise the shipped glue without loading QEMU or allocating its 3 GiB heap.
// KARKHANA_PTY_SOURCE can point at `git show HEAD:out.js` for regression checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

const source = readFileSync(
  process.env.KARKHANA_PTY_SOURCE || new URL('../out.js', import.meta.url), 'utf8',
);

function between(start, end) {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, `Missing generated-code anchor: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, `Missing generated-code anchor: ${end}`);
  return source.slice(first, last);
}

const readSource = `var read = ({${between(
  '    read: (stream, buffer, offset, length) => {',
  '    write: (stream, buffer, offset, length) => {',
)}}).read;`;
const callbackSource = between(
  'var PTY_waitForReadableWithCallback =',
  'var PTY_waitForReadableWithAtomicImpl =',
);
const atomicSource = between('var PTY_atomicIndex =', 'var PTY_waitForReadable =');

class ErrnoError extends Error {
  constructor(errno) {
    super(`errno ${errno}`);
    this.errno = errno;
  }
}

function reader(bytes = []) {
  const pending = [...bytes];
  const waits = [];
  const context = {
    FS: { ErrnoError },
    PTY: { read: length => pending.splice(0, length) },
    PTY_askToWaitAgain(timeout) {
      waits.push(timeout);
      throw new ErrnoError(1006);
    },
  };
  vm.runInNewContext(readSource, context);
  return { read: context.read, waits, pending };
}

test('empty nonblocking TTY read returns EAGAIN without starting a wait', () => {
  const { read, waits } = reader();
  assert.throws(() => read({ flags: 2048 }, new Uint8Array(4), 0, 4),
    error => error.errno === 6);
  assert.deepEqual(waits, []);
});

test('empty blocking TTY read retains the indefinite-wait sentinel', () => {
  const { read, waits } = reader();
  assert.throws(() => read({ flags: 0 }, new Uint8Array(4), 0, 4),
    error => error.errno === 1006);
  assert.deepEqual(waits, [-1]);
});

test('zero-length reads neither wait nor consume queued bytes', () => {
  for (const flags of [0, 2048]) {
    const { read, waits, pending } = reader([128]);
    const target = new Uint8Array([7, 8]);
    assert.equal(read({ flags }, target, 1, 0), 0);
    assert.deepEqual(target, new Uint8Array([7, 8]));
    assert.deepEqual(pending, [128]);
    assert.deepEqual(waits, []);
  }
});

test('populated reads preserve byte values, length, and destination offset', () => {
  for (const flags of [0, 2048]) {
    const { read, waits, pending } = reader([0, 128, 255]);
    const target = new Uint8Array([9, 9, 9, 9]);
    assert.equal(read({ flags }, target, 1, 2), 2);
    assert.deepEqual(target, new Uint8Array([9, 0, 128, 9]));
    assert.deepEqual(pending, [255]);
    assert.deepEqual(waits, []);
  }
});

function waiter({ readable = false, timeout = -1 } = {}) {
  const readableListeners = new Set();
  const signalListeners = new Set();
  const timers = new Map();
  let nextTimer = 1;
  const register = listeners => callback => {
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  };
  const pty = {
    readable,
    onReadable: register(readableListeners),
    onSignal: register(signalListeners),
  };
  const context = {
    PTY: pty,
    PTY_pollTimeout: timeout,
    Promise,
    setTimeout(callback, delay, ...args) {
      const id = nextTimer++;
      timers.set(id, { callback, delay, args });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(callbackSource, context);
  return {
    wait: context.PTY_waitForReadableWithCallback,
    timers,
    makeReadable() {
      pty.readable = true;
      for (const callback of [...readableListeners]) callback();
    },
    signal() {
      for (const callback of [...signalListeners]) callback('SIGWINCH');
    },
    assertClean() {
      assert.equal(readableListeners.size, 0, 'readability handler leaked');
      assert.equal(signalListeners.size, 0, 'signal handler leaked');
      assert.equal(timers.size, 0, 'timeout leaked');
    },
  };
}

test('data arriving before waiter registration wakes immediately', () => {
  for (const timeout of [-1, 25]) {
    const w = waiter({ readable: true, timeout });
    const results = [];
    w.wait(type => results.push(type));
    assert.deepEqual(results, [0]);
    w.assertClean();
  }
});

test('data arriving after registration wakes once and removes listeners and timer', async () => {
  const w = waiter({ timeout: 25 });
  const results = [];
  w.wait(type => results.push(type));
  assert.deepEqual(results, []);
  w.makeReadable();
  await Promise.resolve();
  assert.deepEqual(results, [0]);
  w.assertClean();
  w.makeReadable();
  w.signal();
  await Promise.resolve();
  assert.deepEqual(results, [0]);
});

test('poll timeout wakes with timeout status and cleans up', async () => {
  const w = waiter({ timeout: 25 });
  const results = [];
  w.wait(type => results.push(type));
  assert.equal(w.timers.size, 1);
  const timer = [...w.timers.values()][0];
  assert.equal(timer.delay, 25);
  timer.callback(...timer.args);
  await Promise.resolve();
  assert.deepEqual(results, [2]);
  w.assertClean();
});

test('signal wakes with interrupted status and cancels the pending timeout', async () => {
  const w = waiter({ timeout: 25 });
  const results = [];
  w.wait(type => results.push(type));
  w.signal();
  await Promise.resolve();
  assert.deepEqual(results, [1]);
  w.assertClean();
});

test('zero-timeout poll returns immediately without registering listeners', () => {
  for (const readable of [false, true]) {
    const w = waiter({ timeout: 0, readable });
    const results = [];
    w.wait(type => results.push(type));
    assert.deepEqual(results, [readable ? 0 : 2]);
    w.assertClean();
  }
});

test('an allocation above 2 GiB keeps its unsigned word index through Atomics', () => {
  const pointer = 0x80000040;
  const wordIndex = pointer / 4;
  const physical = new Int32Array(new SharedArrayBuffer(4));
  // Map one logical high-address word onto a real, four-byte shared allocation.
  // Every access validates the original generated index before mapping it.
  function mappedIndex(index) {
    assert.equal(Number(index), wordIndex, 'pointer lost its unsigned word index');
    return 0;
  }
  const heap = new Proxy({}, {
    get: (_, index) => physical[mappedIndex(index)],
    set(_, index, value) {
      physical[mappedIndex(index)] = value;
      return true;
    },
  });
  let allocations = 0;
  const results = [];
  const waits = [];
  const atomics = {
    store: (_, index, value) => Atomics.store(physical, mappedIndex(index), value),
    load: (_, index) => Atomics.load(physical, mappedIndex(index)),
    notify: (_, index) => Atomics.notify(physical, mappedIndex(index)),
    wait(_, index, expected) {
      const result = Atomics.wait(physical, mappedIndex(index), expected, 100);
      waits.push(result);
      return result;
    },
  };
  const context = {
    HEAP32: heap,
    Atomics: atomics,
    _malloc(size) {
      assert.equal(size, 4);
      allocations++;
      return pointer;
    },
    PTY_waitForReadableWithAtomicImpl(index) {
      atomics.store(heap, index, 0);
      atomics.notify(heap, index);
    },
  };
  vm.runInNewContext(atomicSource, context);
  context.PTY_waitForReadableWithAtomic(type => results.push(type));
  context.PTY_waitForReadableWithAtomic(type => results.push(type));
  assert.deepEqual(results, [0, 0]);
  assert.deepEqual(waits, ['not-equal', 'not-equal']);
  assert.equal(allocations, 1, 'the worker must reuse its atomic slot');
});

test('a real worker receives a shared-memory wake without waiting indefinitely',
  { timeout: 5000 }, async t => {
    const buffer = new SharedArrayBuffer(8);
    const heap = new Int32Array(buffer);
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const vm = require('node:vm');
      const heap = new Int32Array(workerData.buffer);
      let waitResult;
      const context = {
        HEAP32: heap,
        _malloc: () => 4,
        PTY_waitForReadableWithAtomicImpl(index) {
          parentPort.postMessage({ type: 'registered', index });
        },
        Atomics: {
          store: Atomics.store,
          load: Atomics.load,
          wait(view, index, expected) {
            waitResult = Atomics.wait(view, index, expected, 2000);
            return waitResult;
          },
        },
      };
      vm.runInNewContext(workerData.source, context);
      context.PTY_waitForReadableWithAtomic(value => {
        parentPort.postMessage({ type: 'done', value, waitResult });
      });
    `, { eval: true, workerData: { buffer, source: atomicSource } });
    let timer;
    t.after(async () => {
      clearTimeout(timer);
      await worker.terminate();
    });
    const result = await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('exit', code => {
        if (code !== 0) reject(new Error(`PTY worker exited with ${code}`));
      });
      worker.on('message', message => {
        if (message.type === 'registered') {
          timer = setTimeout(() => {
            Atomics.store(heap, message.index, 0);
            Atomics.notify(heap, message.index);
          }, 20);
        } else if (message.type === 'done') {
          resolve(message);
        }
      });
    });
    assert.equal(result.value, 0);
    // Either scheduling order is valid; a store before wait must also be safe.
    assert.ok(['ok', 'not-equal'].includes(result.waitResult), result.waitResult);
  });
