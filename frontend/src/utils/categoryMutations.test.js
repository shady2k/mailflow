import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageCategoryRemovals, settleCategoryRemoval, hasPendingCategoryRemoval } from './categoryMutations.js';

const message = (id, account = 'a', category = 'primary', read = false, folder = 'INBOX') => ({ id, account_id: account, category, is_read: read, folder });
const initial = () => ({ user: { id: 'owner' }, selectedAccountId: 'a', selectedFolder: 'INBOX',
  accounts: [{ id: 'a', enabled: true }, { id: 'b', enabled: true, include_in_unified_inbox: false }],
  categoryCounts: { primary: 2, newsletter: 0 }, categoryTotals: { primary: 5, newsletter: 2 },
  categoryCountScope: 'owner/a/INBOX', categoryCountRevision: 0, categoryPendingRemovals: {} });
const stage = (state, messages) => ({ ...state, ...stageCategoryRemovals(state, messages) });
const settle = (state, id, committed) => ({ ...state, ...settleCategoryRemoval(state, id, committed) });

test('partial success keeps successful removal and restores only failed category/read deltas', () => {
  let state = stage(initial(), [message('unread'), message('read','a','newsletter',true)]);
  assert.deepEqual(state.categoryTotals, { primary: 4, newsletter: 1 });
  assert.deepEqual(state.categoryCounts, { primary: 1, newsletter: 0 });
  state = settle(state, 'unread', true);
  state = settle(state, 'read', false);
  assert.deepEqual(state.categoryTotals, { primary: 4, newsletter: 2 });
  assert.deepEqual(state.categoryCounts, { primary: 1, newsletter: 0 });
  assert.deepEqual(state.categoryPendingRemovals, {});
});

test('duplicate staging and undo are idempotent, including bounded zero snapshots', () => {
  let state = stage(initial(), [message('one'), message('one')]);
  state = stage(state, [message('one')]);
  assert.equal(state.categoryTotals.primary, 4);
  state = settle(state, 'one', false); state = settle(state, 'one', false);
  assert.equal(state.categoryTotals.primary, 5);
  let empty = initial(); empty.categoryTotals.primary = 0; empty.categoryCounts.primary = 0;
  empty = settle(stage(empty, [message('stale')]), 'stale', false);
  assert.equal(empty.categoryTotals.primary, 0); assert.equal(empty.categoryCounts.primary, 0);
});

test('account, folder and user changes cannot receive another scope rollback', () => {
  const pending = stage(initial(), [message('one')]);
  for (const changed of [
    { selectedAccountId: 'b', categoryCountScope: 'owner/b/INBOX' },
    { selectedFolder: 'Archive', categoryCountScope: null },
    { user: { id: 'other' }, categoryCountScope: 'other/a/INBOX' },
  ]) {
    const state = settle({ ...pending, ...changed, categoryCounts: { primary: 9 }, categoryTotals: { primary: 12 } }, 'one', false);
    assert.deepEqual(state.categoryCounts, { primary: 9 }); assert.deepEqual(state.categoryTotals, { primary: 12 });
  }
});

test('unified scope excludes opted-out accounts and non-INBOX copies', () => {
  const state = stage({ ...initial(), selectedAccountId: null, categoryCountScope: 'owner/unified/INBOX' },
    [message('included'), message('excluded','b'), message('sent','a','primary',false,'Sent')]);
  assert.equal(state.categoryTotals.primary, 4); assert.equal(state.categoryCounts.primary, 1);
  assert.equal(hasPendingCategoryRemoval(state), true);
  assert.equal(hasPendingCategoryRemoval({ ...state, selectedAccountId: 'unknown' }), false);
});

test('resolving a thread replaces only its provisional row and charges actual categories', () => {
  let state = stage(initial(), [{ ...message('head'), message_count: 3, unread_count: 2 }]);
  assert.equal(state.categoryTotals.primary, 4);
  state = stage(state, [message('head'), message('child','a','newsletter',true), message('sent','a','primary',false,'Sent')]);
  assert.deepEqual(state.categoryTotals, { primary: 4, newsletter: 1 });
  assert.deepEqual(state.categoryCounts, { primary: 1, newsletter: 0 });
});
