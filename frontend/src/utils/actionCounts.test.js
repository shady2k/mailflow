import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxUnreadDelta, inboxUnreadCounts, adjustInboxTransition } from './actionCounts.js';

test('account INBOX changes use concrete folder scope, never unknown or off-INBOX aggregate', () => {
  assert.equal(inboxUnreadDelta({ folder: 'Archive' }, 5), 0);
  assert.equal(inboxUnreadDelta({}, 5), 0);
  assert.equal(inboxUnreadDelta({ folder: 'INBOX' }, 2), 2);
  assert.deepEqual([...inboxUnreadCounts([
    { id: 'a', account_id: 'work', folder: 'INBOX', is_read: false },
    { id: 'a', account_id: 'work', folder: 'INBOX', is_read: false },
    { id: 'b', account_id: 'home', folder: 'INBOX', is_read: false },
    { id: 'c', account_id: 'home', folder: 'Archive', is_read: false },
    { id: 'd', account_id: 'work', folder: 'INBOX', is_read: true },
  ])], [['work', 1], ['home', 1]]);
});

test('move/read folder transitions and rollback affect each account exactly', () => {
  const counts = { work: 2, home: 1 };
  const inc = (id, n) => { counts[id] += n; };
  const dec = (id, n) => { counts[id] -= n; };
  const filed = { id: 'filed', account_id: 'work', folder: 'Archive', is_read: false };
  const inbox = { id: 'inbox', account_id: 'home', folder: 'INBOX', is_read: false };
  adjustInboxTransition(filed, 'INBOX', inc, dec);
  adjustInboxTransition(inbox, 'Archive', inc, dec);
  assert.deepEqual(counts, { work: 3, home: 0 });
  adjustInboxTransition(filed, 'INBOX', inc, dec, true);
  adjustInboxTransition(inbox, 'Archive', inc, dec, true);
  assert.deepEqual(counts, { work: 2, home: 1 });
  for (const destination of ['Archive', 'Sent']) adjustInboxTransition(filed, destination, inc, dec);
  adjustInboxTransition({ ...inbox, is_read: true }, 'Archive', inc, dec);
  assert.deepEqual(counts, { work: 2, home: 1 });
});

test('folder changes preserve total versus unread and resolved account attribution', async () => {
  const { folderCountChanges } = await import('./actionCounts.js');
  const messages = [
    { id: 'a', account_id: 'work', folder: 'INBOX', is_read: false },
    { id: 'b', account_id: 'work', folder: 'INBOX', is_read: true },
    { id: 'c', account_id: 'home', folder: 'Archive', is_read: false },
  ];
  assert.deepEqual(folderCountChanges([...messages, messages[0]], { destination: 'Archive' }), [
    { accountId: 'work', folder: 'INBOX', total: -2, unread: -1 },
    { accountId: 'work', folder: 'Archive', total: 2, unread: 1 },
  ]);
  assert.deepEqual(folderCountChanges(messages, { read: true }), [
    { accountId: 'work', folder: 'INBOX', total: 0, unread: -1 },
    { accountId: 'home', folder: 'Archive', total: 0, unread: -1 },
  ]);
});
