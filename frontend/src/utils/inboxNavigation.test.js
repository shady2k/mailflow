import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInboxNavigation } from './inboxNavigation.js';
import { isSinglePaneLayout } from '../layouts.js';

function harness() {
  const entries = [{}]; let cursor = 0;
  let selected = null;
  let snapshot = { contextKey: 'body-search', scrollTop: 300, view: { searchQuery: 'BodyToken' } };
  const restored = [];
  const history = {
    get state() { return entries[cursor]; },
    replaceState(state) { entries[cursor] = state; },
    pushState(state) { entries.splice(++cursor); entries.push(state); },
    back() { if (cursor) { cursor--; navigation.pop(this.state); } },
    forward() { if (cursor < entries.length - 1) { cursor++; navigation.pop(this.state); } },
  };
  const navigation = createInboxNavigation({ history, capture: () => snapshot,
    select: id => { selected = id; navigation.observe(id); }, restore: (value, list) => restored.push({ value, list }),
  });
  navigation.initialize(null);
  return { navigation, history, entries, restored, get selected() { return selected; }, setSnapshot: value => { snapshot = value; } };
}

describe('Inbox desktop navigation', () => {
  it('opens a history entry and returns to the same search and scroll position', () => {
    const h = harness();
    h.setSnapshot({ contextKey: 'body-search', scrollTop: 780, view: { searchQuery: 'BodyToken' } });
    h.navigation.observe('message-a');
    assert.equal(h.entries.length, 2);
    h.navigation.observe(null);
    assert.equal(h.selected, null);
    assert.equal(h.restored[0].value.scrollTop, 780);
    assert.equal(h.restored[0].value.view.searchQuery, 'BodyToken');
    h.history.forward();
    assert.equal(h.selected, 'message-a');
    assert.equal(h.entries.length, 2);
    h.history.back();
    assert.equal(h.selected, null);
  });
  it('next/previous keyboard selection replaces the message entry instead of adding entries', () => {
    const h = harness();
    h.navigation.observe('message-a'); h.navigation.observe('message-b');
    assert.equal(h.entries.length, 2);
    assert.equal(h.history.state.mailflowInbox.messageId, 'message-b');
    h.navigation.observe(null);
    assert.equal(h.selected, null);
  });
  it('changing mailbox while reading keeps the new mailbox instead of restoring the old search', () => {
    const h = harness(); h.navigation.observe('message-a');
    h.setSnapshot({ contextKey: 'archive', scrollTop: 0, view: { selectedFolder: 'Archive', searchQuery: '' } });
    h.navigation.observe(null);
    assert.equal(h.history.state.mailflowInbox.list.contextKey, 'archive');
    assert.equal(h.restored.length, 0);
  });
  it('activates only on desktop in the new preset; old layouts and mobile are unchanged', () => {
    assert.equal(isSinglePaneLayout('inbox', false), true);
    assert.equal(isSinglePaneLayout('inbox', true), false);
    for (const preset of ['compact', 'focused', 'wide', 'comfortable', 'vertical', 'invalid']) assert.equal(isSinglePaneLayout(preset, false), false);
  });
});
