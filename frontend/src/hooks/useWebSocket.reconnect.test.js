import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let socket;
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() { socket = this; this.readyState = 0; }
  close() { this.readyState = 2; }
}
globalThis.WebSocket = FakeSocket;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useWebSocket } = await import('./useWebSocket.js');
function App() { useWebSocket(); return null; }

test('resume replaces half-open transport, catches up once, and respects auth closure', async () => {
  const root = createRoot(document.getElementById('root'));
  const original = api.getUnreadCounts;
  let counts = 0, refreshes = 0;
  api.getUnreadCounts = async () => { counts++; return { total: 0, byAccount: {} }; };
  const refresh = () => refreshes++;
  window.addEventListener('mailflow:refresh', refresh);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    const first = socket;
    first.readyState = WebSocket.OPEN;
    await React.act(async () => first.onopen());
    first._lastActivity = Date.now() - 80000;
    await React.act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.notEqual(socket, first, 'half-open socket must be replaced immediately');
    assert.equal(first.onmessage, null, 'retired frames cannot mutate current data');
    let replacement = socket;
    await React.act(async () => window.dispatchEvent(new window.Event('online')));
    assert.equal(socket, replacement, 'rapid resume does not duplicate connecting socket');
    replacement.readyState = WebSocket.OPEN;
    await React.act(async () => replacement.onopen());
    assert.equal(refreshes, 1);
    assert.equal(counts, 1);
    await React.act(async () => window.dispatchEvent(new window.Event('online')));
    assert.notEqual(socket, replacement, 'online repairs transport even before heartbeat timeout');
    replacement = socket;
    replacement.readyState = WebSocket.CLOSED;
    await React.act(async () => replacement.onclose({ code: 1008 }));
    await React.act(async () => window.dispatchEvent(new window.Event('online')));
    assert.equal(socket, replacement, 'auth policy closure cannot revive endlessly');
  } finally {
    await React.act(async () => root.unmount());
    api.getUnreadCounts = original;
    window.removeEventListener('mailflow:refresh', refresh);

  }
});

test('connection deadline and heartbeat recover without a close event; backend close schedules backoff', async () => {
  const originalTimeout = globalThis.setTimeout, originalInterval = globalThis.setInterval;
  const originalClearTimeout = globalThis.clearTimeout, originalClearInterval = globalThis.clearInterval;
  const timers = new Map(); let id = 1000;
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay >= 1000) { timers.set(++id, { fn, delay, repeat: false }); return id; }
    return originalTimeout(fn, delay, ...args);
  };
  globalThis.setInterval = (fn, delay) => { timers.set(++id, { fn, delay, repeat: true }); return id; };
  globalThis.clearTimeout = (key) => { if (!timers.delete(key)) originalClearTimeout(key); };
  globalThis.clearInterval = (key) => { if (!timers.delete(key)) originalClearInterval(key); };
  const root = createRoot(document.getElementById('root'));
  const originalCounts = api.getUnreadCounts;
  let catchUps = 0;
  api.getUnreadCounts = async () => { catchUps++; return { total: 0, byAccount: {} }; };
  const fire = async (key) => {
    const timer = timers.get(key); assert.ok(timer);
    if (!timer.repeat) timers.delete(key);
    await React.act(async () => timer.fn());
  };
  try {
    await React.act(async () => root.render(React.createElement(App)));
    const stalled = socket;
    await fire(stalled._connectTimeout);
    assert.notEqual(socket, stalled, 'stuck CONNECTING must not wait indefinitely');
    const active = socket;
    active.readyState = WebSocket.OPEN;
    await React.act(async () => active.onopen());
    assert.equal(timers.has(active._connectTimeout), false);
    assert.equal(catchUps, 1, 'first successful connection after an outage must reconcile missed data');
    active._lastActivity = Date.now() - 80000;
    await fire(active._pingInterval);
    assert.notEqual(socket, active, 'heartbeat must recover even when close handshake never finishes');
    const restarted = socket;
    restarted.readyState = WebSocket.OPEN;
    await React.act(async () => restarted.onopen());
    restarted.readyState = WebSocket.CLOSED;
    await React.act(async () => restarted.onclose({ code: 1006 }));
    const backoff = [...timers].find(([, timer]) => !timer.repeat && timer.delay >= 1000 && timer.delay < 1301);
    assert.ok(backoff, 'abnormal backend close uses bounded initial backoff');
    await fire(backoff[0]);
    assert.notEqual(socket, restarted);
  } finally {
    await React.act(async () => root.unmount());
    assert.equal(timers.size, 0, 'unmount releases lifecycle timers');
    api.getUnreadCounts = originalCounts;
    globalThis.setTimeout = originalTimeout; globalThis.setInterval = originalInterval;
    globalThis.clearTimeout = originalClearTimeout; globalThis.clearInterval = originalClearInterval;
    dom.window.close();
  }
});
