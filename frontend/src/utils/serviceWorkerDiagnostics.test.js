import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectServiceWorkerDiagnostics } from './serviceWorkerDiagnostics.js';

test('diagnostic report asks the controlling worker for its executing version without downloading code', async () => {
  const worker = { state: 'activated', postMessage(message, ports) {
    assert.equal(message.type, 'mailflow:sw_diagnostics');
    ports[0].postMessage({ version: 'badge-event-proof-v1', events: [], persisted: true });
  } };
  const r = await collectServiceWorkerDiagnostics({ serviceWorker: { controller: worker, getRegistration: async () => ({ active: worker }) } });
  assert.equal(r.runtime.version, 'badge-event-proof-v1'); assert.equal(r.controlled, true); assert.equal(r.active, 'activated');
});
test('old silent worker returns an explicit bounded no-reply reason', async () => {
  const worker = { state: 'activated', postMessage() {} };
  const r = await collectServiceWorkerDiagnostics({ serviceWorker: { controller: worker, getRegistration: async () => ({ active: worker }) }, timeoutMs: 5 });
  assert.equal(r.reason, 'worker_no_reply');
});
test('registration that resolves after deadline cannot create an orphaned message channel', async () => {
  let release, posted = false;
  const lookup = new Promise(resolve => { release = resolve; });
  const r = await collectServiceWorkerDiagnostics({ serviceWorker: { getRegistration: () => lookup }, timeoutMs: 5 });
  assert.equal(r.reason, 'worker_no_reply');
  release({ active: { postMessage() { posted = true; } } }); await Promise.resolve(); await Promise.resolve();
  assert.equal(posted, false);
});
test('unavailable and failing inspection are safe for report generation', async () => {
  assert.deepEqual(await collectServiceWorkerDiagnostics({ serviceWorker: null }), { available: false });
  assert.equal((await collectServiceWorkerDiagnostics({ serviceWorker: { getRegistration: async () => { throw new Error('private'); } } })).reason, 'inspection_failed');
});
