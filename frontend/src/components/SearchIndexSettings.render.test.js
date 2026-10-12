import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };


const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { default: SearchIndexSettings } = await import('./SearchIndexSettings.jsx');
let root, accounts, fail, calls;
const host = document.getElementById('root');
globalThis.fetch = async (path, init) => {
  calls.push({ path, init });
  if (fail) return { ok: false, status: 500, json: async () => ({ error: 'Private provider diagnostics' }) };
  if (init.method === 'POST') {
    const { action } = JSON.parse(init.body);
    if (action !== 'retry') accounts[0] = { ...accounts[0], paused: action === 'pause', state: action === 'pause' ? 'paused' : 'queued' };
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return { ok: true, json: async () => ({ accounts }) };
};
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const click = text => act(async () => {
  const button = [...host.querySelectorAll('button')].find(el => el.textContent === text);
  assert.ok(button, text); assert.equal(button.disabled, false);
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
beforeEach(() => {
  calls = []; fail = false;
  accounts = [{ account_id: 'test-account', account_name: 'Synthetic mailbox', paused: false, state: 'user_active', headers_loaded: 5, bodies_searchable: 3, pending: 2, failed: 1 }];
});
afterEach(async () => { if (root) await act(async () => { root.unmount(); }); root = null; });
const mount = async () => {
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(SearchIndexSettings)); });
  await flush();
};
describe('Search and indexing settings', () => {
  test('renders safe reason codes, coverage and an actual refresh button', async () => {
    await mount();
    assert.match(host.textContent, /searchIndex.userActive/);
    assert.match(host.textContent, /"headers":5/);
    assert.ok(host.querySelector('section[aria-label="searchIndex.title"]'));
    const before = calls.length;
    await click('searchIndex.refresh'); await flush();
    assert.ok(calls.length > before);
  });
  test('persists pause and resume then refreshes status', async () => {
    await mount();
    await click('searchIndex.pause'); await flush();
    assert.match(host.textContent, /searchIndex.paused/);
    await click('searchIndex.resume'); await flush();
    assert.deepEqual(calls.filter(c => c.init.method === 'POST').map(c => JSON.parse(c.init.body).action), ['pause', 'resume']);
  });
  test('retries failed work and keeps pause, without a clear-cache operation', async () => {
    accounts[0].paused = true; accounts[0].state = 'paused';
    await mount();
    await click('searchIndex.retry'); await flush();
    assert.equal(calls.filter(c => c.init.method === 'POST')[0].init.body, '{"action":"retry"}');
    assert.equal([...host.querySelectorAll('button')].some(b => /clear|rebuild/i.test(b.textContent)), false);
  });
  test('localizes fetch and action errors instead of exposing raw server text', async () => {
    await mount(); fail = true;
    await click('searchIndex.pause'); await flush();
    assert.equal(host.querySelector('[role="alert"]').textContent.trim(), 'searchIndex.actionFailed');
    assert.doesNotMatch(host.textContent, /Private provider/);
    await click('searchIndex.refresh'); await flush();
    assert.match(host.textContent, /searchIndex.unavailable|searchIndex.actionFailed/);
  });
  test('focus refreshes status and completed accounts offer no retry', async () => {
    accounts[0].failed = 0; accounts[0].pending = 0; accounts[0].state = 'complete';
    await mount();
    const button = [...host.querySelectorAll('button')].find(el => el.textContent === 'searchIndex.retry');
    assert.equal(button.disabled, true);
    const before = calls.length;
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    await flush(); assert.ok(calls.length > before);
  });
});
