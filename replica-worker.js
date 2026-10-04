// Keeps one replica (replica.js) current from the disk worker's snapshots.
// Module worker. The first message is { dir, diskId, repl }; every later one is
// a tracker message (chunk-tracker.js) relayed by the page (backup.js). Status
// and errors go back to the page.
import { Replica } from './replica.js';

self.onmessage = async ({ data }) => {
  self.onmessage = null;
  const repl = new Int32Array(data.repl);
  let replica;
  try {
    replica = await Replica.open(data.dir, data.diskId);
  } catch (error) {
    self.postMessage({ type: 'error', code: error.code || 'failed', error: error.message });
    return;
  }
  const report = () => self.postMessage({ type: 'status', seq: replica.committed.seq, savedAt: replica.committed.savedAt, ...replica.stats });
  report();
  self.onmessage = ({ data: message }) => {
    replica.receive(message, repl).then(() => { if (message.type === 'end' || replica.stats.lastError) report(); });
  };
};
