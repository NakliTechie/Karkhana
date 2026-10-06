// The Folder rung of the storage ladder, page side: keeps a replica of the
// OPFS disk in a folder the user picks (or any directory handle), and restores
// from one. The OPFS disk stays the live copy; only OPFS gives QEMU
// synchronous I/O. See chunk-tracker.js and replica.js.
//
// The disk worker's snapshot messages pass through the page to the replica
// worker, so the folder can change without reopening the disk. The folder
// handle is kept in IndexedDB; browsers may ask again for permission on a
// later visit, which needs a click (resume()).

import { REPL } from './chunk-tracker.js';
import { describeReplica } from './replica.js';

export const BACKUP_EVERY_MS = 60_000;
const DIR_KEY = 'backup-dir';
const RESTORE_KEY = 'karkhana-restore-pending';

const permitted = async (dir) => (await dir.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';

// Called before the disk opens: a pending restore (set by restore()) whose
// folder is still permitted becomes openOpfsDisk's restoreFrom.
export async function pendingRestore({ kvGet }) {
  let pending = false;
  try { pending = localStorage.getItem(RESTORE_KEY) === '1'; } catch { /* storage blocked */ }
  if (!pending) return null;
  const dir = await kvGet(DIR_KEY).catch(() => null);
  return dir && (await permitted(dir)) === 'granted' ? dir : null;
}

export function createBackup({ disk, workerUrl, kvGet, kvPut, onStatus = () => {} }) {
  const status = { folder: null, state: 'off', seq: 0, savedAt: null, chunksWritten: 0, bytesWritten: 0, lastError: null };
  let worker = null;
  let timer = null;
  let openSeq = 0;
  const update = (patch) => { Object.assign(status, patch); onStatus({ ...status }); };

  disk.replicaPort.onmessage = ({ data }) => {
    if (data.type === 'begin') openSeq = data.seq;
    if (worker) worker.postMessage(data, data.bytes ? [data.bytes.buffer] : []);
  };

  // A snapshot the replica can no longer finish must not block the next one.
  const abandon = () => {
    if (openSeq && Atomics.load(disk.repl, REPL.COMMITTED) !== openSeq) Atomics.store(disk.repl, REPL.FAILED, openSeq);
    Atomics.store(disk.repl, REPL.INFLIGHT, 0);
  };

  function stop() {
    clearInterval(timer);
    timer = null;
    worker?.terminate();
    worker = null;
    abandon();
  }

  async function start(dir) {
    stop();
    update({ folder: dir.name, state: 'starting', lastError: null });
    const w = new Worker(workerUrl, { type: 'module', name: 'karkhana-backup' });
    const ready = new Promise((resolve, reject) => {
      w.onmessage = ({ data }) => {
        if (data.type === 'error') { reject(Object.assign(new Error(data.error), { code: data.code })); return; }
        if (data.type === 'status') {
          resolve();
          update({ state: 'on', seq: data.seq, savedAt: data.savedAt, chunksWritten: data.chunksWritten, bytesWritten: data.bytesWritten, lastError: data.lastError });
        }
      };
      w.onerror = (event) => reject(new Error(event.message || 'backup worker failed to load'));
    });
    w.postMessage({ dir, diskId: disk.diskId, repl: disk.repl.buffer });
    try {
      await ready;
    } catch (error) {
      w.terminate();
      update({ state: error.code === 'other-disk' ? 'other-disk' : 'error', lastError: error.message });
      throw error;
    }
    worker = w;
    timer = setInterval(() => backupNow(), BACKUP_EVERY_MS);
  }

  // Starts a snapshot unless one is still running. Returns its chunk count, or -1.
  function backupNow() {
    if (!worker) return -1;
    return disk.snapshot();
  }

  return {
    get status() { return { ...status }; },
    describe: describeReplica,

    // Backs up to dir from now on. A full copy first: chunks the folder already
    // holds are recognised by hash and not written again.
    async attach(dir) {
      if ((await permitted(dir)) !== 'granted' && (await dir.requestPermission?.({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('folder permission was not granted');
      }
      await start(dir);
      await kvPut(DIR_KEY, dir);
      disk.markAll();
      backupNow();
    },

    // Picks up the stored folder at boot when the browser still permits it.
    // Returns 'on', 'needs-permission' or 'off'.
    async resumeIfPermitted() {
      const dir = await kvGet(DIR_KEY).catch(() => null);
      if (!dir) return 'off';
      update({ folder: dir.name });
      if ((await permitted(dir)) !== 'granted') { update({ state: 'needs-permission' }); return 'needs-permission'; }
      await start(dir).then(() => backupNow(), () => {});
      return status.state;
    },

    // From a click: asks again for the stored folder's permission.
    async resume() {
      const dir = await kvGet(DIR_KEY);
      if (!dir) throw new Error('no backup folder chosen');
      if ((await dir.requestPermission?.({ mode: 'readwrite' })) === 'denied') throw new Error('folder permission was not granted');
      await start(dir);
      backupNow();
    },

    now: backupNow,

    // Stops backing up from this tab, keeping the stored folder: the tab that
    // holds the disk next picks it up.
    stop,

    async detach() {
      stop();
      await kvPut(DIR_KEY, null);
      update({ folder: null, state: 'off' });
    },

    // Replaces this browser's disk with the folder's backup: the disk can only
    // be swapped before QEMU opens it, so this reloads the page.
    async restore(dir) {
      if ((await permitted(dir)) !== 'granted' && (await dir.requestPermission?.({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('folder permission was not granted');
      }
      if (!(await describeReplica(dir))) throw new Error('no Karkhana disk backup in this folder');
      stop();
      await kvPut(DIR_KEY, dir);
      localStorage.setItem(RESTORE_KEY, '1');
      return true;
    },

    clearPendingRestore() { try { localStorage.removeItem(RESTORE_KEY); } catch { /* storage blocked */ } },
  };
}
