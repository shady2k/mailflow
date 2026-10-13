import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCountSync } from './countSync.js';

test('other tabs receive optimistic archive/Undo once, ordered snapshots, and user isolation', () => {
  const target = new EventTarget();
  const calls = [], sent = [];
  let closed = false, channel;
  class Channel {
    constructor() { channel = this; }
    postMessage(message) { sent.push(message); }
    close() { closed = true; }
  }
  const state = { user: { id: 'u' }, adjustUnread: (...args) => calls.push(args), setUnreadCounts: (...args) => calls.push(args) };
  const stop = startCountSync({ getState: () => state }, target, Channel);
  channel.onmessage({ data: { userId: 'different-user', type: 'mutation', accountId: 'a', delta: -1 } });
  assert.equal(calls.length, 0);
  for (const delta of [-1, 1]) channel.onmessage({ data: { userId: 'u', type: 'mutation', accountId: 'a', delta, mutationId: `op:${delta}` } });
  channel.onmessage({ data: { userId: 'u', type: 'mutation', accountId: 'a', delta: -1, mutationId: 'op:-1' } });
  const counts = { byAccount: { a: 1 } };
  channel.onmessage({ data: { userId: 'u', type: 'snapshot', counts } });
  assert.deepEqual(calls, [['a', -1, false], ['a', 1, false], [counts, false]]);
  assert.equal(sent.length, 0, 'received events cannot loop back through the channel');
  stop();
  assert.equal(closed, true);
});
