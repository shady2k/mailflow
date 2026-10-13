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
