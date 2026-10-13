import { parentPort, workerData } from 'node:worker_threads';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
registerHooks({ load(url, context, next) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : next(url, context);
} });
const dom = new JSDOM('', { url: workerData.url });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent });
const fetchNative = globalThis.fetch;
globalThis.fetch = (url, options) => fetchNative(new URL(url, workerData.url), options);
const { useStore } = await import('../frontend/src/store/index.js');
const { startCountSync } = await import('../frontend/src/utils/countSync.js');
const { api } = await import('../frontend/src/utils/api.js');
useStore.setState({ user: { id: 'synthetic' }, accounts: [{ id: 'synthetic', enabled: true }], serverUnreadCounts: workerData.counts, unreadCounts: workerData.counts });
const refresh = async () => { useStore.getState().setUnreadCounts(await api.getUnreadCounts()); };
window.addEventListener('mailflow:counts_refresh', () => refresh().catch(() => {}));
const stop = startCountSync(useStore);
useStore.subscribe(state => parentPort.postMessage({ total: state.unreadCounts.total, pending: Object.keys(state.pendingCounts).length }));
parentPort.on('message', async message => {
  if (message === 'refresh') { await refresh(); parentPort.postMessage({ refreshed: true }); }
  if (message === 'stop') { stop(); dom.window.close(); parentPort.close(); }
});
parentPort.postMessage({ ready: true });
