// Holds the persistent disk's OPFS sync access handle and serves the main
// thread's requests (see opfs-disk.js). Runs as a module worker.
import { CTL, ERRNO, META, OP, STATE, fetchDiskTemplate, isQcow2 } from './opfs-disk.js';

// A write marks the handle dirty; it is flushed after this much idle time.
// Tab closes need no flush (written bytes are already in the file); an OS
// crash does, and so does the guest's own fsync.
const FLUSH_DELAY_MS = 1000;

self.onmessage = async ({ data }) => {
  self.onmessage = null;
  let handle;
  let created = false;
  try {
    ({ handle, created } = await open(data));
  } catch (error) {
    const code = error.name === 'NoModificationAllowedError' ? 'busy' : 'failed';
    self.postMessage({ ok: false, code, error: `${error.name}: ${error.message}` });
    return;
  }
  self.postMessage({ ok: true, size: handle.getSize(), created });
  serve(handle, new Int32Array(data.ctl), new Float64Array(data.meta), data.bounce);
};

async function open({ dir, name, templateUrl }) {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(dir, { create: true });
  let file = await folder.getFileHandle(name).catch((error) => {
    if (error.name === 'NotFoundError') return null;
    throw error;
  });
  let created = false;
  if (!file) {
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
  return { handle, created };
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

function serve(handle, ctl, meta, bounce) {
  let dirty = false;
  for (;;) {
    const woke = Atomics.wait(ctl, CTL.STATE, STATE.IDLE, dirty ? FLUSH_DELAY_MS : Infinity);
    if (woke === 'timed-out') {
      try { handle.flush(); } catch (error) { console.error('karkhana disk: flush failed', error); }
      dirty = false;
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
          result = handle.write(new Uint8Array(bounce, 0, len), { at: pos });
          dirty = true;
          break;
        case OP.TRUNCATE:
          handle.truncate(pos);
          result = handle.getSize();
          dirty = true;
          break;
        case OP.FLUSH:
          handle.flush();
          dirty = false;
          break;
        case OP.CLOSE:
          handle.flush();
          handle.close();
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
  }
}
