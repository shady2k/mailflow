import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayInboxFolderCounts } from './inboxFolderCounts.js';

const folder = { path: 'INBOX', unread_count: 2, counts_known: true, status_attempt_revision: '10' };
const counts = (count, revision = '10') => ({ byAccount: { a: count }, snapshots: { a: { known: true, attemptRevision: revision, observedAt: '2026-10-12T20:00:00Z', stale: false } } });

test('Inbox optimism is account-scoped and does not mutate server folder observations', () => {
  const rows = { a: [folder, { path: 'Archive', unread_count: 8 }], b: [folder] };
  const shown = displayInboxFolderCounts(rows, counts(1), { a: { expiresAt: 200 } }, 100);
  assert.equal(shown.a[0].unread_count, 1);
  assert.equal(shown.a[1].unread_count, 8);
  assert.equal(shown.b[0].unread_count, 2);
  assert.equal(rows.a[0].unread_count, 2);
});

test('newer folder observations win outside optimism; newer account snapshots and active windows win otherwise', () => {
  const rows = { a: [{ ...folder, unread_count: 3, status_attempt_revision: '12' }] };
  assert.equal(displayInboxFolderCounts(rows, counts(2, '10'), {}, 100).a[0].unread_count, 3);
  assert.equal(displayInboxFolderCounts(rows, counts(1, '13'), {}, 100).a[0].unread_count, 1);
  assert.equal(displayInboxFolderCounts(rows, counts(1, '10'), { a: { expiresAt: 200 } }, 100).a[0].unread_count, 1);
  assert.equal(displayInboxFolderCounts(rows, counts(1, '10'), { a: { expiresAt: 100 } }, 100).a[0].unread_count, 3);
});

test('unknown observations cannot invent counts and stale state is retained', () => {
  const rows = { a: [folder] };
  assert.equal(displayInboxFolderCounts(rows, { byAccount: { a: null }, snapshots: {} }, {}, 100).a[0], folder);
  assert.equal(displayInboxFolderCounts(rows, { byAccount: { a: 0 }, snapshots: { a: { known: false } } }, {}, 100).a[0], folder);
  const snapshot = counts(0); snapshot.snapshots.a.stale = true;
  const displayed = displayInboxFolderCounts(rows, snapshot, {}, 100).a[0];
  assert.equal(displayed.unread_count, 0);
  assert.equal(displayed.counts_stale, true);
});
