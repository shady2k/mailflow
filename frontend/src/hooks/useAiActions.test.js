import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import i18next from 'i18next';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js')) return { format: 'module', shortCircuit: true,
    source: 'export const useTranslation=()=>({t:globalThis.aiTestI18n.t.bind(globalThis.aiTestI18n),i18n:globalThis.aiTestI18n});' };
  if (url.endsWith('/store/index.js')) return { format: 'module', shortCircuit: true,
    source: 'export const useStore=select=>select({aiActions:[]});' };
  if (url.endsWith('/utils/api.js')) return { format: 'module', shortCircuit: true,
    source: 'export const api={ai:{chat:(...args)=>globalThis.aiTestChat(...args)}};' };
  return nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const locales = ['en', 'ru', 'de', 'fr', 'es', 'it', 'cs', 'pl', 'ptBR', 'zhCN', 'ko'];
const resources = Object.fromEntries(locales.map(lang => [lang, { translation: JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8')) }]));
globalThis.aiTestI18n = i18next.createInstance();
await globalThis.aiTestI18n.init({ lng: 'en', resources, interpolation: { escapeValue: false } });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useAiActions } = await import('./useAiActions.js');
const { BUILTIN_SUMMARIZE, summarizePromptForLocale } = await import('../aiActions.js');
const { getResults } = await import('../aiResults.js');
const custom = { id: 'synthetic-custom', label: 'Synthetic action', prompt: 'Preserve the complete synthetic message.' };
async function fixture(body, lang, check) {
  localStorage.clear(); await globalThis.aiTestI18n.changeLanguage(lang);
  const calls = []; globalThis.aiTestChat = async (messages, options) => { calls.push({ messages, options }); return 'Synthetic result'; };
  let actions;
  function App() { actions = useAiActions('synthetic-message', body); return null; }
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await check({ calls, run: async (action, opts) => React.act(async () => actions.run(action, opts)), results: () => actions.results });
  } finally { await React.act(async () => root.unmount()); }
}
for (const action of [BUILTIN_SUMMARIZE, custom]) {
  test(`${action.id} sends the complete body beyond 6000, including its tail`, async () => {
    const text = 'Synthetic '.repeat(800) + 'TAIL_SENTINEL';
    await fixture({ text }, 'ru', async ({ calls, run, results }) => {
      await run(action);
      const prompt = action.builtin ? summarizePromptForLocale('ru') : action.prompt;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].messages[0].content, `${prompt}\n\n${text}`);
      assert.ok(calls[0].messages[0].content.endsWith('TAIL_SENTINEL'));
      assert.equal(results()[action.id].status, 'done');
      assert.equal(getResults('synthetic-message')[action.id].text, 'Synthetic result');
    });
  });
  test(`${action.id} accepts exactly 32000 including its localized prompt and separators`, async () => {
    const prompt = action.builtin ? summarizePromptForLocale('ru') : action.prompt;
    const text = 'x'.repeat(32000 - prompt.length - 2 - 4) + 'TAIL';
    await fixture({ text }, 'ru', async ({ calls, run }) => {
      await run(action); assert.equal(calls.length, 1);
      assert.equal(calls[0].messages[0].content.length, 32000);
      assert.ok(calls[0].messages[0].content.endsWith('TAIL'));
    });
  });
  test(`${action.id} rejects 32001 including prompt, sends nothing and caches no result`, async () => {
    const prompt = action.builtin ? summarizePromptForLocale('ru') : action.prompt;
    await fixture({ text: 'x'.repeat(32001 - prompt.length - 2) }, 'ru', async ({ calls, run, results }) => {
      await run(action); assert.equal(calls.length, 0);
      assert.equal(results()[action.id].status, 'error');
      assert.match(results()[action.id].text, /32001/); assert.match(results()[action.id].text, /32000/);
      assert.equal(getResults('synthetic-message')[action.id], undefined);
    });
  });
}
test('HTML fallback keeps its complete extracted tail; plain text still takes precedence', async () => {
  const text = 'synthetic '.repeat(800) + 'HTML_TAIL';
  await fixture({ html: `<p>${text}</p>` }, 'en', async ({ calls, run }) => {
    await run(custom); assert.equal(calls[0].messages[0].content, `${custom.prompt}\n\n${text}`);
  });
  await fixture({ text: 'Chosen plain text', html: '<p>Other HTML</p>' }, 'en', async ({ calls, run }) => {
    await run(custom); assert.equal(calls[0].messages[0].content, `${custom.prompt}\n\nChosen plain text`);
  });
});
for (const lang of locales) test(`oversize error is translated and interpolated in ${lang}`, async () => {
  await fixture({ text: 'x'.repeat(32001) }, lang, async ({ calls, run, results }) => {
    await run(custom); assert.equal(calls.length, 0);
    const text = results()[custom.id].text;
    assert.equal(text, globalThis.aiTestI18n.t('message.aiInputTooLong', { count: 32001 + custom.prompt.length + 2, max: 32000 }));
    assert.doesNotMatch(text, /{{|message\.aiInputTooLong/);
    if (lang !== 'en') assert.notEqual(text, globalThis.aiTestI18n.t('message.aiInputTooLong', { lng: 'en', count: 32001 + custom.prompt.length + 2, max: 32000 }));
  });
});
test('cached actions still avoid a repeat call, while Regenerate sends the full body again', async () => {
  await fixture({ text: 'x'.repeat(7000) + 'REGENERATED_TAIL' }, 'en', async ({ calls, run }) => {
    await run(BUILTIN_SUMMARIZE); await run(BUILTIN_SUMMARIZE);
    assert.equal(calls.length, 1);
    await run(BUILTIN_SUMMARIZE, { force: true });
    assert.equal(calls.length, 2);
    assert.ok(calls[1].messages[0].content.endsWith('REGENERATED_TAIL'));
  });
});
after(() => { dom.window.close(); delete globalThis.aiTestChat; delete globalThis.aiTestI18n; });
