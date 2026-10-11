import { useEffect } from 'react';
import { useStore } from '../store/index.js';
import { createInboxNavigation } from '../utils/inboxNavigation.js';

export function useInboxNavigation(active) {
  useEffect(() => {
    if (!active) return;
    let restoreFrame;
    const capture = () => {
      const state = useStore.getState();
      const view = { selectedAccountId: state.selectedAccountId, selectedFolder: state.selectedFolder, searchQuery: state.searchQuery, unreadOnly: state.unreadOnly, searchAllFolders: state.searchAllFolders, threadedView: state.threadedView, scrollMode: state.scrollMode, pageSize: state.pageSize };
      const local = {};
      window.dispatchEvent(new window.CustomEvent('mailflow:inbox-capture', { detail: local }));
      return { view, local, contextKey: JSON.stringify({ view, local }), scrollTop: document.querySelector('[data-mailflow-list-scroll]')?.scrollTop || 0 };
    };
    const navigation = createInboxNavigation({
      history: window.history,
      capture,
      select: id => useStore.getState().setSelectedMessage(id),
      restore: (snapshot, isList) => {
        const changed = capture().contextKey !== snapshot.contextKey;
        if (changed) {
          useStore.setState(snapshot.view);
          window.dispatchEvent(new window.CustomEvent('mailflow:inbox-restore', { detail: snapshot.local || {} }));
        }
        if (isList) {
          let frames = 0;
          const restoreScroll = () => {
            const list = document.querySelector('[data-mailflow-list-scroll]');
            frames++;
            if (frames < 240 && ((changed && frames < 3) || list?.dataset.mailflowListLoading === 'true')) {
              restoreFrame = window.requestAnimationFrame(restoreScroll);
              return;
            }
            if (list) { list.scrollTop = snapshot.scrollTop; list.focus({ preventScroll: true }); }
          };
          restoreFrame = window.requestAnimationFrame(restoreScroll);
        }
      },
    });
    navigation.initialize(useStore.getState().selectedMessageId);
    const unsubscribe = useStore.subscribe((next, previous) => {
      if (next.selectedMessageId !== previous.selectedMessageId) navigation.observe(next.selectedMessageId);
    });
    const onPop = event => navigation.pop(event.state);
    window.addEventListener('popstate', onPop);
    return () => { unsubscribe(); window.removeEventListener('popstate', onPop); if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame); };
  }, [active]);
}
