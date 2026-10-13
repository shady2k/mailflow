import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMessageWindow } from './messageWindow.js';

test('loaded window uses bounded pages and deduplicates an arrival at the page boundary', async () => {
  const calls = [];
  const result = await fetchMessageWindow(async params => {
    calls.push(params);
    return { total: 650, messages: Array.from({ length: params.limit }, (_, i) => ({ id: String(params.offset + i - (params.offset ? 1 : 0)) })) };
  }, { accountId: 'synthetic' }, 620);
  assert.deepEqual(calls.map(({ offset, limit }) => [offset, limit]), [[0, 500], [500, 120], [620, 1]]);
  assert.equal(result.messages.length, 620);
});
test('a failed later page rejects the refresh instead of publishing a truncated window', async () => {
  await assert.rejects(fetchMessageWindow(async ({ offset, limit }) => {
    if (offset) throw new Error('Synthetic second-page outage');
    return { total: 650, messages: Array.from({ length: limit }, (_, i) => ({ id: String(i) })) };
  }, {}, 620), /second-page outage/);
});

test('explicit cursors fill a selected page over hidden rows without fetching the mailbox', async () => {
  const calls = [];
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
  const result = await fetchMessageWindow(async p => {
    calls.push(p);
    return { messages: rows.slice(p.offset, p.offset + p.limit), total: 100, nextOffset: p.offset + p.limit, hasMore: p.offset + p.limit < 100 };
  }, { offset: 0 }, 3, chunk => chunk.filter(row => row.id !== '0'));
  assert.deepEqual(result.messages.map(row => row.id), ['1', '2', '3']);
  assert.deepEqual(calls.map(({ offset, limit }) => [offset, limit]), [[0, 3], [3, 1]]);
  assert.equal(result.nextOffset, 4);
});
test('stale totals and a repeating page cannot create an endless automatic loader', async () => {
  const end = await fetchMessageWindow(async () => ({ messages: [{ id: 'a' }], total: 999 }), {}, 50);
  assert.equal(end.hasMore, false);
  await assert.rejects(fetchMessageWindow(async () => ({ messages: [{ id: 'a' }], total: 999, hasMore: true, nextOffset: 1 }), {}, 50), /Repeated message page/);
});

import { fetchMessagePage } from './messageWindow.js';
test('an emptied last page moves to the last remaining page atomically', async () => {
  const calls = [];
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: String(i) }));
  const result = await fetchMessagePage(async p => {
    calls.push(p.offset);
    return { messages: rows.slice(p.offset, p.offset + p.limit), total: rows.length, nextOffset: p.offset + Math.max(0, rows.slice(p.offset, p.offset + p.limit).length), hasMore: false };
  }, { offset: 10 }, 5);
  assert.deepEqual(calls, [10, 5]);
  assert.deepEqual(result.messages.map(row => row.id), ['5', '6', '7', '8']);
  assert.equal(result.pageOffset, 5);
});
