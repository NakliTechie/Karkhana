// Holds the persistent disk's OPFS sync access handle and serves the main
// thread's requests (see opfs-disk.js). Runs as a module worker.
import { CTL, ERRNO, FILLING, META, OP, STATE, fetchDiskTemplate, isQcow2 } from './opfs-disk.js';
import { ChunkTracker } from './chunk-tracker.js';
import { restoreReplica } from './replica.js';

// A write marks the handle dirty; it is flushed after this much idle time.
// Tab closes need no flush (written bytes are already in the file); an OS
// crash does, and so does the guest's own fsync.
const FLUSH_DELAY_MS = 1000;
// While a snapshot is open, idle moments of this length send its next chunks.
const PUMP_MS = 10;

self.onmessage = async ({ data }) => {
  self.onmessage = null;
  let disk;
  try {
    disk = await open(data);
  } catch (error) {
    const code = error.name === 'NoModificationAllowedError' ? 'busy' : 'failed';
    self.postMessage({ ok: false, code, error: `${error.name}: ${error.message}` });
    return;
  }
  const { handle, created, restored, diskId } = disk;
  self.postMessage({ ok: true, size: handle.getSize(), created, restored, diskId });
  serve(disk, new Int32Array(data.ctl), new Float64Array(data.meta), data.bounce, data.replicaPort, new Int32Array(data.repl));
};

const missing = (error) => { if (error.name === 'NotFoundError') return null; throw error; };

async function open({ dir, name, templateUrl, restoreFrom, replace, identity: given }) {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(dir, { create: true });
  // A replacing disk (a scratch tab's promotion, mem-disk.js) carries a marker
  // until the page has moved the guest onto it. A marker found here means the
  // tab closed mid-copy: that disk is incomplete, so it is dropped.
  if (replace) {
    await discard(folder, name);
    await folder.getFileHandle(name + FILLING, { create: true });
  } else if (await folder.getFileHandle(name + FILLING).catch(missing)) {
    console.warn('karkhana disk: dropping a disk whose copy never finished');
    await discard(folder, name);
    await folder.removeEntry(name + FILLING);
  }
  let file = await folder.getFileHandle(name).catch(missing);
  let created = false;
  let restored = false;
  let diskId = null;
  if (!file && restoreFrom) {
    ({ file, diskId } = await restore(folder, name, restoreFrom));
    restored = true;
  } else if (!file) {
    file = await seed(folder, name, templateUrl);
    created = true;
  }
  const handle = await exclusive(file);
  const head = new Uint8Array(4);
  handle.read(head, { at: 0 });
  if (!isQcow2(head)) {
    handle.close();
    throw new Error(`${dir}/${name} is not a qcow2 image`);
  }
  diskId = await identity(folder, name, diskId || (created ? given || crypto.randomUUID() : null));
  // One byte per chunk, which the next replica snapshot must carry. A disk with
  // no bitmap yet (older, or just created) starts all-dirty.
  const bitmap = await exclusive(await folder.getFileHandle(name + '.dirty', { create: true }));
  const kept = bitmap.getSize() > 0 && !created && !restored ? new Uint8Array(bitmap.getSize()) : null;
  if (kept) bitmap.read(kept, { at: 0 });
  if (restored) { bitmap.truncate(0); }
  return { handle, bitmap, dirty: kept, created, restored, diskId };
}

// Deletes the saved disk, unless another tab holds it: then the handle stays
// busy and open() fails with 'busy'.
async function discard(folder, name) {
  const file = await folder.getFileHandle(name).catch(missing);
  if (file) (await exclusive(file)).close();
  for (const entry of [name, name + '.dirty', name + '.id']) await folder.removeEntry(entry).catch(missing);
}

// A stable id per disk, so a folder backup is never overwritten by another disk.
async function identity(folder, name, fresh) {
  const file = await folder.getFileHandle(name + '.id').catch(missing);
  if (file && !fresh) return (await (await file.getFile()).text()).trim() || identity(folder, name, crypto.randomUUID());
  const id = fresh || crypto.randomUUID();
  const writable = await (await folder.getFileHandle(name + '.id', { create: true })).createWritable();
  await writable.write(id);
  await writable.close();
  return id;
}

// Like seed(): the restored image appears under its real name only once complete.
async function restore(folder, name, from) {
  const part = await folder.getFileHandle(name + '.part', { create: true });
  const handle = await part.createSyncAccessHandle();
  let diskId;
  try {
    ({ diskId } = await restoreReplica(from, handle));
  } finally {
    handle.close();
  }
  await part.move(name);
  return { file: await folder.getFileHandle(name), diskId };
}

// On a reload the previous page's worker can still hold the handle for a
// moment, so a busy handle is retried before the page settles for scratch.
// A second tab stays busy and falls back after BUSY_RETRY_MS.
const BUSY_RETRY_MS = 3000;
async function exclusive(file) {
  const deadline = Date.now() + BUSY_RETRY_MS;
  for (;;) {
    try {
      return await file.createSyncAccessHandle();
    } catch (error) {
      if (error.name !== 'NoModificationAllowedError' || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

// The image appears under its real name only once complete: a tab closed
// mid-copy leaves the .part file, which the next attempt overwrites.
async function seed(folder, name, templateUrl) {
  const bytes = await fetchDiskTemplate(templateUrl);
  const part = await folder.getFileHandle(name + '.part', { create: true });
  const handle = await part.createSyncAccessHandle();
  try {
    handle.truncate(0);
    for (let at = 0; at < bytes.length;) at += handle.write(bytes.subarray(at), { at });
    handle.flush();
  } finally {
    handle.close();
  }
  await part.move(name);
  return folder.getFileHandle(name);
}

function serve({ handle, bitmap, dirty: kept }, ctl, meta, bounce, replicaPort, repl) {
  const chunkOf = (index, size) => {
    const at = index * tracker.chunkBytes;
    const bytes = new Uint8Array(Math.max(0, Math.min(tracker.chunkBytes, size - at)));
    if (bytes.length) handle.read(bytes, { at });
    return bytes;
  };
  const tracker = new ChunkTracker({
    size: handle.getSize(), dirty: kept, readChunk: chunkOf, repl,
    persist: (map) => { bitmap.truncate(map.length); bitmap.write(map, { at: 0 }); },
    send: (message, transfer) => replicaPort.postMessage(message, transfer),
  });
  let dirty = false;
  let lastWrite = 0;
  let lastPump = 0;
  for (;;) {
    const wait = tracker.active ? PUMP_MS : dirty ? FLUSH_DELAY_MS : Infinity;
    const woke = Atomics.wait(ctl, CTL.STATE, STATE.IDLE, wait);
    if (woke === 'timed-out') {
      if (tracker.active) { tracker.pump(); lastPump = Date.now(); }
      if (dirty && Date.now() - lastWrite >= FLUSH_DELAY_MS) {
        try { handle.flush(); bitmap.flush(); } catch (error) { console.error('karkhana disk: flush failed', error); }
        dirty = false;
      }
      continue;
    }
    if (Atomics.load(ctl, CTL.STATE) !== STATE.REQUEST) continue;
    const op = ctl[CTL.OP];
    const pos = meta[META.POS];
    const len = meta[META.LEN];
    let result = 0;
    let errno = 0;
    try {
      switch (op) {
        case OP.READ:
          result = handle.read(new Uint8Array(bounce, 0, len), { at: pos });
          break;
        case OP.WRITE:
          tracker.beforeWrite(pos, len);
          result = handle.write(new Uint8Array(bounce, 0, len), { at: pos });
          dirty = true;
          lastWrite = Date.now();
          break;
        case OP.TRUNCATE:
          tracker.beforeTruncate(handle.getSize(), pos);
          handle.truncate(pos);
          result = handle.getSize();
          dirty = true;
          lastWrite = Date.now();
          break;
        case OP.SNAPSHOT:
          result = tracker.begin(handle.getSize());
          break;
        case OP.MARK_ALL:
          tracker.markAll();
          break;
        case OP.FLUSH:
          handle.flush();
          dirty = false;
          break;
        case OP.CLOSE:
          handle.flush();
          handle.close();
          bitmap.flush();
          bitmap.close();
          break;
        default:
          errno = ERRNO.EINVAL;
      }
    } catch (error) {
      console.error('karkhana disk: operation', op, 'failed', error);
      errno = error.name === 'QuotaExceededError' ? ERRNO.ENOSPC : ERRNO.EIO;
    }
    meta[META.RESULT] = result;
    ctl[CTL.ERRNO] = errno;
    Atomics.store(ctl, CTL.STATE, STATE.DONE);
    Atomics.notify(ctl, CTL.STATE);
    if (op === OP.CLOSE) return;
    // Under steady guest I/O there is no idle moment; keep a snapshot moving.
    if (tracker.active && Date.now() - lastPump >= PUMP_MS * 5) { tracker.pump(); lastPump = Date.now(); }
  }
}
