import { isAccountInUnifiedInbox } from './unifiedInbox.js';

// Reconciliation deadline: retain the optimistic projection if no successful observation
// acknowledges it, mark it stale, and request another snapshot instead of restoring old mail.
export const PENDING_COUNT_MS = 15000;
// Compatibility floor for snapshots from an older backend without a database barrier.
export const PENDING_SETTLE_MS = 6000;

// Freshness allowance for the per-account totals, which come from INBOX. INBOX is polled every
// monitor cycle, so three cycles of slack. Mirrors STATUS_STALE_MS in backend folderStatus.js;
// rotating folders get a longer, rotation-derived allowance computed server-side.
export const ACCOUNT_COUNT_STALE_MS = 180000;
const revision = snapshot => BigInt(snapshot?.attemptRevision || snapshot?.revision || '0');
const observedRevision = snapshot => BigInt(snapshot?.revision || '0');

// A snapshot is independently ordered per account. Comparing unified totals cannot
// acknowledge individual reads: arrivals and writes in another account can cancel them.
export function mergeCountSnapshots(previous, incoming) {
  const byAccount = {}, snapshots = {};
  for (const [id, count] of Object.entries(incoming.byAccount || {})) {
    const old = previous.snapshots?.[id], next = incoming.snapshots?.[id];
    const keep = old && revision(old) > revision(next);
    byAccount[id] = keep ? previous.byAccount[id] : count;
    snapshots[id] = keep ? old : next;
  }
  return { ...incoming, byAccount, snapshots };
}

export function expireCountPending(pending, now = Date.now()) {
  return Object.fromEntries(Object.entries(pending).filter(([, p]) => p.delta !== 0)
    .map(([id, p]) => [id, p.expiresAt > now ? p : { ...p, stale: true, expiresAt: now + PENDING_COUNT_MS }]));
}

export function adjustCountPending(pending, displayed, accountId, delta, now = Date.now()) {
  const next = expireCountPending(pending, now);
  const base = displayed.byAccount[accountId];
  if (!Number.isFinite(base) || !Number.isFinite(delta)) return next;
  // Keep the raw baseline separate from the projection, including when scope changes.
  const p = next[accountId] || { base, delta: 0, openedAt: now, expiresAt: now + PENDING_COUNT_MS,
    sinceRevision: String(observedRevision(displayed.snapshots?.[accountId])) };
  next[accountId] = { ...p, delta: p.delta + delta, ackBarrier: null };
  if (next[accountId].delta === 0) delete next[accountId];
  return next;
}

// A post-write database barrier is a watermark for STATUS requests started before the write
// completed. Only a successful observation above it can acknowledge a projection; attempt
// revisions include failed observations and must never do that.
export function settleCountPending(pending, server, now = Date.now(), canAcknowledge = true, writeVersion = 0) {
  const out = {};
  for (const [id, p] of Object.entries(expireCountPending(pending, now))) {
    const pastFloor = Number.isFinite(p.openedAt) && now - p.openedAt >= PENDING_SETTLE_MS;
    const snapshot = server?.snapshots?.[id];
    const observed = snapshot?.known !== false && !snapshot?.stale
      && observedRevision(snapshot) > BigInt(p.sinceRevision || '0');
    if (server.barrierRevision != null) {
      const currentBarrier = p.ackWriteVersion === writeVersion ? p.ackBarrier : null;
      const barrier = currentBarrier ?? (canAcknowledge ? String(server.barrierRevision) : null);
      if (!canAcknowledge || barrier == null || !observed || observedRevision(snapshot) <= BigInt(barrier)) {
        out[id] = { ...p, ackBarrier: barrier, ackWriteVersion: writeVersion };
      }
    } else if (!(canAcknowledge && pastFloor && observed)) out[id] = p;
  }
  return out;
}

export function displayCountSnapshot(server, pending, accounts, now = Date.now()) {
  const byAccount = { ...server.byAccount };
  const snapshots = { ...server.snapshots };
  for (const [id, s] of Object.entries(snapshots)) {
    if (s) snapshots[id] = { ...s, stale: s.stale || !s.observedAt || now - new Date(s.observedAt).getTime() > ACCOUNT_COUNT_STALE_MS };
  }
  for (const [id, p] of Object.entries(pending)) {
    if (Object.hasOwn(byAccount, id)) byAccount[id] = Math.max(0, p.base + p.delta);
    if (snapshots[id] && (p.stale || p.expiresAt <= now)) snapshots[id] = { ...snapshots[id], stale: true };
  }
  const included = accounts.filter(isAccountInUnifiedInbox);
  const total = included.reduce((sum, a) => sum + (byAccount[a.id] || 0), 0);
  const complete = included.every(a => snapshots[a.id]?.known && !snapshots[a.id]?.stale);
  return { ...server, byAccount, snapshots, total, complete };
}

export function mergeFolderSnapshots(previous = [], incoming = []) {
  const old = new Map(previous.map(f => [f.path, f]));
  return incoming.map(f => {
    const p = old.get(f.path);
    // Folder metadata comes from the current list; only retain newer observations.
    if (!p || BigInt(p.status_attempt_revision || '0') <= BigInt(f.status_attempt_revision || '0')) return f;
    const fields = ['total_count', 'unread_count', 'counts_known', 'counts_stale', 'server_counts_at',
      'server_count_revision', 'status_attempt_revision', 'status_attempted_at', 'status_error'];
    return { ...f, ...Object.fromEntries(fields.map(k => [k, p[k]])) };
  });
}

// How many of `messages` change unread state when the conversation is marked `read`, grouped
// by the account whose badge each change belongs to. A message with no account_id is charged
// to `fallbackAccountId`, the acted-on row's account.
//
// With conversations on, one thread row can hold another account's copy of the same email
// (#476). Charging the row's whole unread_count to the row's own account, which is what the
// pre-resolution estimate has to do, moves that copy's unread off the wrong badge: the row's
// account drops by two, the other account drops by nothing, and the sidebar is wrong until
// the next server snapshot (PENDING_COUNT_MS). The unified total is a sum, so it stays right;
// only the per-account split is off. Pure.
export function unreadDeltaByAccount(messages, read, fallbackAccountId) {
  const out = new Map();
  for (const m of messages || []) {
    if (!m) continue;
    if (m.folder && m.folder !== 'INBOX') continue;
    const changes = read ? !m.is_read : !!m.is_read;
    if (!changes) continue;
    const account = m.account_id ?? fallbackAccountId;
    out.set(account, (out.get(account) || 0) + 1);
  }
  return out;
}
