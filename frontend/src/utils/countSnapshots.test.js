import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCountSnapshots, adjustCountPending, expireCountPending, settleCountPending, displayCountSnapshot, mergeFolderSnapshots, PENDING_COUNT_MS, PENDING_SETTLE_MS } from './countSnapshots.js';
const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }, { id: 'x', enabled: true, include_in_unified_inbox: false }];
const sample = (a, b, revision = '1') => ({ byAccount: { a, b, x: 7 }, snapshots: Object.fromEntries(['a', 'b', 'x'].map(id => [id, { revision, known: true, stale: false, observedAt: new Date(0).toISOString() }])) });
test('a failed STATUS attempt cannot acknowledge an optimistic archive', () => {
  const initial = sample(2, 0);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const failed = sample(2, 0);
  failed.snapshots.a = { ...failed.snapshots.a, attemptRevision: '2', stale: true };
  assert.deepEqual(settleCountPending(pending, failed, 7000), pending);
});
test('post-write database barrier rejects observations started before the write finished', () => {
  const initial = sample(2, 0, '5');
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  const first = { ...sample(2, 0, '7'), barrierRevision: '9' };
  pending = settleCountPending(pending, first, 7000, false, 1);
  assert.equal(pending.a.ackBarrier, null, 'an in-flight write cannot capture acknowledgement');
  pending = settleCountPending(pending, first, 8000, true, 2);
  assert.equal(pending.a.ackBarrier, '9');
  pending = settleCountPending(pending, { ...sample(2, 0, '8'), barrierRevision: '10' }, 9000, true, 2);
  assert.ok(pending.a, 'late pre-barrier STATUS success cannot settle');
  const failed = { ...sample(2, 0, '8'), barrierRevision: '12' };
  failed.snapshots.a.attemptRevision = '12'; failed.snapshots.a.stale = true;
  pending = settleCountPending(pending, failed, 10000, true, 2);
  assert.ok(pending.a, 'new failed attempt cannot settle');
  assert.deepEqual(settleCountPending(pending, { ...sample(1, 0, '13'), barrierRevision: '13' }, 11000, true, 2), {});
});
test('reflected reads never get subtracted from a newer server snapshot a second time', () => {
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'b', -3, 1);
  const updated = mergeCountSnapshots(initial, sample(9, 17, '2'));
  assert.equal(displayCountSnapshot(updated, pending, accounts, 2).total, 26);
  assert.equal(displayCountSnapshot(updated, expireCountPending(pending, 6000), accounts, 6000).total, 26);
});
test('arrivals in another account cannot acknowledge a pending read', () => {
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const updated = sample(9, 21, '2');
  assert.deepEqual(displayCountSnapshot(updated, pending, accounts, 2).byAccount, { a: 9, b: 21, x: 7 });
});
test('continuous clicks cannot extend the deadline, and expiry adopts the latest observation', () => {
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'a', -1, 4999);
  assert.equal(pending.a.expiresAt, PENDING_COUNT_MS);
  assert.equal(displayCountSnapshot(sample(8, 20, '3'), pending, accounts, PENDING_COUNT_MS).byAccount.a, 8);
  assert.equal(expireCountPending(pending, PENDING_COUNT_MS).a.stale, true);
});
test('rollback cancels the deduction; a delayed rollback is bounded by its own fixed window', () => {
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'a', 1, 50);
  assert.equal(displayCountSnapshot(initial, pending, accounts, 51).byAccount.a, 10);
  pending = adjustCountPending({}, initial, 'a', 1, 6000);
  assert.equal(displayCountSnapshot(initial, pending, accounts, 6000 + PENDING_COUNT_MS).byAccount.a, 11);
});
test('ordering uses per-account integer revisions without losing 64-bit precision', () => {
  const newer = sample(9, 17, '9007199254740993');
  const old = sample(10, 20, '9007199254740992');
  assert.deepEqual(mergeCountSnapshots(newer, old).byAccount, newer.byAccount);
});
test('a failed observation retains count but supersedes the old success freshness', () => {
  const initial = sample(10, 20);
  const failed = sample(10, 20);
  failed.snapshots.a = { ...failed.snapshots.a, attemptRevision: '2', stale: true };
  const next = mergeCountSnapshots(initial, failed);
  assert.equal(mergeCountSnapshots(next, initial).snapshots.a.stale, true);
});
test('unknown counts stay unknown and time alone can make a count stale', () => {
  const initial = sample(null, 20);
  initial.snapshots.a.known = false;
  assert.deepEqual(adjustCountPending({}, initial, 'a', -1, 0), {});
  assert.equal(displayCountSnapshot(initial, {}, accounts, 0).complete, false);
  assert.equal(displayCountSnapshot(sample(10,20), {}, accounts, 180001).snapshots.a.stale, true);
});
test('folder responses cannot overwrite a later observation or reintroduce removed folders', () => {
  const old = [{ path: 'INBOX', unread_count: 4, status_attempt_revision: '3' }, { path: 'removed' }];
  const incoming = [{ path: 'INBOX', unread_count: 5, status_attempt_revision: '2', name: 'Inbox' }];
  const [folder] = mergeFolderSnapshots(old, incoming);
  assert.equal(folder.unread_count, 4);
  assert.equal(folder.name, 'Inbox');
  assert.equal(mergeFolderSnapshots(old, incoming).length, 1);
});

test('the window outlives the observation path it is waiting for', () => {
  // The bounce: the backend debounces its mutation-triggered STATUS by 5s and then needs a
  // connect, login and STATUS on top, measured at 1-2s. A window shorter than that reverted the
  // badge before its own replacement value arrived, on every read, move and archive.
  assert.ok(PENDING_COUNT_MS > 8000, 'backstop must outlast a slow observation path');
  assert.ok(PENDING_SETTLE_MS > 5000, 'settle floor must clear the backend mutation debounce');
  assert.ok(PENDING_SETTLE_MS < PENDING_COUNT_MS, 'the floor must be reachable before the backstop');
});

test('an observation taken too soon after the mutation cannot settle the window', () => {
  // A routine poll can land moments after the click, BEFORE the IMAP flag write. Settling on it
  // would reinstate exactly the bounce this mechanism exists to remove.
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const newer = mergeCountSnapshots(initial, sample(10, 20, '2'));
  assert.deepEqual(settleCountPending(pending, newer, PENDING_SETTLE_MS - 1), pending);
  assert.equal(displayCountSnapshot(newer, pending, accounts, PENDING_SETTLE_MS - 1).byAccount.a, 9);
});

test('the first observation past the floor settles the window and hands back the server value', () => {
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const newer = mergeCountSnapshots(initial, sample(9, 20, '2'));
  const settled = settleCountPending(pending, newer, PENDING_SETTLE_MS);
  assert.deepEqual(settled, {});
  assert.equal(displayCountSnapshot(newer, settled, accounts, PENDING_SETTLE_MS).byAccount.a, 9);
});

test('settling reads the observation revision, never the count it carries', () => {
  // Same revision means no new observation has been taken, whatever the number says. A total
  // that happens to match cannot acknowledge a specific read: arrivals and other-account
  // changes cancel out.
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const sameRevisionLowerCount = mergeCountSnapshots(initial, sample(9, 20, '1'));
  assert.deepEqual(settleCountPending(pending, sameRevisionLowerCount, PENDING_SETTLE_MS + 1000), pending);
  const older = { byAccount: { a: 9 }, snapshots: { a: { revision: '0', known: true } } };
  assert.deepEqual(settleCountPending(pending, older, PENDING_SETTLE_MS + 1000), pending);
});

test('windows settle independently, and each keeps its own floor', () => {
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'b', -2, 4000);
  const newer = mergeCountSnapshots(initial, sample(9, 18, '2'));
  const settled = settleCountPending(pending, newer, 7000);
  assert.equal(settled.a, undefined, 'a is 7000ms past its mutation');
  assert.ok(settled.b, 'b is only 3000ms past its own');
  assert.equal(displayCountSnapshot(newer, settled, accounts, 7000).byAccount.a, 9);
  assert.equal(displayCountSnapshot(newer, settled, accounts, 7000).byAccount.b, 18);
});

test('a missing observation retains the projection and marks it stale', () => {
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  assert.equal(settleCountPending(pending, initial, PENDING_COUNT_MS).a.stale, true);
  assert.equal(displayCountSnapshot(initial, pending, accounts, PENDING_COUNT_MS).byAccount.a, 9);
});

test('a window missing its watermark falls back to the backstop rather than settling early', () => {
  // Defensive: an entry from an older client build, or hand-rolled state, must degrade to the
  // previous time-based behaviour instead of settling on the next observation.
  const initial = sample(10, 20);
  const legacy = { a: { base: 10, delta: -1, expiresAt: PENDING_COUNT_MS } };
  const newer = mergeCountSnapshots(initial, sample(9, 20, '2'));
  assert.deepEqual(settleCountPending(legacy, newer, PENDING_SETTLE_MS + 1000), legacy);
  assert.equal(settleCountPending(legacy, newer, PENDING_COUNT_MS).a.stale, true);
});
import { unreadDeltaByAccount } from './countSnapshots.js';

describe('unreadDeltaByAccount (#476 badge attribution)', () => {
  it('does not charge Archive or Trash reads to the INBOX unread badge', () => {
    assert.deepEqual([...unreadDeltaByAccount([
      { account_id: 'a', folder: 'Archive', is_read: false },
      { account_id: 'a', folder: 'Trash', is_read: false },
      { account_id: 'a', folder: 'INBOX', is_read: false },
    ], true, 'a')], [['a', 1]]);
  });
  it('splits a cross-account conversation unread delta per account', () => {
    const msgs = [
      { id: 'w', account_id: 'work', is_read: false },
      { id: 'h', account_id: 'home', is_read: false },
    ];
    const d = unreadDeltaByAccount(msgs, true, 'work');
    assert.deepEqual([...d.entries()].sort(), [['home', 1], ['work', 1]]);
  });

  it('counts only messages whose state actually changes', () => {
    const msgs = [
      { id: 'a', account_id: 'work', is_read: true },   // already read: no change when marking read
      { id: 'b', account_id: 'work', is_read: false },
    ];
    assert.deepEqual([...unreadDeltaByAccount(msgs, true, 'work')], [['work', 1]]);
    assert.deepEqual([...unreadDeltaByAccount(msgs, false, 'work')], [['work', 1]]);
  });

  it('charges a message with no account to the acted-on row account', () => {
    const msgs = [{ id: 'x', is_read: false }];
    assert.deepEqual([...unreadDeltaByAccount(msgs, true, 'work')], [['work', 1]]);
  });

  it('is empty when nothing changes', () => {
    assert.equal(unreadDeltaByAccount([{ id: 'a', account_id: 'work', is_read: true }], true, 'work').size, 0);
    assert.equal(unreadDeltaByAccount(null, true, 'work').size, 0);
  });
});

test('fresh post-request authority releases a stranded projection at baseline or target, not by age', () => {
  const initial = sample(1,0,'10');
  const pending = { a: { ...adjustCountPending({},initial,'a',-1,0).a, ackBarrier:'900', ackWriteVersion:2 } };
  const cached = {...sample(0,0,'20'),barrierRevision:'25'};
  assert.ok(settleCountPending(pending,cached,3600000,true,2).a,'cached responses retain blocked projection');
  for (const value of [0,1,2]) {
    const fresh={...sample(value,0,'30'),barrierRevision:'31',recoveryBarrierRevision:'29'};
    fresh.snapshots.a.recoveryBarrierRevision='29';
    assert.deepEqual(settleCountPending(pending,fresh,3600000,true,2),{},'fresh authority wins, including failed mutation baseline or concurrent arrivals');
    assert.ok(settleCountPending(pending,fresh,3600000,false,2).a,'active or overlapping writes cannot be cleared');
    fresh.snapshots.a.stale=true;
    assert.ok(settleCountPending(pending,fresh,3600000,true,2).a,'failed STATUS cannot settle');
    fresh.snapshots.a.stale=false;fresh.recoveryBarrierRevision='30';fresh.snapshots.a.recoveryBarrierRevision='30';
    assert.ok(settleCountPending(pending,fresh,3600000,true,2).a,'pre-request observation cannot settle');
  }
});
test('a cached higher revision kept by merge cannot borrow fresh response proof', () => {
  const initial=sample(1,0,'40');const pending=adjustCountPending({},initial,'a',-1,0);
  const fresh={...sample(0,0,'30'),barrierRevision:'31',recoveryBarrierRevision:'29'};
  fresh.snapshots.a.recoveryBarrierRevision='29';
  const merged=mergeCountSnapshots(initial,fresh);
  assert.ok(settleCountPending(pending,merged,3600000,true,0).a);
});
