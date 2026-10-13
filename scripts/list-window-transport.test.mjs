import { test } from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const frontendRequire = createRequire(new URL('../frontend/package.json', import.meta.url));
const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url));
const { JSDOM } = frontendRequire('jsdom');
const { transform } = frontendRequire('sucrase');
const TransportSocket = backendRequire('ws');
class WebSocket extends TransportSocket { constructor(url) { super(url); this.on('error', () => {}); } }
import { createWebSocketServer, setupWebSocket } from '../backend/src/services/websocket.js';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  const shim = text => text.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
  if (url.endsWith('.jsx')) return { format: 'module', source: shim(transform(readFileSync(process.env.MAILFLOW_LIST_BASELINE_DIR && url.endsWith('/components/MessageList.jsx') ? process.env.MAILFLOW_LIST_BASELINE_DIR + '/frontend/src/components/MessageList.jsx' : new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic' }).code), shortCircuit: true };
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const source = readFileSync(new URL(url), 'utf8');
    if (source.includes('import.meta.env')) return { format: 'module', source: shim(source), shortCircuit: true };
  }
  return next(url, context);
} });

test('real MessageList replays WS refresh during HTTP load and fills after mobile resume without manual paging', async () => {
  const account = { id: 'synthetic', name: 'Synthetic', email_address: 'synthetic@example.invalid', enabled: true, include_in_unified_inbox: true };
  const row = n => ({ id: `synthetic-${n}`, account_id: account.id, folder: 'INBOX', uid: n + 1,
    thread_id: `thread-${n}`, message_id: `<synthetic-${n}@example.invalid>`, subject: `Synthetic ${n}`,
    from_name: 'Synthetic sender', from_email: 'sender@example.invalid', date: new Date().toISOString(),
    is_read: false, message_count: 1, unread_count: 1 });
  let rows = [row(0), row(1)], holdNext = false, held, observations = 1;
  const requests = [], phases = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/mail/messages') {
      const offset = Number(url.searchParams.get('offset')) || 0, limit = Number(url.searchParams.get('limit')) || 50;
      const data = { messages: rows.slice(offset, offset + limit), total: rows.length, nextOffset: Math.min(rows.length, offset + limit), hasMore: offset + limit < rows.length };
      requests.push({ offset, limit, unread: url.searchParams.get('unreadOnly'), rows: data.messages.length });
      if (holdNext) { holdNext = false; held = () => send(data); } else send(data);
    } else if (url.pathname.endsWith('/unread-counts')) {
      send({ userId: 'synthetic-user', total: rows.length, complete: true, byAccount: { synthetic: rows.length },
        snapshots: { synthetic: { revision: String(++observations), totalCount: rows.length, known: true, stale: false, observedAt: new Date().toISOString() } } });
    } else if (url.pathname.endsWith('/folders')) send([{ path: 'INBOX', name: 'INBOX', counts_known: true, counts_stale: false, total_count: rows.length, unread_count: rows.length }]);
    else if (url.pathname.includes('category')) send({ counts: {}, totals: {} });
    else send({});
  });
  const wss = createWebSocketServer(server);
  setupWebSocket(wss, (req, res, done) => { req.session = { userId: 'synthetic-user' }; req.sessionID = 'synthetic-session'; done(); }, { connectAllForUser: async () => {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const dom = new JSDOM('<div id="root"></div>', { url: `http://127.0.0.1:${server.address().port}`, pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent, WebSocket, IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });
  window.innerWidth = 390;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  window.ResizeObserver = globalThis.ResizeObserver;
  const fetchNative = globalThis.fetch;
  globalThis.fetch = (url, options) => fetchNative(new URL(url, window.location.href), options);
  const React = await import(frontendRequire.resolve('react'));
  const { createRoot } = await import(frontendRequire.resolve('react-dom/client'));
  const { useStore } = await import('../frontend/src/store/index.js');
  const { useWebSocket } = await import('../frontend/src/hooks/useWebSocket.js');
  const MessageList = (await import('../frontend/src/components/MessageList.jsx')).default;
  const { getDiagEvents } = await import('../frontend/src/utils/diagEvents.js');
  useStore.setState({ user: { id: 'synthetic-user' }, accounts: [account], accountsReady: true,
    selectedAccountId: account.id, selectedFolder: 'INBOX', scrollMode: 'infinite', pageSize: 2,
    threadedView: true, categorizationEnabled: false, markReadBehavior: 'manual', messages: [],
    folders: { synthetic: [{ path: 'INBOX', name: 'INBOX' }] }, connectionStatus: { phase: 'unavailable' } });
  const unsubscribe = useStore.subscribe(state => phases.push(state.connectionStatus.phase));
  let socket;
  function App() { socket = useWebSocket(); return React.createElement(MessageList); }
  const root = createRoot(document.getElementById('root'));
  const tick = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  const wait = async (predicate, label) => { const until = Date.now() + 6000; while (!predicate()) { assert.ok(Date.now() < until, label); await tick(); } };
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await wait(() => useStore.getState().messages.length === 2 && socket.current?._confirmed, 'initial real list');
    const list = document.querySelector('[data-mailflow-list-scroll]');
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 650 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 100 + useStore.getState().messages.length * 200 });
    holdNext = true;
    const unread = [...document.querySelectorAll('button')].find(button => button.title === 'Unread only');
    assert.ok(unread);
    await React.act(async () => unread.click());
    await wait(() => !!held, 'filtered GET held at real server');
    rows = [...rows, row(2)];
    for (const client of wss.clients) client.send(JSON.stringify({ type: 'sync_complete', accountId: account.id }));
    await tick(); await React.act(async () => held());
    await wait(() => useStore.getState().messages.length === 3, 'missed WS refresh and underfilled viewport recover automatically');
    assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'Load more'), false);
    const before = socket.current;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    rows = [...rows, row(3)]; await new Promise(resolve => setTimeout(resolve, 1050));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await React.act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    await wait(() => socket.current !== before && useStore.getState().messages.length === 4 && useStore.getState().connectionStatus.phase === 'healthy', 'same mounted real MessageList catches missed rows on resume');
    assert.deepEqual(useStore.getState().messages.map(message => message.id).sort(), rows.map(message => message.id).sort());
    console.log(JSON.stringify({ realHTTP: true, realWS: true, actualMessageList: true, viewport: 390,
      reloaded: false, remounted: false, manualLoadMoreClicks: 0, restoredRows: 4, requests,
      phases: [...new Set(phases)], diagnosticPageEvents: getDiagEvents().filter(event => event.category === 'list').length }));
  } finally {
    await React.act(async () => root.unmount()); unsubscribe(); useStore.getState().setUser(null);
    globalThis.fetch = fetchNative; dom.window.close();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
