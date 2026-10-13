const active = new Map();
const completed = new Set();
let version = 0;
let nextId = 0;
const origin = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
export const countWriteState = () => ({ version, pending: active.size });

function notify(id, phase, remote) {
  if (typeof window === 'undefined' || !window.dispatchEvent) return;
  const EventClass = window.CustomEvent || globalThis.CustomEvent;
  if (EventClass) window.dispatchEvent(new EventClass('mailflow:count-write', { detail: { id, phase, remote, ...countWriteState() } }));
}
function apply(id, phase, remote) {
  if (!id || !['start', 'finish'].includes(phase)) return;
  if (phase === 'start') {
    if (active.has(id) || completed.has(id)) return;
    active.set(id, remote);
  } else {
    if (completed.has(id)) return;
    active.delete(id);
    completed.add(id);
    if (completed.size > 2048) completed.delete(completed.values().next().value);
  }
  ++version;
  notify(id, phase, remote);
}
export function beginCountWrite() {
  const id = `${origin}:${++nextId}`;
  apply(id, 'start', false);
  return () => apply(id, 'finish', false);
}
export function receiveCountWrite({ id, phase }) { apply(id, phase, true); }
export function clearRemoteCountWrites() {
  for (const [id, remote] of active) if (remote) apply(id, 'finish', true);
}
