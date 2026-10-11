export function createInboxNavigation({ history, capture, select, restore }) {
  const write = (method, view) => history[method]({ ...history.state, mailflowInbox: view }, '');
  return {
    initialize(messageId) {
      write('replaceState', { messageId: null, list: capture() });
      if (messageId) this.observe(messageId);
    },
    observe(messageId) {
      const previous = history.state?.mailflowInbox;
      if (previous?.messageId === messageId) return;
      if (messageId) {
        const view = { messageId, list: previous?.messageId ? previous.list : capture() };
        if (!previous?.messageId) write('replaceState', { messageId: null, list: view.list });
        write(previous?.messageId ? 'replaceState' : 'pushState', view);
      } else if (previous?.messageId) {
        const current = capture();
        if (current.contextKey === previous.list.contextKey) history.back();
        else write('replaceState', { messageId: null, list: current });
      }
    },
    pop(state) {
      const view = state?.mailflowInbox;
      if (!view) { select(null); return; }
      restore(view.list, !view.messageId);
      select(view.messageId);
    },
  };
}
