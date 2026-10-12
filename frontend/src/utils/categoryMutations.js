import { isAccountInUnifiedInbox } from './unifiedInbox.js';

let requestVersion = 0;
let pendingRequests = 0;
export const categoryRequestState = () => ({ version: requestVersion, pending: pendingRequests });
export function beginCategoryRequest() {
  ++requestVersion;
  ++pendingRequests;
  return () => { ++requestVersion; --pendingRequests; };
}

export function categoryMessageInScope(state, message) {
  if (message.folder !== 'INBOX' || message.is_deleted) return false;
  const account = state.accounts.find(a => a.id === message.account_id);
  return Boolean(account && (state.selectedAccountId ? account.id === state.selectedAccountId : isAccountInUnifiedInbox(account)));
}

export function hasPendingCategoryRemoval(state) {
  return Object.values(state.categoryPendingRemovals).some(entry => entry.userId === state.user?.id && categoryMessageInScope(state, entry.message));
}

function scopeKey(state) {
  return `${state.user?.id || ''}/${state.selectedAccountId || 'unified'}/${state.selectedFolder}`;
}
function restoreCharge(state, counts, totals, entry) {
  if (entry.userId !== state.user?.id || entry.chargedScope !== state.categoryCountScope || scopeKey(state) !== state.categoryCountScope) return;
  const category = entry.message.category || 'primary';
  if (totals !== null) totals[category] = (totals[category] || 0) + entry.totalCharge;
  counts[category] = (counts[category] || 0) + entry.unreadCharge;
}

export function stageCategoryRemovals(state, messages) {
  const pending = { ...state.categoryPendingRemovals };
  const counts = { ...state.categoryCounts };
  const totals = state.categoryTotals === null ? null : { ...state.categoryTotals };
  let changed = false;
  for (const message of messages) {
    if (!message?.id || message.folder !== 'INBOX' || !state.accounts.some(a => a.id === message.account_id)) continue;
    const previous = pending[message.id];
    if (previous) restoreCharge(state, counts, totals, previous);
    const category = message.category || 'primary';
    const actual = message.message_count > 1 ? { ...message, is_read: !(totals?.[category] > 0 && counts[category] === totals[category]) } : message;
    const scoped = state.selectedFolder === 'INBOX' && scopeKey(state) === state.categoryCountScope && categoryMessageInScope(state, actual);
    const totalCharge = scoped && totals !== null ? Math.min(1, totals[category] || 0) : 0;
    const unreadCharge = scoped && !actual.is_read ? Math.min(1, counts[category] || 0) : 0;
    pending[message.id] = { userId: state.user?.id, message: actual, chargedScope: scoped ? state.categoryCountScope : null, totalCharge, unreadCharge };
    if (totalCharge) totals[category] -= totalCharge;
    if (unreadCharge) counts[category] -= unreadCharge;
    changed = true;
  }
  return changed ? { categoryPendingRemovals: pending, categoryCounts: counts, categoryTotals: totals, categoryCountRevision: state.categoryCountRevision + 1 } : {};
}

export function settleCategoryRemoval(state, id, committed) {
  const entry = state.categoryPendingRemovals[id];
  if (!entry) return {};
  const pending = { ...state.categoryPendingRemovals };
  delete pending[id];
  const counts = { ...state.categoryCounts };
  const totals = state.categoryTotals === null ? null : { ...state.categoryTotals };
  if (!committed) restoreCharge(state, counts, totals, entry);
  return { categoryPendingRemovals: pending, categoryCounts: counts, categoryTotals: totals, categoryCountRevision: state.categoryCountRevision + 1 };
}
