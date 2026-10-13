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
  send() {}
}
globalThis.WebSocket = FakeSocket;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useStore } = await import('../store/index.js');
const { useWebSocket } = await import('./useWebSocket.js');
const { registerConnectionRefresh } = await import('../utils/connectionRefresh.js');
registerConnectionRefresh('categories', async () => true);
registerConnectionRefresh('messages', async () => { window.dispatchEvent(new CustomEvent('mailflow:refresh')); return true; });
function App() { useWebSocket(); return null; }
function confirm(ws) { ws.onopen(); ws.onmessage({ data: '{"type":"connected"}' }); }

test('transport open awaits authentication and retains its deadline', async () => {
  const root = createRoot(document.getElementById('root'));
  useStore.getState().setConnectionStatus({ phase: 'unavailable' });
  try {
    await React.act(async () => root.render(React.createElement(App)));
    socket.readyState = WebSocket.OPEN;
    const deadline = socket._connectTimeout;
    await React.act(async () => socket.onopen());
    assert.notEqual(useStore.getState().connectionStatus.phase, 'healthy', 'upgrade is not authentication');
    assert.equal(deadline._destroyed, false, 'OPEN awaiting authentication retains deadline');
    await React.act(async () => socket.onmessage({ data: '{"type":"connected"}' }));
    assert.equal(useStore.getState().connectionStatus.phase, 'healthy');
    assert.equal(deadline._destroyed, true);
  } finally { await React.act(async () => root.unmount()); }
});

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
    await React.act(async () => confirm(first));
    first._lastActivity = Date.now() - 80000;
    await React.act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.notEqual(socket, first, 'half-open socket must be replaced immediately');
    assert.equal(first.onmessage, null, 'retired frames cannot mutate current data');
    let replacement = socket;
    await React.act(async () => window.dispatchEvent(new window.Event('online')));
    assert.equal(socket, replacement, 'rapid resume does not duplicate connecting socket');
    replacement.readyState = WebSocket.OPEN;
    await React.act(async () => confirm(replacement));
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
    await React.act(async () => confirm(active));
    assert.equal(timers.has(active._connectTimeout), false);
    assert.equal(catchUps, 1, 'first successful connection after an outage must reconcile missed data');
    active._lastActivity = Date.now() - 80000;
    await fire(active._pingInterval);
    assert.notEqual(socket, active, 'heartbeat must recover even when close handshake never finishes');
    const restarted = socket;
    restarted.readyState = WebSocket.OPEN;
    await React.act(async () => confirm(restarted));
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

  }
});

test('recovery stays visible until data succeeds; retry is deduplicated and auth uses existing expiry path', async () => {
  const root = createRoot(document.getElementById('root'));
  const original = api.getUnreadCounts, originalNow = Date.now;
  let clock = originalNow(), resolveList, rejectList, calls = 0;
  Date.now = () => clock;
  let listWork = new Promise((resolve, reject) => { resolveList=resolve; rejectList=reject; });
  const removeList = registerConnectionRefresh('messages', async current => { calls++; const result=await listWork; return current() && result; });
  api.getUnreadCounts = async () => ({ total: 0, byAccount: {} });
  try {
    useStore.getState().setConnectionStatus({ phase: 'healthy' });
    await React.act(async () => root.render(React.createElement(App)));
    assert.equal(useStore.getState().connectionStatus.phase,'healthy','cold start has no immediate warning');
    socket.readyState=WebSocket.OPEN;
    await React.act(async () => confirm(socket));
    await React.act(async () => window.dispatchEvent(new window.Event('offline')));
    assert.equal(useStore.getState().connectionStatus.phase,'offline');
    await React.act(async () => window.dispatchEvent(new window.Event('online')));
    socket.readyState=WebSocket.OPEN;
    await React.act(async () => confirm(socket));
    assert.equal(useStore.getState().connectionStatus.phase,'refreshing');
    await React.act(async () => {
      window.dispatchEvent(new CustomEvent('mailflow:connection-retry'));
      window.dispatchEvent(new CustomEvent('mailflow:connection-retry'));
    });
    assert.equal(calls,1,'manual retries cannot duplicate pending refresh');
    await React.act(async () => rejectList(new Error('Synthetic refresh error')));
    assert.equal(useStore.getState().connectionStatus.phase,'refreshError');
    listWork = new Promise(resolve=>{resolveList=resolve;});clock+=1100;
    await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:connection-retry')));
    assert.equal(useStore.getState().connectionStatus.phase,'refreshing');
    await React.act(async () => resolveList(true));
    assert.equal(useStore.getState().connectionStatus.phase,'healthy');
    let expired=0;const onExpired=()=>expired++;
    window.addEventListener('mailflow:session_expired',onExpired);
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async()=>({ok:false,status:401,json:async()=>({error:'Unauthorized'})});
    api.getUnreadCounts=original;
    socket.readyState=WebSocket.CLOSED;
    await React.act(async()=>socket.onclose({code:1008}));
    assert.equal(expired,1);
    assert.equal(useStore.getState().connectionStatus.phase,'blocked');
    globalThis.fetch=originalFetch;window.removeEventListener('mailflow:session_expired',onExpired);
  } finally {
    await React.act(async()=>root.unmount());removeList();api.getUnreadCounts=original;Date.now=originalNow;
  }
});

test('refresh timeout invalidates late values before manual retry succeeds', async () => {
  const root=createRoot(document.getElementById('root'));
  const originalTimeout=globalThis.setTimeout, originalClear=globalThis.clearTimeout, originalCounts=api.getUnreadCounts;
  const deadlines=new Map();let timerId=9000, resolveOld, resolveNew, applied=[];
  globalThis.setTimeout=(fn,delay,...args)=>{if(delay===30000){deadlines.set(++timerId,fn);return timerId;}return originalTimeout(fn,delay,...args);};
  globalThis.clearTimeout=id=>{if(!deadlines.delete(id))originalClear(id);};
  let work=new Promise(resolve=>{resolveOld=resolve;});
  const unregister=registerConnectionRefresh('messages',async current=>{const value=await work;if(!current())return false;applied.push(value);return true;});
  api.getUnreadCounts=async()=>({total:0,byAccount:{}});
  try {
    await React.act(async()=>root.render(React.createElement(App)));socket.readyState=WebSocket.OPEN;await React.act(async()=>confirm(socket));
    await React.act(async()=>window.dispatchEvent(new window.Event('online')));socket.readyState=WebSocket.OPEN;await React.act(async()=>confirm(socket));
    const timeout=[...deadlines][0];assert.ok(timeout);
    await React.act(async()=>{deadlines.delete(timeout[0]);timeout[1]();});
    assert.equal(useStore.getState().connectionStatus.phase,'refreshError');
    work=new Promise(resolve=>{resolveNew=resolve;});
    await React.act(async()=>window.dispatchEvent(new CustomEvent('mailflow:connection-retry')));
    await React.act(async()=>resolveNew('fresh'));
    assert.equal(useStore.getState().connectionStatus.phase,'healthy');
    await React.act(async()=>resolveOld('obsolete'));
    assert.deepEqual(applied,['fresh']);assert.equal(useStore.getState().connectionStatus.phase,'healthy');
  } finally {
    await React.act(async()=>root.unmount());unregister();api.getUnreadCounts=originalCounts;
    globalThis.setTimeout=originalTimeout;globalThis.clearTimeout=originalClear;
  }
});

test('hidden online is remembered until visible focus even with a fresh OPEN socket', async () => {
  const root = createRoot(document.getElementById('root'));
  const originalCounts = api.getUnreadCounts;
  api.getUnreadCounts = async () => ({ byAccount: {} });
  const unregisterMessages = registerConnectionRefresh('messages', async () => true);
  const unregisterCategories = registerConnectionRefresh('categories', async () => true);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    const before = socket;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await React.act(async () => {
      window.dispatchEvent(new window.Event('offline'));
      window.dispatchEvent(new window.Event('online'));
    });
    assert.equal(socket, before, 'background does not duplicate live transport');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await React.act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.notEqual(socket, before, 'fresh OPEN is repaired after remembered offline/online');
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    assert.equal(useStore.getState().connectionStatus.phase, 'healthy');
  } finally {
    await React.act(async () => root.unmount());
    unregisterMessages(); unregisterCategories(); api.getUnreadCounts = originalCounts;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  }
});

test('loaded folder snapshots participate in catch-up and late disconnected folders cannot apply', async () => {
  const root=createRoot(document.getElementById('root'));
  const oldCounts=api.getUnreadCounts, oldFolders=api.getFolders;
  const removeList=registerConnectionRefresh('messages',async()=>true), removeCategories=registerConnectionRefresh('categories',async()=>true);
  let resolveFolders, fail=true;
  api.getUnreadCounts=async()=>({total:0,byAccount:{}});
  api.getFolders=async()=>{if(fail)throw new Error('Synthetic folder failure');return new Promise(resolve=>{resolveFolders=resolve;});};
  useStore.setState({accounts:[{id:'synthetic-a'}],folders:{'synthetic-a':[{path:'Archive',total:1}]}});
  try {
    await React.act(async()=>root.render(React.createElement(App)));socket.readyState=WebSocket.OPEN;await React.act(async()=>confirm(socket));
    await React.act(async()=>window.dispatchEvent(new window.Event('online')));socket.readyState=WebSocket.OPEN;await React.act(async()=>confirm(socket));
    assert.equal(useStore.getState().connectionStatus.phase,'refreshError');
    fail=false;await React.act(async()=>window.dispatchEvent(new CustomEvent('mailflow:connection-retry')));
    assert.equal(useStore.getState().connectionStatus.phase,'refreshing');
    await React.act(async()=>window.dispatchEvent(new window.Event('offline')));
    await React.act(async()=>resolveFolders([{path:'Archive',total:90}]));
    assert.equal(useStore.getState().folders['synthetic-a'][0].total,1);
    await React.act(async()=>window.dispatchEvent(new window.Event('online')));socket.readyState=WebSocket.OPEN;await React.act(async()=>confirm(socket));
    await React.act(async()=>resolveFolders([{path:'Archive',total:2}]));
    assert.equal(useStore.getState().folders['synthetic-a'][0].total,2);
    assert.equal(useStore.getState().connectionStatus.phase,'healthy');
  } finally {
    await React.act(async()=>root.unmount());removeList();removeCategories();api.getUnreadCounts=oldCounts;api.getFolders=oldFolders;dom.window.close();
  }
});
