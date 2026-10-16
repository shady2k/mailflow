import { recordDiagEvent } from './diagEvents.js';
const tasks = new Map();
let revision = 0;

export function registerConnectionRefresh(name, task) {
  tasks.set(name, task);
  revision++;
  window.dispatchEvent(new CustomEvent('mailflow:connection-scope'));
  return () => {
    if (tasks.get(name) !== task) return;
    tasks.delete(name);
    revision++;
  };
}

export async function refreshConnectionData(isCurrent, refreshCounts) {
  while (isCurrent()) {
    const scopeRevision = revision;
    if (!tasks.has('messages') || !tasks.has('categories')) return false;
    const consumers = [['counts', refreshCounts], ...tasks];
    const results = await Promise.allSettled(consumers.map(([, task]) => task(isCurrent)));
    if (!isCurrent()) return false;
    if (scopeRevision !== revision) continue;
    results.forEach((result, index) => {
      if (result.status === 'rejected' || result.value === false) recordDiagEvent({ category: 'ws',
        type: result.status === 'rejected' ? 'refresh_failed' : 'refresh_deferred',
        cause: consumers[index][0], status: Number(result.reason?.status) || 0 });
    });
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    if (results.some(result => result.value === false)) return false;
    return true;
  }
  return false;
}
