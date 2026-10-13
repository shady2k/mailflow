import { Worker } from 'node:worker_threads';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const frontendRequire = createRequire(new URL('../frontend/package.json', import.meta.url));
const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url));
const { JSDOM } = frontendRequire('jsdom');
const TransportWebSocket = backendRequire('ws');
class WebSocket extends TransportWebSocket {
  constructor(url) { super(url); this.on('error', () => {}); }
}
const { transform } = frontendRequire('sucrase');
import { createWebSocketServer, setupWebSocket } from '../backend/src/services/websocket.js';

registerHooks({ load(url, context, next) {
  if (process.env.MAILFLOW_RECONNECT_BASELINE && url.endsWith('/hooks/useWebSocket.js')) return { format: 'module', source: readFileSync(process.env.MAILFLOW_RECONNECT_BASELINE, 'utf8'), shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic' }).code, shortCircuit: true };
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : next(url, context);
} });

// Only the clock is accelerated. WebSocket frames, upgrade/authentication and HTTP
// catch-up cross real localhost sockets through the production backend WS handler.
test('real transport recovers backend restart, session failures and missed data without reload', async () => {
  const originalTimeout = globalThis.setTimeout, originalInterval = globalThis.setInterval;
  let server, wss, port, mode = 'healthy', authFailures = 0, upgrades = 0, revision = 1;
  let httpFailure = false, pending = false, slowList = null, messageReads = 0;
  let countFixture = null, releaseWrite, writeArrived = false;
  const stalledUpgrades = new Set();
  const phases = [], reconnectDelays = [], attempts = [], applied = [];
  const start = async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/mail/messages/bulk-read') {
        writeArrived = true; req.resume();
        releaseWrite = () => { if (res.writableEnded) return; res.setHeader('Content-Type', 'application/json'); res.end('{}'); }; return;
      }
      if (mode === 'expired') { res.writeHead(401); res.end('{"error":"Unauthorized"}'); return; }
      if (httpFailure) { res.writeHead(503); res.end('{"error":"Synthetic outage"}'); return; }
      const reply = () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url.includes('unread')) res.end(JSON.stringify(countFixture || { byAccount: { synthetic: revision }, snapshots: { synthetic: { known: true, stale: false, revision: String(revision), observedAt: new Date().toISOString() } } }));
        else res.end(JSON.stringify({ revision, rows: Array.from({ length: revision }, (_, i) => ({ id: `synthetic-${i}` })) }));
      };
      if (req.url === '/messages' && slowList) slowList.push(reply); else reply();
    });
    wss = createWebSocketServer(server);
    const upgrade = server.listeners('upgrade')[0];
    server.removeAllListeners('upgrade');
    server.on('upgrade', (req, socket, head) => {
      if (mode === 'upgradeSlow') { stalledUpgrades.add(socket); socket.on('close', () => stalledUpgrades.delete(socket)); return; }
      upgrade(req, socket, head);
    });
    setupWebSocket(wss, (req, res, done) => {
      upgrades++; attempts.push({ mode, at: Date.now() });
      if (mode === 'sessionFailure') { authFailures++; done(new Error('Synthetic session-store outage')); return; }
      const authenticate = () => { req.session = mode === 'expired' ? {} : { userId: 'synthetic' }; req.sessionID = 'synthetic-session'; done(); };
      if (mode === 'authSlow') originalTimeout(authenticate, 500); else authenticate();
    }, { connectAllForUser: async () => {} });
    server.listen(port ?? 0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  };
  const stop = async () => {
    for (const socket of stalledUpgrades) socket.destroy();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  };
  await start();
  const dom = new JSDOM('<div id="root"></div>', { url: `http://127.0.0.1:${port}`, pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, WebSocket, IS_REACT_ACT_ENVIRONMENT: true });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => nativeFetch(new URL(url, dom.window.location.href), options);
  const React = await import(frontendRequire.resolve('react'));
  const { createRoot } = await import(frontendRequire.resolve('react-dom/client'));
  const { api } = await import('../frontend/src/utils/api.js');
  const { useStore } = await import('../frontend/src/store/index.js');
  const ConnectionStatus = (await import('../frontend/src/components/ConnectionStatus.jsx')).default;
  const { useWebSocket } = await import('../frontend/src/hooks/useWebSocket.js');
  const { registerConnectionRefresh } = await import('../frontend/src/utils/connectionRefresh.js');
  useStore.setState({ user: { id: 'synthetic' }, accounts: [{ id: 'synthetic', enabled: true }], folders: {}, connectionStatus: { phase: 'unavailable' } });
  const unsubscribe = useStore.subscribe(state => phases.push(state.connectionStatus.phase));
  const read = async path => { const response = await fetch(path); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); };
  const unregisterMessages = registerConnectionRefresh('messages', async current => {
    messageReads++;
    const data = await read('/messages');
    if (!current() || pending) return false;
    applied.push(data.revision); useStore.setState({ messages: data.rows }); return true;
  });
  const unregisterCategories = registerConnectionRefresh('categories', async current => { await read('/categories'); return current(); });
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay >= 1000 && delay < 39000) {
      if (delay >= 1000 && delay < 13000 && delay !== 2000) reconnectDelays.push(delay);
      return originalTimeout(fn, delay * 0.02, ...args);
    }
    return originalTimeout(fn, delay, ...args);
  };
  globalThis.setInterval = (fn, delay, ...args) => originalInterval(fn, delay === 30000 ? 600 : delay, ...args);
  let ref, expired = 0, tab, stopSync;
  const onExpired = () => expired++;
  window.addEventListener('mailflow:session_expired', onExpired);
  function App() { ref = useWebSocket(); return React.createElement(ConnectionStatus); }
  const root = createRoot(document.getElementById('root'));
  const tick = () => React.act(async () => { await new Promise(resolve => originalTimeout(resolve, 10)); });
  const wait = async (predicate, description) => { const deadline = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < deadline, description); await tick(); } };
  const event = async type => React.act(async () => window.dispatchEvent(new window.Event(type)));
  try {
    mode = process.env.MAILFLOW_RECONNECT_SCENARIO === 'auth' ? 'authSlow' : 'sessionFailure';
    await React.act(async () => root.render(React.createElement(App)));
    if (process.env.MAILFLOW_RECONNECT_SCENARIO === 'auth') {
      await wait(() => ref.current.readyState === WebSocket.OPEN, 'real upgrade precedes authentication');
      assert.equal(ref.current._connectTimeout._destroyed, false, 'real OPEN waiting auth must retain deadline');
      assert.notEqual(useStore.getState().connectionStatus.phase, 'healthy');
      return;
    }
    await wait(() => authFailures >= 3, 'actual repeated 1011 failures');
    if (process.env.MAILFLOW_RECONNECT_SCENARIO === 'backoff') assert.ok(reconnectDelays.some(delay => delay >= 4000 && delay <= 5200), 'real1011 failures must increase backoff');
    assert.equal(phases.includes('healthy'), false, 'upgrade must never signal authentication success');
    assert.ok(reconnectDelays.some(delay => delay >= 4000 && delay <= 5200), 'actual session-store failures preserve exponential backoff');
    mode = 'healthy';
    await wait(() => ref.current?._confirmed && useStore.getState().connectionStatus.phase === 'healthy', 'authenticated recovery and catch-up');
    assert.equal(useStore.getState().messages.length, 1);
    const closedCodes = [];
    const old = ref.current; old.addEventListener('close', event => closedCodes.push(event.code));
    await stop(); revision = 2;
    await wait(() => closedCodes.includes(1006), 'real abnormal TCP closure');
    await tick(); await start();
    await wait(() => useStore.getState().messages.length === 2 && useStore.getState().connectionStatus.phase === 'healthy', 'backend restart restores missed mail/counts without reload');
    assert.equal(useStore.getState().unreadCounts.byAccount.synthetic, 2);

    // A real HTTP write remains open across a real WS reset. A second isolated JS
    // context receives production BroadcastChannel messages; the SW runs unmodified.
    const sample = (total, success, attempt = success, stale = false) => ({
      userId: 'synthetic', total, complete: !stale, barrierRevision: String(attempt),
      byAccount: { synthetic: total }, snapshots: { synthetic: { known: true, stale,
        revision: String(success), attemptRevision: String(attempt), observedAt: new Date().toISOString() } },
    });
    countFixture = sample(2, 20);
    useStore.getState().setUnreadCounts(await api.getUnreadCounts());
    const { startCountSync } = await import('../frontend/src/utils/countSync.js');
    const { countWriteState } = await import('../frontend/src/utils/countWrites.js');
    stopSync = startCountSync(useStore);
    const tabEvents = [];
    tab = new Worker(new URL('./count-tab-worker.mjs', import.meta.url), { workerData: { url: window.location.href, counts: countFixture } });
    tab.on('message', message => tabEvents.push(message));
    await wait(() => tabEvents.some(message => message.ready), 'second tab ready');
    const workerListeners = {}, badgeWrites = [];
    const self = { addEventListener: (type, listener) => { workerListeners[type] = listener; },
      clients: { matchAll: async () => [{ postMessage: () => {} }] },
      navigator: { setAppBadge: async total => badgeWrites.push(total), clearAppBadge: async () => badgeWrites.push(0) },
      registration: { showNotification: async () => {} } };
    vm.runInNewContext(readFileSync(new URL('../frontend/public/sw.js', import.meta.url), 'utf8'), { self });
    const sw = async (type, data) => { let done; workerListeners[type]({ data, waitUntil: promise => { done = promise; } }); await done; };
    useStore.getState().decrementUnread('synthetic');
    await wait(() => tabEvents.some(message => message.total === 1 && message.pending === 1), 'other tab receives exact optimistic debit');
    await sw('message', { type: 'mailflow:badge', total: 1, enabled: true });
    const mutation = api.bulkRead(['synthetic-unread'], true);
    await wait(() => writeArrived && countWriteState().pending > 0, 'real POST remains pending');
    countFixture = sample(2, 20, 21, true); // failed STATUS advances attempt only
    useStore.getState().setUnreadCounts(await api.getUnreadCounts());
    assert.equal(useStore.getState().unreadCounts.total, 1);
    for (const client of wss.clients) client.terminate();
    await wait(() => ref.current?._confirmed && useStore.getState().connectionStatus.phase === 'refreshError', 'WS reconnect cannot claim healthy while actual write/snapshot are pending');
    await sw('push', { json: () => ({ unreadCount: 2 }) });
    assert.deepEqual(badgeWrites, [1], 'delayed push cannot overwrite projected badge');
    assert.equal(useStore.getState().unreadCounts.total, 1);
    assert.equal(Object.keys(useStore.getState().pendingCounts).length, 1);
    releaseWrite(); await mutation;
    countFixture = sample(1, 22);
    useStore.getState().setUnreadCounts(await api.getUnreadCounts());
    assert.equal(Object.keys(useStore.getState().pendingCounts).length, 1, 'first post-write snapshot establishes barrier, not acknowledgement');
    tab.postMessage('refresh');
    await wait(() => tabEvents.some(message => message.refreshed), 'other tab establishes its own request barrier');
    countFixture = sample(1, 23);
    useStore.getState().setUnreadCounts(await api.getUnreadCounts());
    assert.equal(Object.keys(useStore.getState().pendingCounts).length, 0, 'new successful STATUS settles actual mutation');
    tab.postMessage('refresh');
    await wait(() => tabEvents.some(message => message.total === 1 && message.pending === 0), 'other tab independently settles same count');
    await event('online');
    await wait(() => useStore.getState().connectionStatus.phase === 'healthy', 'joint catch-up becomes healthy after successful count observation');
    // Undo is a paired optimistic operation and reaches the other tab without drift.
    useStore.getState().decrementUnread('synthetic');
    await wait(() => tabEvents.some(message => message.total === 0), 'other tab optimistic archive');
    useStore.getState().incrementUnread('synthetic');
    await wait(() => tabEvents.at(-1)?.total === 1 && tabEvents.at(-1)?.pending === 0, 'Undo restores both tabs exactly');
    await sw('message', { type: 'mailflow:badge', total: 0, enabled: true });
    await sw('message', { type: 'mailflow:badge', total: 1, enabled: true });
    assert.deepEqual(badgeWrites, [1, 0, 1]);
    stopSync(); stopSync = null; await tab.terminate(); tab = null; countFixture = null;
    console.log(JSON.stringify({ jointMutation: true, realHTTPPost: true, realBroadcastChannel: true, serviceWorkerBadgeCalls: badgeWrites, tabEvents }));


    const beforeSuspend = ref.current;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    await new Promise(resolve => originalTimeout(resolve, 1050));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    await wait(() => ref.current !== beforeSuspend && useStore.getState().connectionStatus.phase === 'healthy', 'mobile suspend/resume repairs real OPEN socket without offline/online');

    // A fresh-looking OPEN socket after a hidden offline/online cycle also needs
    // reconciliation; waiting 75 seconds would leave missed data visible as healthy.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await event('offline'); revision = 3; await event('online');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await event('focus');
    await wait(() => useStore.getState().messages.length === 3 && useStore.getState().connectionStatus.phase === 'healthy', 'hidden online survives until focus');

    // Live transport does not mean successful HTTP catch-up.
    httpFailure = true; await event('online');
    await wait(() => useStore.getState().connectionStatus.phase === 'refreshError', 'HTTP failure keeps recovery warning');
    assert.equal(useStore.getState().messages.length, 3);
    httpFailure = false; pending = true; revision = 4; const beforePending = messageReads;
    await wait(() => messageReads > beforePending && useStore.getState().connectionStatus.phase === 'refreshError', 'pending mutation defers success');
    pending = false;
    await wait(() => useStore.getState().messages.length === 4 && useStore.getState().connectionStatus.phase === 'healthy', 'settled mutation permits automatic retry');

    // A slow obsolete generation cannot apply after a newer connection refresh.
    slowList = []; revision = 5; await event('online');
    await wait(() => slowList.length > 0, 'slow HTTP request reaches real server');
    const releaseOld = slowList; slowList = null; revision = 6;
    await event('online');
    await wait(() => useStore.getState().messages.length === 6 && useStore.getState().connectionStatus.phase === 'healthy', 'new generation settles');
    for (const release of releaseOld) release(); await tick();
    assert.equal(useStore.getState().messages.length, 6);

    // Sleep/stale OPEN recovery replaces the real socket without a close handshake.
    const stale = ref.current; stale._lastActivity = Date.now() - 80000; revision = 7; await event('focus');
    await wait(() => ref.current !== stale && useStore.getState().messages.length === 7 && useStore.getState().connectionStatus.phase === 'healthy', 'stale OPEN repairs and reconciles');

    mode = 'upgradeSlow'; await event('online');
    const connecting = ref.current;
    assert.equal(connecting.readyState, WebSocket.CONNECTING);
    await wait(() => ref.current !== connecting, 'real unanswered upgrade has CONNECTING deadline');
    mode = 'healthy'; await wait(() => useStore.getState().connectionStatus.phase === 'healthy', 'upgrade timeout recovers');

    mode = 'authSlow'; await event('online');
    const unconfirmed = ref.current;
    await wait(() => unconfirmed.readyState === WebSocket.OPEN, 'real upgrade before delayed auth');
    assert.equal(unconfirmed._confirmed, undefined);
    assert.notEqual(useStore.getState().connectionStatus.phase, 'healthy');
    await wait(() => ref.current !== unconfirmed, 'OPEN awaiting authentication has bounded deadline');
    mode = 'healthy'; await wait(() => useStore.getState().connectionStatus.phase === 'healthy', 'auth delay recovery');

    assert.equal(document.querySelector('[data-connection-status]'), null, 'actual healthy banner is hidden after complete HTTP catch-up');
    mode = 'expired'; await event('online');
    await wait(() => useStore.getState().connectionStatus.phase === 'blocked' && expired > 0, 'real1008 and HTTP401 use existing session expiry path');
    assert.ok(document.querySelector('[data-connection-status=blocked]'), 'actual auth warning remains visible');
    const blockedUpgrades = upgrades;
    await event('online'); await event('focus'); await event('mailflow:connection-retry');
    await new Promise(resolve => originalTimeout(resolve, 150));
    assert.equal(upgrades, blockedUpgrades, 'auth expiry cannot retry');
    console.log(JSON.stringify({ realTransport: true, authFailures, upgrades, reconnectDelays, applied, phases: [...new Set(phases)], closeCodes: closedCodes, expired, attempts }));
  } finally {
    if (stopSync) stopSync();
    if (tab) await tab.terminate();
    if (releaseWrite) releaseWrite();
    await React.act(async () => root.unmount());
    unregisterMessages(); unregisterCategories(); unsubscribe();
    useStore.getState().setUser(null);
    window.removeEventListener('mailflow:session_expired', onExpired);
    globalThis.setTimeout = originalTimeout; globalThis.setInterval = originalInterval; globalThis.fetch = nativeFetch;
    await stop(); dom.window.close();
  }
});
