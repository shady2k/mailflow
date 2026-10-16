import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const eventProof = { accountId: 'synthetic-account', afterRevision: '10' };
const snapshot = (total = 1, revision = '11', extra = {}) => ({ total, complete: true, showAppBadge: true,
  snapshots: { 'synthetic-account': { revision, known: true, stale: false } }, ...extra });
function worker({ clients = [], fetch = async () => ({ ok: true, status: 200, json: async () => snapshot() }), navigator,
  lookup, indexedDB, deadlineNow = false } = {}) {
  const listeners = {}, writes = [], messages = [], notices = [];
  const self = {
    addEventListener: (type, callback) => { (listeners[type] ||= []).push(callback); },
    navigator: navigator || { setAppBadge: async n => writes.push(n), clearAppBadge: async () => writes.push(0) },
    clients: { matchAll: lookup || (async () => clients) },
    registration: { showNotification: async () => { notices.push('shown'); } },
  };
  const timer = (fn, ms) => {
    if (ms === 3000 || (deadlineNow && ms === 4000)) { queueMicrotask(fn); return null; }
    return setTimeout(fn, ms);
  };
  vm.runInNewContext(source, { self, fetch, Promise, AbortController, setTimeout: timer, clearTimeout, indexedDB });
  const run = async (type, event) => {
    const work = [];
    for (const fn of listeners[type]) fn({ ...event, waitUntil: p => work.push(p) });
    await Promise.all(work);
  };
  return { writes, messages, notices, run,
    push: (data = {}) => run('push', { data: { json: () => ({ badgeEvent: eventProof, ...data }) } }),
    inspect: async () => { let reply; await run('message', { data: { type: 'mailflow:sw_diagnostics' }, ports: [{ postMessage: data => { reply = data; } }] }); return reply; },
  };
}
const hidden = () => [{ visibilityState: 'hidden', postMessage() {} }];

test('a visible client retains its optimistic count even with other hidden windows', async () => {
  const messages = [];
  const w = worker({ clients: [...hidden(), { visibilityState: 'visible', postMessage: x => messages.push(x) }],
    fetch: async () => { throw new Error('must not fetch'); } });
  await w.push({ counts: { total: 90 } });
  assert.deepEqual(w.writes, []);
  assert.equal(messages[0].type, 'mailflow:counts_refresh');
  assert.equal(w.notices.length, 1);
});

test('hidden PWA uses fresh HTTP proof, ignoring delayed push tallies', async () => {
  const requests = [];
  const w = worker({ clients: hidden(), fetch: async (url, options) => {
    requests.push({ url, options }); return { ok: true, status: 200, json: async () => snapshot(1) };
  } });
  await w.push({ counts: snapshot(99), unreadCount: 99 });
  assert.deepEqual(w.writes, [1]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/mail/unread-counts');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers['X-Requested-With'], 'MailFlow');
});

test('pre-event complete zero is never applied; coalesced STATUS retry reaches two', async () => {
  const paths = []; let observed = 0;
  const w = worker({ clients: hidden(), fetch: async path => {
    paths.push(path); const data = observed++ < 2 ? snapshot(0, '10') : snapshot(2, '12');
    return { ok: true, status: 200, json: async () => data };
  } });
  await w.push();
  assert.deepEqual(w.writes, [2]);
  assert.deepEqual(paths, ['/api/mail/unread-counts', '/api/mail/unread-counts?refresh=1', '/api/mail/unread-counts?refresh=1']);
  assert.equal(w.notices.length, 1);
  const report = await w.inspect();
  assert.equal(report.events.filter(e => e.event === 'counts_decision' && !e.proof).length, 2);
});

test('missing, stale, other-account and failed STATUS proof never changes badge', async () => {
  for (const data of [snapshot(0, '10'), snapshot(0, '12', { complete: false }),
    snapshot(0, '12', { snapshots: { other: { revision: '12', known: true, stale: false } } }),
    snapshot(0, '12', { snapshots: { 'synthetic-account': { revision: '12', known: true, stale: true } } })]) {
    let calls = 0;
    const w = worker({ fetch: async () => { calls++; return { ok: true, status: 200, json: async () => data }; } });
    await w.push(); assert.equal(calls, 3); assert.deepEqual(w.writes, []);
    assert.ok((await w.inspect()).events.some(e => e.reason === 'fresh_snapshot_unavailable'));
  }
});

test('badge disabled clears without needing a new count, and old queued pushes without proof are skipped', async () => {
  const w = worker({ fetch: async () => ({ ok: true, status: 200, json: async () => snapshot(4, '10', { showAppBadge: false }) }) });
  await w.push(); assert.deepEqual(w.writes, [0]);
  await w.push({ badgeEvent: undefined }); assert.deepEqual(w.writes, [0]);
  assert.ok((await w.inspect()).events.some(e => e.reason === 'missing_event_proof'));
});

test('401 and rejected fetch do not clear badge and record a bounded failure', async () => {
  for (const fetch of [async () => ({ ok: false, status: 401 }), async () => { throw new Error('sensitive URL must never be recorded'); }]) {
    const w = worker({ fetch }); await w.push(); assert.deepEqual(w.writes, []);
    const report = await w.inspect(); assert.ok(report.events.some(e => e.reason === 'fresh_snapshot_unavailable'));
    assert.ok(!JSON.stringify(report).includes('sensitive'));
  }
});

test('fetch timeout terminates retries while notification delivery remains independent', async () => {
  const w = worker({ deadlineNow: true, fetch: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('abort')));
  }) });
  await w.push(); assert.deepEqual(w.writes, []); assert.equal(w.notices.length, 1);
  assert.equal((await w.inspect()).events.filter(e => e.reason === 'timeout').length, 3);
});

test('badge API rejection is reported without leaking error messages', async () => {
  const w = worker({ navigator: { setAppBadge: async () => { throw new Error('private@example.invalid'); } } });
  await w.push(); const report = await w.inspect();
  assert.ok(report.events.some(e => e.event === 'badge_rejected'));
  assert.ok(!JSON.stringify(report).includes('private'));
});

test('a page archive invalidates an in-flight background read and remains the last badge', async () => {
  let release;
  const w = worker({ fetch: async () => {
    await new Promise(resolve => { release = resolve; }); return { ok: true, status: 200, json: async () => snapshot(2) };
  } });
  const push = w.push(); await Promise.resolve(); await Promise.resolve();
  await w.run('message', { data: { type: 'mailflow:badge', total: 0, enabled: true } });
  release(); await push; assert.deepEqual(w.writes, [0]);
});

test('a newer page badge also invalidates the second asynchronous client lookup', async () => {
  let release, lookups = 0;
  const w = worker({ lookup: async () => {
    if (++lookups === 2) await new Promise(resolve => { release = resolve; }); return hidden();
  } });
  const push = w.push(); for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
  assert.ok(release);
  await w.run('message', { data: { type: 'mailflow:badge', total: 0, enabled: true } });
  release(); await push; assert.deepEqual(w.writes, [0]);
});

test('ordered badge queue preserves clear after a slow positive write', async () => {
  let release; const writes = [];
  const w = worker({ navigator: { setAppBadge: async n => { writes.push(n); await new Promise(resolve => { release = resolve; }); }, clearAppBadge: async () => writes.push(0) } });
  const first = w.run('message', { data: { type: 'mailflow:badge', total: 2, enabled: true } });
  const second = w.run('message', { data: { type: 'mailflow:badge', total: 0, enabled: true } });
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  release(); await Promise.all([first, second]); assert.deepEqual(writes, [2, 0]);
});

// Minimal asynchronous IDB double: only the worker's one key and transaction lifecycle.
function persistentStore() {
  let saved, exists = false;
  return { open() {
    const request = {};
    const db = { close() {}, createObjectStore() {}, transaction() {
      const tx = { objectStore: () => ({
        get() { const read = {}; queueMicrotask(() => { read.result = structuredClone(saved); read.onsuccess(); queueMicrotask(() => tx.oncomplete()); }); return read; },
        put(value) { saved = structuredClone(value); },
      }) }; return tx;
    } };
    queueMicrotask(() => { request.result = db; if (!exists) { exists = true; request.onupgradeneeded(); } request.onsuccess(); });
    return request;
  } };
}
test('privacy-safe trace survives worker restart and is bounded', async () => {
  const indexedDB = persistentStore(); const first = worker({ indexedDB });
  for (let i = 0; i < 16; i++) await first.push({ title: 'private@example.invalid', url: '/?m=secret', body: 'secret body' });
  const second = worker({ indexedDB }); const report = await second.inspect();
  assert.equal(report.version, 'badge-event-proof-v1'); assert.equal(report.persisted, true);
  assert.ok(report.events.length > 0 && report.events.length <= 60);
  const json = JSON.stringify(report);
  for (const secret of ['private@', 'secret', 'synthetic-account']) assert.ok(!json.includes(secret));
});

test('notification appears before a blocked client lookup, and lookup failure is recorded', async () => {
  let release;
  const w = worker({ lookup: () => new Promise((_, reject) => { release = reject; }) });
  const task = w.push(); assert.equal(w.notices.length, 1);
  release(new Error('private lookup detail')); await task;
  assert.ok((await w.inspect()).events.some(e => e.reason === 'client_lookup_or_refresh_failed'));
});

test('freshness comparison preserves full 64-bit revision precision', async () => {
  let calls = 0;
  const w = worker({ fetch: async () => ({ ok: true, status: 200,
    json: async () => snapshot(2, calls++ ? '9007199254740994' : '9007199254740993') }) });
  await w.push({ badgeEvent: { ...eventProof, afterRevision: '9007199254740993' } });
  assert.equal(calls, 2); assert.deepEqual(w.writes, [2]);
});

test('unavailable persistent storage never blocks badge or leaks request details', async () => {
  const w = worker({ indexedDB: { open() { throw new Error('storage disabled'); } } });
  await w.push(); assert.deepEqual(w.writes, [1]);
  const report = await w.inspect(); assert.equal(report.persisted, false);
  assert.ok(report.events.some(e => e.event === 'badge_resolved'));
});
