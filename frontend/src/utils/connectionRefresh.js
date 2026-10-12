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
    if (!tasks.has('messages') || !tasks.has('categories')) throw new Error('Messages unavailable');
    const results = await Promise.allSettled([refreshCounts(), ...[...tasks.values()].map(task => task(isCurrent))]);
    if (!isCurrent()) return false;
    if (scopeRevision !== revision) continue;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    if (results.some(result => result.value === false)) throw new Error('Refresh superseded');
    return true;
  }
  return false;
}
