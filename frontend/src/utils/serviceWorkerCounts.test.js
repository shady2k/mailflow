import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('a delayed push cannot restore the badge after a live client archives mail', async () => {
  const listeners = {}, writes = [], messages = [];
  const self = {
    addEventListener: (type, callback) => { listeners[type] = callback; },
    navigator: { setAppBadge: async n => writes.push(n), clearAppBadge: async () => writes.push(0) },
    clients: { matchAll: async () => [{ visibilityState: 'visible', postMessage: data => messages.push(data) }] },
    registration: { showNotification: async () => {} },
  };
  vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), { self });
  writes.push(1); // The authoritative live store has already projected archive 2 -> 1.
  let done;
  listeners.push({ data: { json: () => ({ unreadCount: 2 }) }, waitUntil: promise => { done = promise; } });
  await done;
  assert.deepEqual(writes, [1], 'push must invalidate the client, not overwrite its optimistic count');
  assert.equal(messages[0]?.type, 'mailflow:counts_refresh');
});

function worker({ clients = [], fetch, navigator } = {}) {
  const listeners = {}, writes = [];
  const self = {
    addEventListener: (type, callback) => { listeners[type] = callback; },
    navigator: navigator || { setAppBadge: async n => writes.push(n), clearAppBadge: async () => writes.push(0) },
    clients: { matchAll: async () => clients }, registration: { showNotification: async () => {} },
  };
  vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), { self, fetch, Promise });
  const run = (type, event) => { let done; listeners[type]({ ...event, waitUntil: promise => { done = promise; } }); return done; };
  return { writes, run };
}
test('clientless push uses fresh complete INBOX snapshot and badge preference, never its raw tally', async () => {
  const requests = [];
  let enabled = true, complete = true, status = true;
  const w = worker({ fetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: status, json: async () => url.includes('preferences') ? { showAppBadge: enabled } : { total: 1, complete } };
  } });
  const push = () => w.run('push', { data: { json: () => ({ unreadCount: 90 }) } });
  await push();
  assert.deepEqual(w.writes, [1]);
  assert.equal(requests[0].options.headers['X-Requested-With'], 'MailFlow');
  complete = false; await push();
  assert.deepEqual(w.writes, [1], 'unknown/stale snapshot cannot clear or invent a count');
  enabled = false; await push();
  assert.deepEqual(w.writes, [1, 0]);
  status = false; await push();
  assert.deepEqual(w.writes, [1, 0], 'auth/network failure leaves last known badge');
});
test('controlled clients share an ordered badge queue, including clear after archive', async () => {
  let release;
  const writes = [];
  const w = worker({ navigator: {
    setAppBadge: async n => { writes.push(n); await new Promise(resolve => { release = resolve; }); },
    clearAppBadge: async () => writes.push(0),
  } });
  const first = w.run('message', { data: { type: 'mailflow:badge', total: 2, enabled: true } });
  const second = w.run('message', { data: { type: 'mailflow:badge', total: 0, enabled: true } });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(writes, [2]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(writes, [2, 0]);
});

test('an in-flight clientless push read cannot overwrite a newer controlled badge', async () => {
  let release;
  const w = worker({ fetch: async url => {
    if (url.includes('preferences')) return { ok: true, json: async () => ({ showAppBadge: true }) };
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ total: 2, complete: true }) };
  } });
  const oldPush = w.run('push', { data: { json: () => ({ unreadCount: 2 }) } });
  await Promise.resolve(); await Promise.resolve();
  await w.run('message', { data: { type: 'mailflow:badge', total: 0, enabled: true } });
  release(); await oldPush;
  assert.deepEqual(w.writes, [0], 'newer page archive invalidates the older push HTTP read');
});


test('push refreshes the OS badge while an existing PWA window is hidden and suspended', async () => {
  const messages = [];
  const w = worker({
    clients: [{ visibilityState: 'hidden', postMessage: data => messages.push(data) }],
    fetch: async url => ({ ok: true, json: async () => url.includes('preferences')
      ? { showAppBadge: true } : { total: 1, complete: true } }),
  });
  await w.run('push', { data: { json: () => ({ counts: { total: 99 } }) } });
  assert.deepEqual(w.writes, [1], 'fresh snapshot updates badge without waiting for the suspended page');
  assert.equal(messages[0]?.type, 'mailflow:counts_refresh');
});

test('a visible client keeps ownership even with other hidden windows', async () => {
  const w = worker({
    clients: [
      { visibilityState: 'hidden', postMessage() {} },
      { visibilityState: 'visible', postMessage() {} },
    ],
    fetch: async () => { throw new Error('visible store must retain its projection'); },
  });
  await w.run('push', { data: { json: () => ({ counts: { total: 99 } }) } });
  assert.deepEqual(w.writes, []);
});

test('a newer page badge invalidates a push while its second client lookup is pending', async () => {
  let release, lookups = 0;
  const listeners = {}, writes = [];
  const self = {
    addEventListener: (type, callback) => { listeners[type] = callback; },
    navigator: { setAppBadge: async n => writes.push(n), clearAppBadge: async () => writes.push(0) },
    clients: { matchAll: async () => {
      if (++lookups === 2) await new Promise(resolve => { release = resolve; });
      return [{ visibilityState: 'hidden', postMessage() {} }];
    } },
    registration: { showNotification: async () => {} },
  };
  const fetch = async url => ({ ok: true, json: async () => url.includes('preferences')
    ? { showAppBadge: true } : { total: 2, complete: true } });
  vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), { self, fetch });
  let done;
  listeners.push({ data: { json: () => ({}) }, waitUntil: promise => { done = promise; } });
  for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
  assert.ok(release);
  let pageDone;
  listeners.message({ data: { type: 'mailflow:badge', total: 0, enabled: true }, waitUntil: p => { pageDone = p; } });
  await pageDone;
  release(); await done;
  assert.deepEqual(writes, [0]);
});
