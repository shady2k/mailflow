import { test } from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
registerHooks({ load(url, context, nextLoad) {
  if (process.env.MAILFLOW_WEBSOCKET_BASELINE && url.endsWith('/hooks/useWebSocket.js')) return { format: 'module', source: readFileSync(process.env.MAILFLOW_WEBSOCKET_BASELINE, 'utf8'), shortCircuit: true };
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

test('mobile suspend/resume repairs a fresh-looking OPEN without network events', async () => {
  const root = createRoot(document.getElementById('root'));
  const originalCounts = api.getUnreadCounts, originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  api.getUnreadCounts = async () => ({ byAccount: {} });
  const removeMessages = registerConnectionRefresh('messages', async () => true);
  const removeCategories = registerConnectionRefresh('categories', async () => true);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    const before = socket;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    now += 5000;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    assert.notEqual(socket, before, 'suspended OPEN must be replaced before 75s heartbeat expiry');
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    assert.equal(useStore.getState().connectionStatus.phase, 'healthy');
  } finally {
    await React.act(async () => root.unmount()); Date.now = originalNow;
    api.getUnreadCounts = originalCounts; removeMessages(); removeCategories();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  }
});

test('stranded projection recovery requests fresh authority; retry settles only post-request STATUS', async () => {
  const root=createRoot(document.getElementById('root'));const oldCounts=api.getUnreadCounts,oldNow=Date.now;
  let now=oldNow(),fresh=false,requested=[];Date.now=()=>now;
  const removeList=registerConnectionRefresh('messages',async()=>true),removeCategories=registerConnectionRefresh('categories',async()=>true);
  useStore.getState().setUser({id:'synthetic-recovery-user'});useStore.getState().setLocked(false);
  const {countWriteState}=await import('../utils/countWrites.js');
  useStore.setState({accounts:[{id:'a',enabled:true}],folders:{},pendingCounts:{a:{base:1,delta:-1,openedAt:now-3600000,expiresAt:now+15000,sinceRevision:'10',ackBarrier:'900',ackWriteVersion:countWriteState().version}}});
  api.getUnreadCounts=async options=>{
    requested.push(options?.refresh);
    return {userId:'synthetic-recovery-user',total:0,byAccount:{a:0},complete:true,
      barrierRevision:'31',recoveryBarrierRevision:'29',countWriteVersion:countWriteState().version,countWritesPending:0,
      snapshots:{a:{known:true,stale:false,observedAt:new Date().toISOString(),revision:fresh?'30':'29',recoveryBarrierRevision:'29'}}};
  };
  try {
    await React.act(async()=>root.render(React.createElement(App)));socket.readyState=WebSocket.OPEN;await React.act(async()=>confirm(socket));
    await React.act(async()=>window.dispatchEvent(new window.Event('online')));socket.readyState=WebSocket.OPEN;await React.act(async()=>confirm(socket));
    assert.equal(useStore.getState().connectionStatus.phase,'refreshing','a cached sample cannot clear readiness or claim a failed request');
    assert.ok(useStore.getState().pendingCounts.a);
    fresh=true;now+=1100;
    await React.act(async()=>window.dispatchEvent(new CustomEvent('mailflow:connection-retry')));
    assert.equal(requested.at(-1),true);assert.deepEqual(useStore.getState().pendingCounts,{});
    assert.equal(useStore.getState().connectionStatus.phase,'healthy');
  } finally {
    await React.act(async()=>root.unmount());removeList();removeCategories();api.getUnreadCounts=oldCounts;Date.now=oldNow;
    useStore.setState({pendingCounts:{},accounts:[],folders:{}});
  }
});

for (const deferredPart of ['counts', 'messages']) test(`a deferred ${deferredPart} refresh retries without a false error and becomes healthy only after catch-up`, async () => {
  const root = createRoot(document.getElementById('root'));
  const originalCounts = api.getUnreadCounts, originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const retries = new Map(); let timerId = 80000, ready = false, listCalls = 0;
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay === 5000) { retries.set(++timerId, fn); return timerId; }
    return originalTimeout(fn, delay, ...args);
  };
  globalThis.clearTimeout = id => { if (!retries.delete(id)) originalClear(id); };
  const removeMessages = registerConnectionRefresh('messages', async () => { listCalls++; return deferredPart !== 'messages' || ready; });
  const removeCategories = registerConnectionRefresh('categories', async () => true);
  useStore.setState({ folders: {}, pendingCounts: {}, categoryPendingRemovals: {} });
  api.getUnreadCounts = async () => ({ byAccount: {}, complete: deferredPart !== 'counts' || ready });
  try {
    await React.act(async () => root.render(React.createElement(App)));
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    await React.act(async () => window.dispatchEvent(new window.Event('online')));
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    assert.equal(listCalls, 1, 'the message request itself completed');
    assert.equal(useStore.getState().connectionStatus.phase, 'refreshing');
    assert.equal(retries.size, 1, 'incomplete readiness has a bounded automatic retry');
    ready = true;
    await React.act(async () => { const [id, retry] = [...retries][0]; retries.delete(id); retry(); });
    assert.equal(listCalls, 2);
    assert.equal(useStore.getState().connectionStatus.phase, 'healthy');
    assert.equal(retries.size, 0);
  } finally {
    await React.act(async () => root.unmount());
    removeMessages(); removeCategories(); api.getUnreadCounts = originalCounts;
    globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear;
  }
});

test('manual retry replaces an OPEN socket still awaiting authentication instead of doing nothing', async () => {
  const root = createRoot(document.getElementById('root'));
  const originalCounts = api.getUnreadCounts;
  const removeMessages = registerConnectionRefresh('messages', async () => true);
  const removeCategories = registerConnectionRefresh('categories', async () => true);
  api.getUnreadCounts = async () => ({ byAccount: {}, complete: true });
  useStore.setState({ folders: {}, pendingCounts: {} });
  try {
    await React.act(async () => root.render(React.createElement(App)));
    const unconfirmed = socket;
    socket.readyState = WebSocket.OPEN;
    await React.act(async () => socket.onopen());
    useStore.getState().setConnectionStatus({ phase: 'refreshError' });
    await React.act(async () => window.dispatchEvent(new CustomEvent('mailflow:connection-retry')));
    assert.notEqual(socket, unconfirmed);
    assert.equal(useStore.getState().connectionStatus.phase, 'connecting');
    socket.readyState = WebSocket.OPEN;
    await React.act(async () => confirm(socket));
    assert.equal(useStore.getState().connectionStatus.phase, 'healthy');
  } finally {
    await React.act(async () => root.unmount());
    removeMessages(); removeCategories(); api.getUnreadCounts = originalCounts;
  }
});

for (const inFlight of [false, true]) test(`settled count readiness wakes before the 5s watchdog${inFlight ? ', including during an in-flight list request' : ''}`, async () => {
  const root = createRoot(document.getElementById('root'));
  const oldCounts = api.getUnreadCounts, oldTimeout = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  const watchdogs = new Map(); let timer = 95000, ready = false, listCalls = 0, release;
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay === 5000) { watchdogs.set(++timer, fn); return timer; }
    return oldTimeout(fn, delay, ...args);
  };
  globalThis.clearTimeout = id => { if (!watchdogs.delete(id)) oldClear(id); };
  const stopMessages = registerConnectionRefresh('messages', async () => {
    listCalls++;
    if (inFlight && listCalls === 1) return new Promise(resolve => { release = resolve; });
    return true;
  });
  let categoryReady = false;
  const stopCategories = registerConnectionRefresh('categories', async () => categoryReady);
  useStore.setState({ accounts: [], folders: {}, pendingCounts: {}, categoryPendingRemovals: {} });
  api.getUnreadCounts = async () => ({ byAccount: {}, complete: ready });
  try {
    await React.act(async () => root.render(React.createElement(App)));
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    await React.act(async () => window.dispatchEvent(new window.Event('online')));
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    assert.equal(listCalls, 1);
    assert.equal(useStore.getState().connectionStatus.phase, 'refreshing');
    // A separate HTTP/WS snapshot settles the old projection while the banner is pending.
    ready = true;
    await React.act(async () => {
      useStore.setState({ pendingCounts: { a: { base: 1, delta: -1 } } });
      useStore.setState({ pendingCounts: {} });
      release?.(true);
      await new Promise(resolve => oldTimeout(resolve, 20));
    });
    assert.equal(listCalls, 2, 'settlement wakes a full catch-up without firing the watchdog');
    assert.equal(useStore.getState().connectionStatus.phase, 'refreshing', 'unconfirmed categories must still hold readiness');
    assert.equal(watchdogs.size, 1);
    categoryReady = true;
    await React.act(async () => {
      window.dispatchEvent(new CustomEvent('mailflow:connection-scope'));
      await new Promise(resolve => oldTimeout(resolve, 20));
    });
    assert.equal(useStore.getState().connectionStatus.phase, 'healthy');
    assert.equal(watchdogs.size, 0);
  } finally {
    await React.act(async () => root.unmount()); stopMessages(); stopCategories();
    api.getUnreadCounts = oldCounts; globalThis.setTimeout = oldTimeout; globalThis.clearTimeout = oldClear;
    useStore.setState({ pendingCounts: {}, accounts: [], folders: {} });
  }
});

test('finishing the last pending write wakes readiness without requiring a projection transition', async () => {
  const { beginCountWrite, countWriteState } = await import('../utils/countWrites.js');
  const root = createRoot(document.getElementById('root'));
  const oldCounts = api.getUnreadCounts, oldTimeout = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  const watchdogs = new Map(); let timer = 97000, listCalls = 0;
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay === 5000) { watchdogs.set(++timer, fn); return timer; }
    return oldTimeout(fn, delay, ...args);
  };
  globalThis.clearTimeout = id => { if (!watchdogs.delete(id)) oldClear(id); };
  const stopMessages = registerConnectionRefresh('messages', async () => { listCalls++; return true; });
  const stopCategories = registerConnectionRefresh('categories', async () => true);
  useStore.setState({ accounts: [], folders: {}, pendingCounts: {} });
  api.getUnreadCounts = async () => ({ byAccount: {}, complete: true });
  const finishOne = beginCountWrite(), finishTwo = beginCountWrite();
  try {
    await React.act(async () => root.render(React.createElement(App)));
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    await React.act(async () => window.dispatchEvent(new window.Event('online')));
    socket.readyState = WebSocket.OPEN; await React.act(async () => confirm(socket));
    assert.equal(countWriteState().pending, 2); assert.equal(listCalls, 1);
    assert.equal(useStore.getState().connectionStatus.phase, 'refreshing');
    await React.act(async () => { finishOne(); await new Promise(resolve => oldTimeout(resolve, 20)); });
    assert.equal(listCalls, 1, 'an outstanding second write must still hold the gate');
    assert.equal(useStore.getState().connectionStatus.phase, 'refreshing');
    await React.act(async () => { finishTwo(); await new Promise(resolve => oldTimeout(resolve, 20)); });
    assert.equal(listCalls, 2); assert.equal(useStore.getState().connectionStatus.phase, 'healthy');
    assert.equal(watchdogs.size, 0);
  } finally {
    finishOne(); finishTwo(); await React.act(async () => root.unmount()); stopMessages(); stopCategories();
    api.getUnreadCounts = oldCounts; globalThis.setTimeout = oldTimeout; globalThis.clearTimeout = oldClear;
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
