import { receiveCountWrite, clearRemoteCountWrites } from './countWrites.js';

export function startCountSync(store, target = window, Channel = globalThis.BroadcastChannel) {
  if (!Channel) return () => {};
  const channel = new Channel('mailflow-counts');
  const seen = new Set();
  const writeUsers = new Map();
  const onMutation = event => {
    const userId = store.getState().user?.id;
    if (userId) channel.postMessage({ type: 'mutation', userId, ...event.detail });
  };
  const onSnapshot = event => {
    const userId = store.getState().user?.id;
    const counts = { ...event.detail };
    delete counts.countWriteVersion;
    delete counts.countWritesPending;
    if (userId) channel.postMessage({ type: 'snapshot', userId, counts });
  };
  const onWrite = event => {
    if (event.detail.remote) return;
    const { id, phase } = event.detail;
    if (phase === 'start') writeUsers.set(id, store.getState().user?.id);
    const userId = writeUsers.get(id);
    if (phase === 'finish') writeUsers.delete(id);
    if (userId) channel.postMessage({ type: 'write', userId, ...event.detail });
  };
  channel.onmessage = ({ data }) => {
    const state = store.getState();
    if (!data || !data.userId || data.userId !== state.user?.id || state.isLocked) return;
    if (data.type === 'mutation' && Number.isFinite(data.delta) && typeof data.accountId === 'string') {
      if (!data.mutationId || seen.has(data.mutationId)) return;
      seen.add(data.mutationId);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      state.adjustUnread(data.accountId, data.delta, false);
      target.dispatchEvent(new CustomEvent('mailflow:counts_refresh'));
      target.dispatchEvent(new CustomEvent('mailflow:refresh'));
    } else if (data.type === 'snapshot' && data.counts) {
      const counts = { ...data.counts };
      delete counts.countWriteVersion;
      delete counts.countWritesPending;
      state.setUnreadCounts(counts, false);
    }
    else if (data.type === 'write') receiveCountWrite(data);
  };
  target.addEventListener('mailflow:count_mutation', onMutation);
  target.addEventListener('mailflow:count_snapshot', onSnapshot);
  target.addEventListener('mailflow:count-write', onWrite);
  return () => {
    target.removeEventListener('mailflow:count_mutation', onMutation);
    target.removeEventListener('mailflow:count_snapshot', onSnapshot);
    target.removeEventListener('mailflow:count-write', onWrite);
    clearRemoteCountWrites();
    channel.close();
  };
}
