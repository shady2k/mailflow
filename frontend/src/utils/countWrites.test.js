import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginCountWrite, countWriteState, receiveCountWrite, clearRemoteCountWrites } from './countWrites.js';

test('write barriers retain overlapping requests and finish idempotently', () => {
  const initial = countWriteState();
  const finishA = beginCountWrite(), finishB = beginCountWrite();
  assert.equal(countWriteState().pending, initial.pending + 2);
  finishA(); const once = countWriteState(); finishA();
  assert.deepEqual(countWriteState(), once);
  assert.equal(once.pending, initial.pending + 1);
  finishB(); assert.equal(countWriteState().pending, initial.pending);
  assert.equal(countWriteState().version, initial.version + 4);
});
test('reordered remote notifications cannot recreate a finished write', () => {
  const before = countWriteState();
  receiveCountWrite({ id: 'synthetic-finished-first', phase: 'finish' });
  receiveCountWrite({ id: 'synthetic-finished-first', phase: 'start' });
  receiveCountWrite({ id: 'synthetic-finished-first', phase: 'finish' });
  assert.equal(countWriteState().pending, before.pending);
  assert.equal(countWriteState().version, before.version + 1);
});
test('unmount clears remote barriers while preserving local writes', () => {
  const before = countWriteState();
  const finish = beginCountWrite();
  receiveCountWrite({ id: 'synthetic-remote', phase: 'start' });
  clearRemoteCountWrites();
  assert.equal(countWriteState().pending, before.pending + 1);
  finish(); assert.equal(countWriteState().pending, before.pending);
});
