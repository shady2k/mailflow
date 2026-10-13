import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRequest } from './latestRequest.js';

describe('createLatestRequest', () => {
  it('ignores an older response that finishes after a newer response', async () => {
    const pending = [];
    const request = () => new Promise(resolve => pending.push(resolve));
    const applied = [];
    const latest = createLatestRequest();

    const older = latest.run(request, value => applied.push(value));
    const newer = latest.run(request, value => applied.push(value));

    pending[1]('new inbox');
    await newer;
    pending[0]('stale inbox');
    await older;

    assert.deepEqual(applied, ['new inbox']);
  });

  it('ignores an in-flight response after optimistic state invalidates it', async () => {
    let resolveRequest;
    const latest = createLatestRequest();
    const applied = [];
    const inFlight = latest.run(
      () => new Promise(resolve => { resolveRequest = resolve; }),
      value => applied.push(value),
    );

    latest.invalidate();
    resolveRequest('snapshot from before archive');
    await inFlight;

    assert.deepEqual(applied, []);
  });
});

it('coalesces refreshes during an active request and drains the latest after completion', async () => {
  const latest = createLatestRequest();
  let release; const applied = [];
  const first = latest.run(() => new Promise(resolve => { release = resolve; }), value => applied.push(value));
  latest.schedule(() => latest.run(async () => 'obsolete refresh', value => applied.push(value)));
  latest.schedule(() => latest.run(async () => 'fresh refresh', value => applied.push(value)));
  release('first'); await first; await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(applied, ['first', 'fresh refresh']);
});

it('invalidating navigation drops a queued refresh from the old view', async () => {
  const latest = createLatestRequest(); let release; const applied = [];
  const old = latest.run(() => new Promise(resolve => { release = resolve; }), value => applied.push(value));
  latest.schedule(() => latest.run(async () => 'old mailbox', value => applied.push(value)));
  latest.invalidate();
  await latest.run(async () => 'new mailbox', value => applied.push(value));
  release('obsolete'); await old; await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(applied, ['new mailbox']);
});
