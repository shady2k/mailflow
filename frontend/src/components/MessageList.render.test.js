// Render test for MessageList's drag source (#130).
//
// Drag-to-folder was reported broken in Edge, with message rows selecting text instead of
// dragging. Selecting text is what a browser does when an element is NOT draggable, so the
// first question is whether we render the attribute at all. Every other test of this feature
// is a util test and none of them mount a row, so none could answer that.
//
// The harness mirrors MessagePane.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed because the component only
// needs t() to return something.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => k === "messageList.categoryCountsLabel" ? `Total ${d.total}, unread ${d.unread}` : (typeof d === "string" ? d : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
// MessageList loads its own messages on mount and overwrites anything seeded in the store,
// so the fetch stub has to serve the row rather than the store. Only the messages endpoint
// needs a real shape; everything else can be an empty object, unless a test serves a path
// through ROUTES as [status, body].
let SERVED = [];
let ROUTES = {};
globalThis.fetch = async (url) => {
  const path = String(url);
  const [status, body] = Object.entries(ROUTES).find(([p]) => path.endsWith(p))?.[1]
    ?? [200, path.includes('/mail/messages?') ? { messages: SERVED, total: SERVED.length } : {}];
  return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { shortcutBus } = await import('../utils/shortcutBus.js');
const MessageList = (await import('./MessageList.jsx')).default;

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', color: '#6366f1', include_in_unified_inbox: true };
const MESSAGE = {
  id: 'msg-1', account_id: 'acct-1', folder: 'INBOX', uid: 1,
  subject: 'Draggable subject', snippet: 'preview text', message_id: '<m1@example.com>',
  from_name: 'Sender', from_address: 's@example.com', date: new Date().toISOString(),
  is_read: false, is_starred: false, is_deleted: false, has_attachments: false,
};

// A conversation row: threading renders these through ThreadRow instead of MessageRow.
const THREAD = { ...MESSAGE, id: 'msg-2', thread_id: 'thr-1', message_count: 3, unread_count: 2 };

let container, root;

// Mount fresh for each scenario. MessageList refetches on mount and overwrites anything seeded
// in the store, so the fixture is served through fetch rather than set as state.
async function mount({ rows, threadedView, folder = 'INBOX' }) {
  SERVED = rows;
  if (root) await React.act(async () => root.unmount());
  container = dom.window.document.getElementById('root');
  useStore.setState({
    accounts: [ACCOUNT], accountsReady: true,
    selectedAccountId: 'acct-1', selectedFolder: folder,
    messages: rows, messagesTotal: rows.length, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', threadedView,
    folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }, { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' }] },
  });
  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(MessageList));
  });
}

const draggableIn = (msgid) => {
  const row = container.querySelector(`[data-msgid="${msgid}"]`);
  assert.ok(row, `expected a row for ${msgid}`);
  return row.querySelector('[draggable]');
};

describe('MessageList — drag source (#130)', () => {
  test('an ordinary message row is draggable', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const el = draggableIn('msg-1');
    assert.ok(el, 'expected a draggable element inside the message row');
    assert.equal(el.getAttribute('draggable'), 'true');
  });

  test('a conversation row is draggable too', async () => {
    // The actual #130 bug. Threading renders rows through ThreadRow, which had no draggable
    // attribute and no onDragStart, so with conversations on nothing could be dragged and the
    // browser fell back to selecting the row's text. Asserting only on the non-threaded row
    // is what let this pass while the feature was broken for anyone using threading.
    await mount({ rows: [THREAD], threadedView: true });
    const el = draggableIn('msg-2');
    assert.ok(el, 'expected a conversation row to be draggable');
    assert.equal(el.getAttribute('draggable'), 'true');
  });
});

describe('MessageList — selected-row shortcuts', () => {
  test('mark unread updates a selected GTD rail copy and its section row', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const rail = { ...MESSAGE, id: 'rail-copy', message_id: '<rail@example.com>', is_read: true };
    await React.act(async () => {
      useStore.setState({ gtdSections: { reference: { threads: [rail] } } });
      useStore.getState().setSelectedMessage(rail.id);
    });
    await React.act(async () => { shortcutBus.emit('markUnread'); });
    assert.equal(useStore.getState().gtdSections.reference.threads[0].is_read, false);
    await React.act(async () => { useStore.setState({ gtdSections: null, selectedMessageId: null }); });
  });

  test('forward and Reply All act on the selected row; no selection does nothing', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const drafts = [];
    useStore.setState({ openCompose: draft => drafts.push(draft) });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });
    await React.act(async () => { shortcutBus.emit('forward'); await new Promise(r => setTimeout(r, 10)); });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].isForward, true);
    assert.equal(useStore.getState().selectedMessageId, 'msg-1');
    await React.act(async () => { shortcutBus.emit('replyAllFromSelection'); await new Promise(r => setTimeout(r, 10)); });
    assert.equal(drafts.length, 2);
    assert.equal(drafts[1].isReplyAll, true);
    useStore.getState().setSelectedMessage(null);
    await React.act(async () => { shortcutBus.emit('forward'); shortcutBus.emit('replyAllFromSelection'); await new Promise(r => setTimeout(r, 10)); });
    assert.equal(drafts.length, 2);
  });
});

describe('MessageList — modifier-click enters multi-select (#220)', () => {
  // Before this, modifiers only worked once ALREADY in selection mode; entering it took the
  // avatar or the toolbar button. A Ctrl/Cmd- or Shift-click on a row must now enter it in
  // one action, seeded with the open message as anchor, instead of opening the clicked mail.
  const M2 = { ...MESSAGE, id: 'msg-b', uid: 2, message_id: '<m2@example.com>', subject: 'Second' };
  const M3 = { ...MESSAGE, id: 'msg-c', uid: 3, message_id: '<m3@example.com>', subject: 'Third' };
  // Checked and unchecked checkboxes draw the same polyline; stroke-width 3 vs 2.5 is what
  // distinguishes a CHECKED row's checkmark.
  const CHECK = 'svg[stroke-width="3"] polyline[points="20 6 9 17 4 12"]';

  const clickRow = async (msgid, init = {}) => {
    // The click handler sits on the inner draggable element, and DOM events bubble upward,
    // so the dispatch has to start there, not on the [data-msgid] wrapper.
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    const target = row.querySelector('[draggable]') || row;
    await React.act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  };
  const checkedRows = () => [...container.querySelectorAll('[data-msgid]')]
    .filter(r => r.querySelector(CHECK)).map(r => r.getAttribute('data-msgid'));

  test('ctrl-click seeds {open message, clicked row} and does not open the clicked mail', async () => {
    await mount({ rows: [MESSAGE, M2, M3], threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });

    await clickRow('msg-c', { ctrlKey: true });

    assert.equal(useStore.getState().selectedMessageId, 'msg-1'); // clicked mail did NOT open
    assert.deepEqual(checkedRows().sort(), ['msg-1', 'msg-c']);   // anchor + clicked selected
  });

  test('shift-click seeds the whole range from the open message', async () => {
    await mount({ rows: [MESSAGE, M2, M3], threadedView: false });
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });

    await clickRow('msg-c', { shiftKey: true });

    assert.deepEqual(checkedRows().sort(), ['msg-1', 'msg-b', 'msg-c']);
  });

  test('threaded view: ctrl-click on a ThreadRow enters selection too', async () => {
    // The browser smoke caught ThreadRow missing the modifier branch — dev defaults to
    // conversations on, so every earlier assertion here (threadedView: false) passed while
    // the shipped default was broken. Conversations render through ThreadRow, not MessageRow.
    const T1 = { ...MESSAGE, id: 'thr-a', thread_id: 't-a', message_count: 2, unread_count: 1 };
    const T2 = { ...MESSAGE, id: 'thr-b', uid: 9, message_id: '<t2@example.com>', thread_id: 't-b', message_count: 3, unread_count: 0 };
    await mount({ rows: [T1, T2], threadedView: true });
    await React.act(async () => { useStore.getState().setSelectedMessage('thr-a'); });

    await clickRow('thr-b', { ctrlKey: true });

    assert.deepEqual(checkedRows().sort(), ['thr-a', 'thr-b']);
  });

  test('a plain click still just opens the message', async () => {
    await mount({ rows: [MESSAGE, M2], threadedView: false });
    await clickRow('msg-b');
    assert.equal(useStore.getState().selectedMessageId, 'msg-b');
    assert.deepEqual(checkedRows(), []); // no selection mode entered
  });
});

describe('MessageList — Ctrl+Z undo shortcut (#449)', () => {
  // The shortcut runs the same onUndo the visible toast button runs, newest first, and is
  // a no-op once nothing is pending — the keyboard can never undo more than the toasts offer.
  test('undoAction fires the newest pending undo, then the next, then nothing', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    const undone = [];
    await React.act(async () => {
      useStore.getState().addNotification({ title: 'older', onUndo: () => undone.push('older') });
      useStore.getState().addNotification({ title: 'newer', onUndo: () => undone.push('newer') });
    });

    await React.act(async () => { shortcutBus.emit('undoAction'); });
    assert.deepEqual(undone, ['newer']);
    assert.deepEqual(useStore.getState().notifications.filter(n => n.onUndo).map(n => n.title), ['older']);

    await React.act(async () => { shortcutBus.emit('undoAction'); });
    await React.act(async () => { shortcutBus.emit('undoAction'); }); // nothing left — no throw, no change
    assert.deepEqual(undone, ['newer', 'older']);
  });
});

describe('MessageList — undo bar length', () => {
  // Undo send holds a message for 10 s, longer than the standard window, and its bar must stay
  // up (and its progress run) for exactly that long, or Undo vanishes while it would still work.
  test('a bar lasts as long as its notification asks, the rest the standard window', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    await React.act(async () => {
      useStore.setState({ notifications: [] });
      useStore.getState().addNotification({ title: 'standard', onUndo: () => {} });
      useStore.getState().addNotification({ title: 'held send', onUndo: () => {}, undoMs: 9876 });
    });
    const progress = [...container.querySelectorAll('div')]
      .map(el => el.style.animation)
      .filter(a => a.startsWith('action-bar-progress'));
    assert.deepEqual(progress.sort(), ['action-bar-progress 4500ms linear forwards', 'action-bar-progress 9876ms linear forwards']);
    await React.act(async () => { useStore.setState({ notifications: [] }); });
  });
});

describe('MessageList — configurable hover quick actions (#440)', () => {
  // The stubbed t() returns key paths, so button titles ARE their i18n keys here.
  const TITLES = {
    markRead: 'contextMenu.markRead', star: 'contextMenu.star',
    archive: 'shortcuts.actions.archive.label', snooze: 'contextMenu.snooze.label',
    delete: 'common.delete', move: 'contextMenu.moveToFolder',
  };
  const hoverTitles = async (msgid) => {
    const row = container.querySelector(`[data-msgid="${msgid}"]`);
    assert.ok(row, `expected a row for ${msgid}`);
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    });
    return [...row.querySelectorAll('button[title]')].map(b => b.getAttribute('title'));
  };

  test('the configured set picks which buttons render, in canonical order', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    await React.act(async () => { useStore.setState({ hoverActionSet: ['archive', 'snooze', 'delete'] }); });
    const titles = await hoverTitles('msg-1');
    assert.deepEqual(titles, [TITLES.archive, TITLES.snooze, TITLES.delete]);
  });

  test('the default set is the pre-#440 cluster exactly', async () => {
    await mount({ rows: [MESSAGE], threadedView: false });
    await React.act(async () => { useStore.setState({ hoverActionSet: ['markRead', 'star', 'delete', 'move'] }); });
    const titles = await hoverTitles('msg-1');
    assert.deepEqual(titles, [TITLES.markRead, TITLES.star, TITLES.delete, TITLES.move]);
  });
});

describe('MessageList — reopening a saved draft keeps its Bcc', () => {
  // The Bcc lives only in the draft on the server, and saving a reopened draft replaces that copy.
  // Compose used to open with an empty Bcc, so the next save erased the recipients for good.
  const DRAFT = { ...MESSAGE, id: 'draft-1', folder: 'Drafts', uid: 7, is_read: true, subject: 'Draft subject',
    to_addresses: [{ name: '', email: 'alice@example.com' }], cc_addresses: [],
    in_reply_to: '<parent@example.com>', thread_references: '<root@example.com> <parent@example.com>' };

  const openDraft = async ({ bcc }) => {
    ROUTES = { '/mail/messages/draft-1/body': [200, { html: '<p>hello</p>', text: 'hello' }], '/mail/messages/draft-1/bcc': bcc };
    const opened = [];
    await React.act(async () => { useStore.setState({ openCompose: d => opened.push(d), notifications: [], selectedMessageId: null }); });
    await mount({ rows: [DRAFT], threadedView: false, folder: 'Drafts' });
    const row = container.querySelector('[data-msgid="draft-1"]');
    assert.ok(row, 'expected a row for the draft');
    await React.act(async () => {
      (row.querySelector('[draggable]') || row).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 10));
    });
    ROUTES = {};
    return opened;
  };

  test('compose opens with the Bcc, as recipients rather than text to re-split', async () => {
    const bcc = [{ name: 'Doe, Jane', email: 'jane@example.com' }];
    const opened = await openDraft({ bcc: [200, { bcc }] });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].draftUid, 7);
    assert.deepEqual(opened[0].bcc, bcc);
    assert.equal(opened[0].inReplyTo, DRAFT.in_reply_to);
    assert.equal(opened[0].references, DRAFT.thread_references);
  });

  test('a draft whose Bcc cannot be read opens read-only, with an error, never in compose', async () => {
    const opened = await openDraft({ bcc: [502, { error: "Could not read this draft's Bcc recipients from the mail server." }] });
    assert.equal(opened.length, 0);
    assert.equal(useStore.getState().selectedMessageId, 'draft-1');
    assert.ok(useStore.getState().notifications.some(n => n.type === 'error' && n.title === 'messageList.draftBcc.failTitle'));
    await React.act(async () => { useStore.setState({ selectedMessageId: null, notifications: [] }); });
  });
});

describe('MessageList — bulk move picker offers Recent and Favorites (#551)', () => {
  // The single-message pickers list recent and favorite folders above the full list; the bulk
  // picker listed only the full list. Both now read the same helpers.
  const M2 = { ...MESSAGE, id: 'msg-b', uid: 2, message_id: '<m2@example.com>', subject: 'Second' };
  const FOLDERS = [
    { path: 'INBOX', name: 'INBOX' },
    { path: 'Archive', name: 'Archive' },
    { path: 'Work/Receipts', name: 'Receipts' },
    { path: 'Clients', name: 'Clients' },
  ];

  // Selection by modifier-click is desktop-only, so a phone test selects first and then
  // narrows the window through the matchMedia listener useMobile subscribes to.
  const openBulkPicker = async ({ phone = false } = {}) => {
    const listeners = new Set();
    const desktopMatchMedia = dom.window.matchMedia;
    dom.window.matchMedia = () => ({ matches: false, addEventListener: (_, h) => listeners.add(h), removeEventListener: (_, h) => listeners.delete(h), addListener() {}, removeListener() {} });
    try {
      await mount({ rows: [MESSAGE, M2], threadedView: false });
    } finally {
      dom.window.matchMedia = desktopMatchMedia;
    }
    useStore.setState({
      recentFolders: [{ accountId: 'acct-1', path: 'Archive' }, { accountId: 'other', path: 'Clients' }],
      favoriteFolders: [{ accountId: 'acct-1', path: 'Work/Receipts', label: 'Tax 2026' }, { accountId: 'acct-1', path: 'Archive' }],
    });
    ROUTES = { '/accounts/acct-1/folders': [200, FOLDERS] };
    await React.act(async () => { useStore.getState().setSelectedMessage('msg-1'); });
    const row = container.querySelector('[data-msgid="msg-b"]');
    await React.act(async () => {
      (row.querySelector('[draggable]') || row).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    if (phone) await React.act(async () => { for (const h of listeners) h({ matches: true }); });
    const moveBtn = container.querySelector('[title="messageList.moveToFolder"]');
    assert.ok(moveBtn, 'expected the bulk Move button');
    await React.act(async () => { moveBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  // The picker's rows in order: section headings as "# key", folders by their label text.
  const pickerLines = () => {
    const input = [...container.ownerDocument.querySelectorAll('input')].find(i => i.placeholder === 'contextMenu.folders.search');
    assert.ok(input, 'expected the picker search box');
    const list = input.parentElement.nextElementSibling;
    return [...list.children].map(el => el.tagName === 'BUTTON' ? el.textContent.trim()
      : el.textContent.trim() ? `# ${el.textContent.trim()}` : '---');
  };

  test('lists Recent, then Favorites without repeats, then every folder but the current one', async () => {
    await openBulkPicker();
    assert.deepEqual(pickerLines(), [
      '# contextMenu.folders.recent', 'Archive', '---',
      '# contextMenu.folders.favorites', 'Tax 2026', '---',
      '# messageList.moveToFolder', 'Archive', 'Work / Receipts', 'Clients',
    ]);
  });

  test('the phone bottom sheet lists the same sections, then the full list under Folders', async () => {
    await openBulkPicker({ phone: true });
    assert.deepEqual(pickerLines(), [
      '# contextMenu.folders.recent', 'Archive',
      '# contextMenu.folders.favorites', 'Tax 2026',
      '# messageList.foldersHeading', 'Archive', 'Work / Receipts', 'Clients',
    ]);
  });

  test('a search shows only the matching folders, without the sections', async () => {
    await openBulkPicker();
    const input = [...container.ownerDocument.querySelectorAll('input')].find(i => i.placeholder === 'contextMenu.folders.search');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'arch');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(pickerLines(), ['Archive']);
  });
});

describe('MessageList reply draft indicators', () => {
  test('renders the action in both message and collapsed conversation rows', async () => {
    for (const [row, threadedView] of [[MESSAGE, false], [THREAD, true]]) {
      useStore.setState({ replyDrafts: { [row.id]: { exists: true } } });
      await mount({ rows: [row], threadedView });
      assert.ok(container.querySelector(`[data-msgid="${row.id}"] [aria-label="Open reply draft"]`));
    }
  });
  test('hides indicators outside the inbox', async () => {
    useStore.setState({ replyDrafts: { [MESSAGE.id]: { exists: true } } });
    await mount({ rows: [{ ...MESSAGE, folder: 'Archive' }], threadedView: false, folder: 'Archive' });
    assert.equal(container.querySelector('[aria-label="Open reply draft"]'), null);
  });
});

const { api } = await import('../utils/api.js');
const pauseSearch = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 330)); });
async function querySearch(query) { await React.act(async () => useStore.getState().setSearchQuery(query)); }
function deferredSearch() {
  const calls = [];
  api.search = (query, account, options) => new Promise((resolve, reject) => calls.push({ query, account, options, resolve, reject }));
  return calls;
}
test('search announces debounce, suppresses empty, rejects stale responses and clear', async () => {
  await mount({rows: [], threadedView: false});
  const calls = deferredSearch();
  await querySearch('first');
  assert.match(container.textContent, /messageList.searching/);
  assert.doesNotMatch(container.textContent, /messageList.noSearchResults/);
  assert.equal(calls.length, 0);
  await pauseSearch();
  await querySearch('second'); await pauseSearch();
  await React.act(async () => calls[0].resolve({messages: [MESSAGE]}));
  assert.deepEqual(useStore.getState().searchResults, []);
  assert.equal(useStore.getState().isSearching, true);
  await React.act(async () => calls[1].resolve({messages: []}));
  assert.match(container.textContent, /messageList.noSearchResults/);
  await querySearch('third'); await pauseSearch();
  await querySearch('');
  await React.act(async () => calls[2].resolve({messages: [MESSAGE]}));
  assert.deepEqual(useStore.getState().searchResults, []);
  assert.equal(useStore.getState().isSearching, false);
  await querySearch('   ');
  assert.doesNotMatch(container.textContent, /messageList.noSearchResults/);
  assert.equal(useStore.getState().isSearching, false);
  await React.act(async () => root.unmount()); root = null;
});
test('search errors are distinct and query/history edits restart feedback', async () => {
  await mount({rows: [], threadedView: false});
  const calls = deferredSearch();
  await querySearch('history'); await pauseSearch();
  await React.act(async () => calls[0].reject(new Error('Synthetic failure')));
  assert.match(container.textContent, /Synthetic failure/);
  assert.doesNotMatch(container.textContent, /messageList.noSearchResultsDesc/);
  await querySearch('new');
  assert.doesNotMatch(container.textContent, /Synthetic failure/);
  assert.match(container.textContent, /messageList.searching/);
  await querySearch('');
  await React.act(async () => root.unmount()); root = null;
});
test('same-query account and folder navigation reject prior requests and pages', async () => {
  await mount({rows: [], threadedView: false});
  await React.act(async () => useStore.setState({searchAllFolders: false, scrollMode: 'infinite', pageSize: 25}));
  const calls = deferredSearch();
  await querySearch('same'); await pauseSearch();
  await React.act(async () => useStore.setState({selectedAccountId: 'acct-2'}));
  await pauseSearch();
  await React.act(async () => calls[0].resolve({messages: [MESSAGE]}));
  assert.deepEqual(useStore.getState().searchResults, []);
  const page = Array.from({length: 25}, (_, i) => ({...MESSAGE, id: `synthetic-${i}`}));
  await React.act(async () => calls[1].resolve({messages: page}));
  const loadMore = [...container.querySelectorAll('button')].find(b => b.textContent === 'messageList.loadMore');
  assert.ok(loadMore);
  await React.act(async () => loadMore.click());
  await React.act(async () => useStore.setState({selectedFolder: 'Archive'}));
  await pauseSearch();
  await React.act(async () => calls[2].resolve({messages: [MESSAGE]}));
  assert.deepEqual(useStore.getState().searchResults, []);
  assert.equal(useStore.getState().isSearching, true);
  await React.act(async () => calls[3].resolve({messages: []}));
  assert.equal(useStore.getState().isSearching, false);
  await React.act(async () => root.unmount()); root = null;
});

test('fast typing coalesces requests and stale errors cannot replace latest results', async () => {
  await mount({rows: [], threadedView: false});
  const calls = deferredSearch();
  await querySearch('a'); await querySearch('ab'); await querySearch('abc');
  await pauseSearch(); assert.equal(calls.length, 1); assert.equal(calls[0].query, 'abc');
  await querySearch('latest'); await pauseSearch();
  await React.act(async () => calls[1].resolve({messages: [MESSAGE]}));
  await React.act(async () => calls[0].reject(new Error('Stale failure')));
  assert.equal(useStore.getState().searchResults.length, 1);
  assert.doesNotMatch(container.textContent, /Stale failure/);
  await React.act(async () => root.unmount()); root = null;
});
test('pagination errors preserve results and offer a localized retry', async () => {
  await mount({rows: [], threadedView: false});
  await React.act(async () => useStore.setState({scrollMode: 'infinite', pageSize: 1}));
  const calls = deferredSearch();
  await querySearch('page'); await pauseSearch();
  await React.act(async () => calls[0].resolve({messages: [MESSAGE]}));
  const more = [...container.querySelectorAll('button')].find(b => b.textContent === 'messageList.loadMore');
  await React.act(async () => more.click());
  await React.act(async () => calls[1].reject(new Error('Page failure')));
  assert.equal(useStore.getState().searchResults.length, 1);
  const retry = [...container.querySelectorAll('button')].find(b => b.textContent === 'common.retry');
  assert.ok(retry); assert.match(container.querySelector('[role="status"]').textContent, /messageList.searchFailed/);
  await React.act(async () => retry.click());
  assert.equal(calls[2].options.offset, 1);
  await React.act(async () => calls[2].resolve({messages: []}));
  assert.doesNotMatch(container.querySelector('[role="status"]').textContent, /messageList.searchFailed/);
  await React.act(async () => root.unmount()); root = null;
});

test('history restore starts a new search generation and ignores the interrupted response', async () => {
  await mount({rows: [], threadedView: false});
  const calls = deferredSearch();
  await querySearch('interrupted'); await pauseSearch();
  const { createInboxNavigation } = await import('../utils/inboxNavigation.js');
  const navigation = createInboxNavigation({ history: window.history, capture: () => ({}), select: () => {},
    restore: snapshot => useStore.setState(snapshot.view) });
  await React.act(async () => navigation.pop({mailflowInbox:{messageId:null,list:{view:{searchQuery:'restored',selectedFolder:'Archive'}}}}));
  assert.match(container.querySelector('[role="status"]').textContent, /messageList.searching/);
  await pauseSearch();
  await React.act(async () => calls[0].resolve({messages:[MESSAGE]}));
  assert.deepEqual(useStore.getState().searchResults, []);
  await React.act(async () => calls[1].resolve({messages:[]}));
  assert.equal(useStore.getState().isSearching, false);
  await React.act(async () => root.unmount()); root = null;
});

function categoryButton(category) { return [...container.querySelectorAll('button')].find(button => button.textContent.startsWith(`messageList.categories.${category}`)); }
async function mountCategories({rows = [], counts = {}, totals = {}, enabled = true, global = false} = {}) {
  api.getCategoryCounts = async () => ({counts, totals});
  await mount({rows, threadedView: false});
  await React.act(async () => useStore.setState({accounts:[{...ACCOUNT,enabled:true,categorization_enabled:enabled}],categorizationEnabled:global,activeCategory:'primary',activeGtdTab:null,unreadOnly:false,searchQuery:'',categoryTotals:null}));
}
test('category total remains visible when all messages are read and does not depend on loaded page', async () => {
  await mountCategories({rows:[{...MESSAGE,is_read:true}],counts:{primary:0,automated:2},totals:{primary:120,automated:7}});
  assert.equal(categoryButton('primary').querySelector('span').textContent,'120');
  assert.equal(categoryButton('primary').textContent,'messageList.categories.primary120');
  assert.equal(categoryButton('automated').textContent,'messageList.categories.automated7');
  assert.equal(categoryButton('automated').getAttribute('aria-label'),'messageList.categories.automated: Total 7, unread 2');
  const counter=[...container.querySelectorAll('span')].find(span=>span.title==='Cached results matching this filter');
  assert.ok(counter, 'account-specific categorization uses the filtered total even when global categorization is off');
  assert.equal(counter.textContent,'1');
  await React.act(async () => root.unmount());root=null;
});
test('empty category and unread filter do not claim the entire inbox is empty', async () => {
  await mountCategories({totals:{automated:2}});
  assert.match(container.textContent,/messageList.categoryEmpty/);
  assert.doesNotMatch(container.textContent,/Inbox is empty|messageList.folderInboxEmpty/);
  const unreadButton = [...container.querySelectorAll('button')].find(button => button.textContent === 'messageList.unread');
  await React.act(async () => unreadButton.click());
  assert.match(container.textContent,/messageList.categoryEmptyUnread/);
  await querySearch('synthetic');
  assert.match(container.textContent,/messageList.searching/);
  assert.doesNotMatch(container.textContent,/messageList.categoryEmpty/);
  await querySearch('');
  await React.act(async () => root.unmount());root=null;
});
test('category refresh rejects old account and older same-scope responses and handles failure as unknown', async () => {
  await mountCategories();
  const requests=[];
  api.getCategoryCounts=params=>new Promise((resolve,reject)=>requests.push({params,resolve,reject}));
  await React.act(async () => useStore.setState({messagesRefreshToken:useStore.getState().messagesRefreshToken+1}));
  await React.act(async () => useStore.setState({selectedAccountId:'acct-2',accounts:[{...ACCOUNT,enabled:true,categorization_enabled:true},{...ACCOUNT,id:'acct-2',enabled:true,categorization_enabled:true}]}));
  assert.equal(categoryButton('primary').querySelector('span'),null);
  assert.equal(categoryButton('primary').title,'messageList.categoryCountUnknown');
  await React.act(async () => requests[0].resolve({counts:{primary:9},totals:{primary:999}}));
  assert.equal(useStore.getState().categoryTotals,null);
  await React.act(async () => requests[1].resolve({counts:{primary:0},totals:{primary:2}}));
  assert.equal(useStore.getState().categoryTotals.primary,2);
  await React.act(async () => {window.dispatchEvent(new CustomEvent('mailflow:refresh'));await new Promise(r=>setTimeout(r,90));});
  await React.act(async () => {window.dispatchEvent(new CustomEvent('mailflow:category-counts-refresh'));await new Promise(r=>setTimeout(r,90));});
  await React.act(async () => requests[3].resolve({counts:{primary:1},totals:{primary:1}}));
  await React.act(async () => requests[2].resolve({counts:{primary:8},totals:{primary:80}}));
  assert.deepEqual(useStore.getState().categoryTotals,{primary:1});
  await React.act(async () => {window.dispatchEvent(new CustomEvent('mailflow:refresh'));await new Promise(r=>setTimeout(r,90));});
  await React.act(async () => requests[4].reject(new Error('Synthetic count failure')));
  assert.equal(useStore.getState().categoryTotals,null);
  await React.act(async () => root.unmount());root=null;
});
test('optimistic read counts preserve totals and reject other account/folder scopes', async () => {
  await mountCategories({counts:{primary:2},totals:{primary:8}});
  await React.act(async () => useStore.getState().adjustCategoryCount('primary',-1,{...MESSAGE,category:'primary'}));
  assert.equal(useStore.getState().categoryCounts.primary,1);
  assert.equal(useStore.getState().categoryTotals.primary,8);
  await React.act(async () => useStore.getState().adjustCategoryCount('primary',1,{...MESSAGE,folder:'Sent'}));
  await React.act(async () => useStore.getState().adjustCategoryCount('primary',1,{...MESSAGE,account_id:'other'}));
  assert.equal(useStore.getState().categoryCounts.primary,1);
  await React.act(async () => useStore.getState().adjustCategoryCount('primary',1,{...MESSAGE}));
  assert.equal(useStore.getState().categoryCounts.primary,2);
  await React.act(async () => root.unmount());root=null;
});

test('older category snapshots cannot undo optimistic unread changes', async () => {
  await mountCategories({counts:{primary:2},totals:{primary:8}});
  let resolve;
  api.getCategoryCounts=()=>new Promise(r=>{resolve=r;});
  await React.act(async () => {window.dispatchEvent(new CustomEvent('mailflow:refresh'));await new Promise(r=>setTimeout(r,90));});
  await React.act(async () => useStore.getState().adjustCategoryCount('primary',-1,MESSAGE));
  await React.act(async () => resolve({counts:{primary:2},totals:{primary:8}}));
  assert.equal(useStore.getState().categoryCounts.primary,1);
  assert.equal(useStore.getState().categoryTotals.primary,8);
  await React.act(async () => root.unmount());root=null;
});

test('category pills show only total, hide zero, and use unread for emphasis and exact accessible counts', async () => {
  for (const [total,unread] of [[0,0],[2,0],[2,2],[5,2]]) {
    await mountCategories({counts:{primary:unread},totals:{primary:total}});
    const button=categoryButton('primary');
    assert.equal(button.textContent,`messageList.categories.primary${total > 0 ? total : ''}`);
    assert.equal(button.querySelectorAll('span').length,total > 0 ? 1 : 0);
    assert.equal(button.style.fontWeight,unread > 0 ? '600' : '500');
    if (total > 0) {
      assert.equal(button.querySelector('span').style.color,unread > 0 ? 'inherit' : 'var(--text-tertiary)');
      assert.equal(button.querySelector('span').style.fontWeight,'inherit');
    }
    assert.equal(button.title,`Total ${total}, unread ${unread}`);
    assert.equal(button.getAttribute('aria-label'),`messageList.categories.primary: Total ${total}, unread ${unread}`);
    assert.equal(button.getAttribute('aria-pressed'),'true');
    await React.act(async () => categoryButton('automated').click());
    assert.equal(button.getAttribute('aria-pressed'),'false');
    assert.equal(categoryButton('automated').getAttribute('aria-pressed'),'true');
    await React.act(async () => root.unmount());root=null;
  }
});

const deleteGuards = await import('../utils/pendingDeletes.js');
function captureUndoCommits() {
  const original=globalThis.setTimeout;const callbacks=[];
  globalThis.setTimeout=(fn,delay,...args)=>delay===4750?(callbacks.push(fn),{synthetic:true}):original(fn,delay,...args);
  return {callbacks,restore:()=>{globalThis.setTimeout=original;}};
}
test('single archive decrements category immediately during undo delay and undo restores exact total/unread', async () => {
  await mountCategories({rows:[MESSAGE],counts:{primary:1},totals:{primary:1}});
  await React.act(async()=>useStore.getState().setSelectedMessage(MESSAGE.id));
  const clock=captureUndoCommits();let archiveCalls=0;api.bulkArchive=async()=>{archiveCalls++;return {archived:[MESSAGE.id]};};
  try {
    await React.act(async()=>shortcutBus.emit('archive'));
    assert.equal(useStore.getState().messages.length,0);
    assert.equal(useStore.getState().categoryTotals.primary,0);
    assert.equal(useStore.getState().categoryCounts.primary,0);
    assert.equal(archiveCalls,0);
    await React.act(async()=>{window.dispatchEvent(new CustomEvent('mailflow:refresh'));await new Promise(r=>setTimeout(r,90));});
    assert.equal(useStore.getState().categoryTotals.primary,0,'pre-commit server snapshot must not resurrect the count');
    const toast=useStore.getState().notifications.filter(n=>n.onUndo).at(-1);
    await React.act(async()=>toast.onUndo());
    assert.equal(useStore.getState().categoryTotals.primary,1);
    assert.equal(useStore.getState().categoryCounts.primary,1);
    assert.equal(useStore.getState().messages.length,1);
    await React.act(async()=>clock.callbacks[0]());assert.equal(archiveCalls,0);
  } finally {clock.restore();deleteGuards.clearDeleteGuard(MESSAGE.id);await React.act(async()=>root.unmount());root=null;}
});
test('bulk archive reconciles partial failure without double decrement or a stale response overwrite', async () => {
  const second={...MESSAGE,id:'synthetic-second',uid:2,message_id:'<second@example.invalid>',is_read:true};
  await mountCategories({rows:[MESSAGE,second],counts:{primary:1},totals:{primary:2}});
  await React.act(async()=>useStore.getState().setSelectedMessage(MESSAGE.id));
  await React.act(async()=>shortcutBus.emit('selectMessage'));
  const select=container.querySelector('input[data-select-all]');
  assert.ok(select);
  await React.act(async()=>select.click());
  const clock=captureUndoCommits();let resolveArchive;api.bulkArchive=()=>new Promise(resolve=>{resolveArchive=resolve;});
  try {
    const archive=container.querySelector('[title="messageList.archiveSelected"]');assert.ok(archive);
    await React.act(async()=>archive.click());
    assert.equal(useStore.getState().categoryTotals.primary,0);
    assert.equal(useStore.getState().categoryCounts.primary,0);
    let commit;
    await React.act(async()=>{commit=clock.callbacks[0]();await new Promise(r=>setTimeout(r,0));});
    assert.equal(useStore.getState().categoryTotals.primary,0);
    await React.act(async()=>{resolveArchive({archived:[MESSAGE.id],noArchiveFolder:[]});await commit;});
    assert.equal(useStore.getState().categoryTotals.primary,1);
    assert.equal(useStore.getState().categoryCounts.primary,0);
    assert.deepEqual(useStore.getState().messages.map(m=>m.id),[second.id]);
    assert.deepEqual(useStore.getState().categoryPendingRemovals,{});
  } finally {clock.restore();[MESSAGE.id,second.id].forEach(id=>deleteGuards.clearDeleteGuard(id));await React.act(async()=>root.unmount());root=null;}
});
test('pending removals are scoped and an old response cannot reverse an archive or undo', async () => {
  await mountCategories({rows:[MESSAGE],counts:{primary:1},totals:{primary:3}});
  let reply;api.getCategoryCounts=()=>new Promise(resolve=>{reply=resolve;});
  await React.act(async()=>{window.dispatchEvent(new CustomEvent('mailflow:refresh'));await new Promise(r=>setTimeout(r,90));});
  await React.act(async()=>{deleteGuards.setPendingDelete(MESSAGE.id);useStore.getState().removeMessage(MESSAGE.id);});
  assert.equal(useStore.getState().categoryTotals.primary,2);
  await React.act(async()=>reply({counts:{primary:1},totals:{primary:3}}));
  assert.equal(useStore.getState().categoryTotals.primary,2);
  await React.act(async()=>deleteGuards.clearDeleteGuard(MESSAGE.id));
  assert.equal(useStore.getState().categoryTotals.primary,3);
  await React.act(async()=>root.unmount());root=null;
});

const { refreshConnectionData } = await import('../utils/connectionRefresh.js');
test('connection reconciliation rejects late real list/category responses and refreshes current navigation scope', async () => {
  await mountCategories({rows:[MESSAGE],counts:{primary:1},totals:{primary:1}});
  const oldGet=api.getMessages, oldCategory=api.getCategoryCounts;
  let resolveList, resolveCategory, current=true;
  api.getMessages=()=>new Promise(resolve=>{resolveList=resolve;});
  api.getCategoryCounts=()=>new Promise(resolve=>{resolveCategory=resolve;});
  const lateRow={...MESSAGE,id:'late-obsolete',subject:'Obsolete synthetic row'};
  let work;
  await React.act(async()=>{work=refreshConnectionData(()=>current,async()=>true);await Promise.resolve();});
  current=false;
  await React.act(async()=>{
    resolveList({messages:[lateRow],total:91});resolveCategory({counts:{primary:91},totals:{primary:91}});
    assert.equal(await work,false);
  });
  assert.equal(useStore.getState().messages.some(m=>m.id===lateRow.id),false);
  assert.equal(useStore.getState().categoryTotals.primary,1);
  const rows=[];
  api.getMessages=async params=>{rows.push(params);return {messages:[],total:0};};
  api.getCategoryCounts=async()=>({counts:{},totals:{}});
  await React.act(async()=>useStore.setState({selectedFolder:'Archive'}));
  await React.act(async()=>assert.equal(await refreshConnectionData(()=>true,async()=>true),true));
  assert.equal(rows.at(-1).folder,'Archive');
  assert.equal(useStore.getState().messagesTotal,0);
  api.getMessages=oldGet;api.getCategoryCounts=oldCategory;
  await React.act(async()=>root.unmount());root=null;
});
test('connection reconciliation refreshes active search and keeps refresh failures visible', async () => {
  await mountCategories({rows:[MESSAGE]});
  const oldSearch=api.search;
  api.search=async()=>({messages:[]});
  await React.act(async()=>useStore.getState().setSearchQuery('Synthetic missed mail'));
  const newRow={...MESSAGE,id:'recovered-search',subject:'Recovered synthetic search'};
  api.search=async()=>({messages:[newRow]});
  await React.act(async()=>assert.equal(await refreshConnectionData(()=>true,async()=>true),true));
  assert.deepEqual(useStore.getState().searchResults.map(m=>m.id),[newRow.id]);
  api.search=async()=>{throw new Error('Synthetic search failure');};
  await React.act(async()=>assert.rejects(refreshConnectionData(()=>true,async()=>true),/Synthetic search failure/));
  assert.deepEqual(useStore.getState().searchResults.map(m=>m.id),[newRow.id]);
  api.search=oldSearch;await React.act(async()=>root.unmount());root=null;
});
test('pending initial list load cannot replace a completed connection catch-up', async () => {
  const oldGet=api.getMessages;let resolveInitial;
  api.getMessages=()=>new Promise(resolve=>{resolveInitial=resolve;});
  await mount({rows:[MESSAGE],threadedView:false});
  const recovered={...MESSAGE,id:'fresh-recovered',subject:'Fresh synthetic catch-up'};
  api.getMessages=async()=>({messages:[recovered],total:1});
  await React.act(async()=>assert.equal(await refreshConnectionData(()=>true,async()=>true),true));
  await React.act(async()=>resolveInitial({messages:[MESSAGE],total:1}));
  assert.deepEqual(useStore.getState().messages.map(m=>m.id),[recovered.id]);
  api.getMessages=oldGet;await React.act(async()=>root.unmount());root=null;
});
test('connection catch-up during archive undo delay cannot restore removed rows/counts; undo then reconciles', async () => {
  await mountCategories({rows:[MESSAGE],counts:{primary:1},totals:{primary:1}});
  await React.act(async()=>useStore.getState().setSelectedMessage(MESSAGE.id));
  const clock=captureUndoCommits();const oldArchive=api.bulkArchive;
  api.bulkArchive=async()=>({archived:[MESSAGE.id]});
  try {
    await React.act(async()=>shortcutBus.emit('archive'));
    await React.act(async()=>assert.rejects(refreshConnectionData(()=>true,async()=>true),/superseded/));
    assert.equal(useStore.getState().categoryTotals.primary,0);
    assert.equal(useStore.getState().messages.some(m=>m.id===MESSAGE.id),false);
    const toast=useStore.getState().notifications.find(n=>n.onUndo);
    await React.act(async()=>{toast.onUndo();await new Promise(resolve=>setTimeout(resolve,90));});
    await React.act(async()=>assert.equal(await refreshConnectionData(()=>true,async()=>true),true));
    assert.equal(useStore.getState().categoryTotals.primary,1);
    assert.equal(useStore.getState().categoryCounts.primary,1);
    assert.equal(useStore.getState().messages.some(m=>m.id===MESSAGE.id),true);
  } finally {clock.restore();api.bulkArchive=oldArchive;deleteGuards.clearDeleteGuard(MESSAGE.id);await React.act(async()=>root.unmount());root=null;}
});

const selectAllCheckbox = () => container.querySelector('input[data-select-all]');
test('paginated select-all is visible before selection, native mixed when partial, and actions require selected rows', async () => {
  useStore.setState({scrollMode:'paginated'});
  const second={...MESSAGE,id:'select-second',uid:2,message_id:'<select-second@example.invalid>'};
  await mount({rows:[MESSAGE,second],threadedView:false});
  assert.equal(useStore.getState().messages.length,2);
  const input=selectAllCheckbox();assert.ok(input);assert.equal(input.disabled,false);assert.equal(input.checked,false);
  assert.equal(input.getAttribute('aria-label'),'messageList.selectCurrentPage');
  assert.equal(container.querySelector('[title="messageList.archiveSelected"]'),null);
  await React.act(async()=>container.querySelector('[title="messageList.selectMessages"]').click());
  assert.equal(container.querySelector('[title="messageList.archiveSelected"]'),null);
  await React.act(async()=>input.click());assert.equal(input.checked,true);
  assert.ok(container.querySelector('[title="messageList.archiveSelected"]'));
  const rowCheck=container.querySelector('input[type="checkbox"]:not([data-select-all])') || draggableIn('msg-1');
  assert.ok(rowCheck);await React.act(async()=>rowCheck.click());
  assert.equal(input.indeterminate,true);assert.equal(input.getAttribute('aria-checked'),'mixed');
  await React.act(async()=>input.click());assert.equal(input.checked,true);assert.equal(input.indeterminate,false);
  await React.act(async()=>input.click());assert.equal(input.checked,false);
  assert.equal(container.querySelector('[title="messageList.archiveSelected"]'),null);
  await React.act(async()=>root.unmount());root=null;
  await mount({rows:[],threadedView:false});assert.equal(selectAllCheckbox().disabled,true);
  await React.act(async()=>root.unmount());root=null;
});
test('select-all follows loaded search rows and clearing or navigating discards previous selection', async () => {
  const oldSearch=api.search;api.search=async()=>({messages:[{...MESSAGE,id:'search-only'}]});
  await mount({rows:[MESSAGE],threadedView:false});await React.act(async()=>selectAllCheckbox().click());
  await React.act(async()=>{useStore.getState().setSearchQuery('Synthetic');});
  await React.act(async()=>new Promise(resolve=>setTimeout(resolve,320)));
  assert.equal(selectAllCheckbox().checked,false);assert.equal(selectAllCheckbox().disabled,false);
  assert.equal(selectAllCheckbox().getAttribute('aria-label'),'messageList.selectLoadedMessages');
  await React.act(async()=>selectAllCheckbox().click());assert.equal(selectAllCheckbox().checked,true);
  await React.act(async()=>useStore.getState().setSearchQuery(''));assert.equal(selectAllCheckbox().checked,false);
  await React.act(async()=>selectAllCheckbox().click());
  await React.act(async()=>useStore.setState({selectedFolder:'Archive'}));
  assert.equal(selectAllCheckbox().checked,false);assert.equal(container.querySelector('[title="messageList.archiveSelected"]'),null);
  api.search=oldSearch;await React.act(async()=>root.unmount());root=null;
});
test('paginated select-all archives only current loaded page and threaded rows retain existing selection', async () => {
  const originalGet=api.getMessages,originalArchive=api.bulkArchive;
  const first=[MESSAGE,{...MESSAGE,id:'page1-second',message_id:'<page1-second@example.invalid>'}],second=[{...MESSAGE,id:'page2-first',message_id:'<page2-first@example.invalid>'},{...MESSAGE,id:'page2-second',message_id:'<page2-second@example.invalid>'}];
  let resolvePage;
  api.getMessages=params=>params.offset ? new Promise(resolve=>{resolvePage=resolve;}) : Promise.resolve({messages:first,total:200});
  useStore.setState({scrollMode:'paginated',pageSize:2});
  await mount({rows:first,threadedView:false});await React.act(async()=>selectAllCheckbox().click());
  const next=[...container.querySelectorAll('button')].find(button=>button.textContent.includes('messageList.nextPage'));
  assert.ok(next);await React.act(async()=>next.click());
  assert.equal(selectAllCheckbox().disabled,true,'old page rows cannot be selected while next page is pending');
  await React.act(async()=>selectAllCheckbox().click());
  assert.equal(selectAllCheckbox().checked,false);
  await React.act(async()=>resolvePage({messages:second,total:200}));
  assert.equal(selectAllCheckbox().disabled,false);
  assert.equal(selectAllCheckbox().checked,false);assert.equal(container.querySelector('[title="messageList.archiveSelected"]'),null);
  await React.act(async()=>selectAllCheckbox().click());const clock=captureUndoCommits();let archived;
  api.bulkArchive=async ids=>{archived=ids;return {archived:ids};};
  try {
    await React.act(async()=>container.querySelector('[title="messageList.archiveSelected"]').click());
    await React.act(async()=>clock.callbacks[0]());
    assert.deepEqual(archived,second.map(message=>message.id));
    assert.equal(selectAllCheckbox().checked,false);
  } finally {clock.restore();second.forEach(message=>deleteGuards.clearDeleteGuard(message.id));api.getMessages=originalGet;api.bulkArchive=originalArchive;await React.act(async()=>root.unmount());root=null;useStore.setState({scrollMode:'infinite',pageSize:50});}
  useStore.setState({scrollMode:'paginated'});
  await mount({rows:[THREAD],threadedView:true});assert.equal(selectAllCheckbox().checked,false);
  await React.act(async()=>selectAllCheckbox().click());assert.equal(selectAllCheckbox().checked,true);
  await React.act(async()=>root.unmount());root=null;
});

test('infinite select-all includes loaded rows only and newly appended rows remain unselected', async () => {
  useStore.setState({scrollMode:'infinite'});
  const second={...MESSAGE,id:'infinite-second',uid:2,message_id:'<infinite-second@example.invalid>'};
  await mount({rows:[MESSAGE,second],threadedView:false});
  await React.act(async()=>useStore.setState({messagesTotal:200}));
  assert.ok(selectAllCheckbox());assert.equal(selectAllCheckbox().getAttribute('aria-label'),'messageList.selectLoadedMessages');
  await React.act(async()=>selectAllCheckbox().click());assert.equal(selectAllCheckbox().checked,true);
  const third={...MESSAGE,id:'newly-loaded',uid:3,message_id:'<newly-loaded@example.invalid>'};
  await React.act(async()=>useStore.getState().appendMessages([third]));
  assert.equal(selectAllCheckbox().indeterminate,true);
  assert.equal(selectAllCheckbox().getAttribute('aria-label'),'messageList.selectLoadedMessages');
  await React.act(async()=>selectAllCheckbox().click());assert.equal(selectAllCheckbox().checked,true);
  assert.equal(selectAllCheckbox().getAttribute('aria-label'),'messageList.deselectLoadedMessages');
  await React.act(async()=>selectAllCheckbox().click());assert.equal(selectAllCheckbox().checked,false);
  assert.equal(container.querySelector('[title="messageList.archiveSelected"]'),null);
  await React.act(async()=>root.unmount());root=null;
});
