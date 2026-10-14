import test from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

test('copy uses the shared request client and emits the lock event on 423', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalCustomEvent = globalThis.CustomEvent;
  const events = [];
  globalThis.window = { dispatchEvent: event => events.push(event.type) };
  globalThis.CustomEvent = Event;
  try {
    let call;
    globalThis.fetch = async (url, opts) => {
      call = { url, opts };
      return { ok: true, json: async () => ({ copied: true }) };
    };
    assert.deepEqual(await api.copyMessage('m/1', 'Projects'), { copied: true });
    assert.equal(call.url, '/api/mail/messages/m%2F1/copy');
    assert.equal(call.opts.method, 'POST');
    assert.equal(call.opts.headers[CSRF_HEADER], CSRF_VALUE);
    assert.deepEqual(JSON.parse(call.opts.body), { folder: 'Projects' });

    globalThis.fetch = async () => ({ ok: false, status: 423, json: async () => ({ error: 'Locked' }) });
    await assert.rejects(api.copyMessage('m/1', 'Projects'), /Locked/);
    assert.deepEqual(events, ['mailflow:count-write', 'mailflow:count-write', 'mailflow:category-counts-refresh', 'mailflow:count-write', 'mailflow:locked', 'mailflow:count-write', 'mailflow:category-counts-refresh']);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    globalThis.CustomEvent = originalCustomEvent;
  }
});

test('fresh unread recovery preserves per-request write watermark metadata', async () => {
  const oldFetch=globalThis.fetch;let requested;
  globalThis.fetch=async(url)=>{requested=url;return {ok:true,json:async()=>({byAccount:{},barrierRevision:'10'})};};
  try {
    const {api}=await import('./api.js');
    const result=await api.getUnreadCounts({refresh:true});
    assert.equal(requested,'/api/mail/unread-counts?refresh=1');
    assert.equal(typeof result.countWriteVersion,'number');assert.equal(result.countWritesPending,0);
  } finally {globalThis.fetch=oldFetch;}
});
