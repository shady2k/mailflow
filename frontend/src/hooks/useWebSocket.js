import { countWriteState } from '../utils/countWrites.js';
import { refreshConnectionData } from '../utils/connectionRefresh.js';
import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { installCapacitorNativeBridge } from '../utils/capacitorNativeBridge.js';
import { playNotificationSound } from '../utils/notificationSounds.js';
import { accountAffectsUnifiedInbox } from '../utils/unifiedInbox.js';
import { dispatchPluginWsMessage, dispatchPluginReconnect } from '../plugins/events.js';
import { recordDiagEvent } from '../utils/diagEvents.js';

function _applyServerCounts(counts) {
  useStore.getState().setUnreadCounts(counts);
}

async function _forwardNativeNewMailNotification(notification) {
  await installCapacitorNativeBridge();
  window.mailflowNative?.notifications?.showNewMail?.({
    title: notification.title,
    body: notification.body,
    count: notification.count,
    accountId: notification.accountId,
    folder: notification.folder,
    messageId: notification.messageId,
    message: notification.message,
  }).catch(() => {});
}

// Auth-related close codes that should not trigger reconnect
const NO_RECONNECT_CODES = new Set([1008, 4001, 4003]);

// Module-level timer for debouncing backfill_progress refreshes
let backfillRefreshTimer = null;
// Debounce the unread-count refetch triggered by cross-device flag updates.
let flagCountRefreshTimer = null;
const BACKOFF_BASE = 1000;
const BACKOFF_MAX = 30000;
// How long a socket must stay open before the backoff starts over. One the server accepts and then
// closes at once (an address other than APP_URL is refused, 1008) otherwise reset it on every open
// and was retried every second or two, each retry refetching the message list.
const STABLE_MS = 10000;

export function useWebSocket() {
  const { t } = useTranslation();
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const mountedRef = useRef(true);
  const authBlocked = useRef(false);
  const needsCatchUp = useRef(false);
  const hiddenSince = useRef(document.visibilityState === 'hidden' ? Date.now() : null);
  const reconnectAttempt = useRef(0);
  const refreshGeneration = useRef(0);
  const refreshTimer = useRef(null);
  const refreshPromise = useRef(null);
  const lastRetry = useRef(0);
  const setStatus = useCallback((phase) => {
    if (mountedRef.current) useStore.getState().setConnectionStatus({ phase });
  }, []);
  const reconcile = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !ws._confirmed || refreshPromise.current) return;
    clearTimeout(refreshTimer.current);
    const generation = ++refreshGeneration.current;
    const current = () => mountedRef.current && refreshGeneration.current === generation && wsRef.current === ws && ws.readyState === WebSocket.OPEN;
    setStatus('refreshing');
    let deadline;
    const work = Promise.race([
      refreshConnectionData(current, async () => {
        const state = useStore.getState();
        const folderAccounts = Object.keys(state.folders).filter(id => state.accounts.some(account => account.id === id));
        const [counts, ...folders] = await Promise.all([
          api.getUnreadCounts({ refresh: Object.keys(state.pendingCounts).length > 0 && countWriteState().pending === 0 }), ...folderAccounts.map(id => api.getFolders(id)),
        ]);
        if (!current() || useStore.getState().user?.id !== state.user?.id) return false;
        useStore.getState().setUnreadCounts(counts);
        folderAccounts.forEach((id, index) => useStore.getState().setFolders(id, folders[index]));
        const writes = countWriteState().pending;
        const projections = Object.keys(useStore.getState().pendingCounts).length;
        const complete = counts.complete !== false && writes === 0 && projections === 0;
        if (!complete) recordDiagEvent({ category: 'ws', type: 'counts_deferred',
          cause: counts.complete === false ? 'stale_snapshot' : writes ? 'pending_write' : 'pending_projection',
          writes, projections,
          acknowledgement: Object.values(useStore.getState().pendingCounts).map(p => ({
            base: p.base, delta: p.delta, sinceRevision: p.sinceRevision,
            ackBarrier: p.ackBarrier, ackWriteVersion: p.ackWriteVersion,
            ageMs: Math.max(0, Date.now() - p.openedAt), stale: !!p.stale,
          })) });
        return complete;
      }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Refresh timeout')), 30000); }),
    ]);
    refreshPromise.current = work;
    work.then(success => {
      if (!current()) return;
      if (success) {
        setStatus('healthy');
        dispatchPluginReconnect();
      } else {
        // A superseded read or pending count barrier is not a failed request.
        // Keep readiness pending and retry; only a rejection/timeout shows an error.
        refreshTimer.current = setTimeout(reconcile, 5000);
      }
    }).catch(() => {
      if (!current()) return;
      setStatus('refreshError');
      ++refreshGeneration.current;
      refreshTimer.current = setTimeout(reconcile, 30000);
    }).finally(() => {
      clearTimeout(deadline);
      if (refreshPromise.current === work) refreshPromise.current = null;
    });
  }, [setStatus]);
  // True once the socket has connected at least once. Distinguishes the initial
  // page-load connect (message list is freshly fetched anyway) from any later
  // reconnect — backoff OR a wake/visibility revive — which must run the catch-up
  // so mail that arrived while the socket was down shows without a manual refresh.
  // reconnectAttempt can't be used for this: revive() resets it to 0 before
  // reconnecting, which made a wake-triggered reconnect look like a first connect.
  const hasConnectedBefore = useRef(false);
  const { addNotification, updateAccount, setFolders, setBackfillProgress } = useStore();

  const connect = useCallback(() => {
    if (!mountedRef.current || authBlocked.current) return;
    if (window.navigator.onLine === false) { setStatus('offline'); return; }
    clearTimeout(reconnectTimer.current);
    clearTimeout(refreshTimer.current);
    ++refreshGeneration.current;
    refreshPromise.current = null;
    if (wsRef.current || hasConnectedBefore.current) setStatus('connecting');
    if (wsRef.current) needsCatchUp.current = true;
    // Clean up any existing socket before opening a new one — prevents duplicate
    // connections if connect() is called while a previous socket is still open.
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      clearTimeout(wsRef.current._statusTimer);
      clearTimeout(wsRef.current._connectTimeout);
      wsRef.current.onclose = null;  // prevent old socket's close from scheduling another reconnect
      clearInterval(wsRef.current._pingInterval);
      clearTimeout(wsRef.current._stableTimer);
      wsRef.current.close();
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws._statusTimer = setTimeout(() => {
      if (wsRef.current === ws && (ws.readyState === WebSocket.CONNECTING || (ws.readyState === WebSocket.OPEN && !ws._confirmed))) setStatus('connecting');
    }, 2000);
    ws._connectTimeout = setTimeout(() => {
      if (wsRef.current === ws && (ws.readyState === WebSocket.CONNECTING || (ws.readyState === WebSocket.OPEN && !ws._confirmed))) connect();
    }, 15000);

    ws.onopen = () => {
      if (wsRef.current !== ws || !mountedRef.current) return;
      ws._stableTimer = setTimeout(() => { reconnectAttempt.current = 0; }, STABLE_MS);
      ws._lastActivity = Date.now();
      // Ping every 30s. If no message (including the server's pong) has arrived in ~2.5 intervals,
      // the socket is half-open — common after sleep/network blips, where onclose never fires and
      // the tab silently stops receiving updates. Replace it without waiting for a close handshake.
      const pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - (ws._lastActivity || 0) > 75000) {
          connect();
          return;
        }
        ws.send(JSON.stringify({ type: 'ping' }));
      }, 30000);
      ws._pingInterval = pingInterval;
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws || !mountedRef.current) return;
      ws._lastActivity = Date.now(); // any inbound frame (incl. pong) proves the socket is alive
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected' && !ws._confirmed) {
          ws._confirmed = true;
          clearTimeout(ws._statusTimer);
          clearTimeout(ws._connectTimeout);
          const wasReconnect = hasConnectedBefore.current || needsCatchUp.current;
          needsCatchUp.current = false;
          hasConnectedBefore.current = true;
          if (wasReconnect) {
            recordDiagEvent({ category: 'ws', type: 'reconnect' });
            reconcile();
          } else setStatus('healthy');
        } else handleMessage(data);
      } catch (err) { console.error('WS message error:', err); }
    };

    ws.onclose = (event) => {
      clearInterval(ws._pingInterval);
      clearTimeout(ws._stableTimer);
      clearTimeout(ws._statusTimer);
      clearTimeout(ws._connectTimeout);
      if (wsRef.current !== ws) return;
      if (NO_RECONNECT_CODES.has(event.code)) authBlocked.current = true;
      ++refreshGeneration.current;
      refreshPromise.current = null;
      clearTimeout(refreshTimer.current);
      if (!mountedRef.current) return;
      setStatus(window.navigator.onLine === false ? 'offline' : 'unavailable');
      if (authBlocked.current) {
        setStatus('blocked');
        api.getUnreadCounts().catch(() => {});
        return;
      }
      const attempt = reconnectAttempt.current;
      const delay = Math.min(BACKOFF_BASE * 2 ** attempt, BACKOFF_MAX);
      const jitter = Math.random() * 0.3 * delay;
      reconnectAttempt.current = attempt + 1;
      reconnectTimer.current = setTimeout(connect, delay + jitter);
    };

    ws.onerror = () => ws.close();
    wsRef.current = ws;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case 'new_messages': {
        // Blip the sync icon — a real change just synced in, so show background activity
        // even though we no longer broadcast sync_complete on every (mostly-idle) tick.
        window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
        const { messages, count, accountId, folder } = data;
        // alertMessages/alertCount are provided by the server when inbox rules ran;
        // they exclude messages silenced by a mark_read rule. Fall back to the full
        // messages/count for servers or code paths that don't send the alert fields.
        const alertMessages = data.alertMessages ?? messages;
        const alertCount = data.alertCount ?? count;
        const isInbox = !folder || folder === 'INBOX';

        // Note: no raw folder name here — a custom folder name would be identifying,
        // and the scrub net only catches emails/IPs/tokens. isInbox is the safe signal.
        recordDiagEvent({ category: 'event', type: 'new_messages', accountId, isInbox, count, alertCount });

        // In-app notifications and sounds are inbox-only — non-inbox folder syncs
        // (Archive, Spam, on-demand syncs) should not trigger alerts for old mail.
        // Also skipped when all messages were silenced by a mark_read rule (alertCount === 0).
        // An alert can come with no new Inbox mail at all: mail a "Notify me" rule filed
        // elsewhere (#588), which is opened in the folder it went to.
        if (isInbox && alertCount > 0 && alertMessages?.length) {
          const latest = alertMessages[0];
          const notification = {
            type: 'new_mail',
            accountId,
            folder: latest.folder || folder || 'INBOX',
            messageId: latest.id,
            message: latest,
            title: latest.fromName || latest.fromEmail || t('notifications.newMessage'),
            body: latest.subject || t('common.noSubject'),
            count: alertCount,
          };

          if (document.visibilityState === 'visible') {
            addNotification(notification);
            const { notificationSound, customSoundDataUrl } = useStore.getState();
            playNotificationSound(notificationSound, customSoundDataUrl);
          }

          _forwardNativeNewMailNotification(notification);
        }

        if (messages && messages.length > 0) {
          // Refresh the message list when the affected folder is visible
          const store = useStore.getState();
          const isRelevant =
            (store.selectedAccountId === null && accountAffectsUnifiedInbox(store.accounts, accountId)) ||
            store.selectedAccountId === accountId;
          const folderVisible = store.selectedFolder === (folder || 'INBOX');

          if (isRelevant && folderVisible) {
            window.dispatchEvent(new CustomEvent('mailflow:refresh'));
          }
        }

        // Fetch the latest independently observed server count.
        if (isInbox) {
          api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        }
        break;
      }

      case 'exists_hint':
        // EXISTS reports membership, not UNSEEN. The status observer supplies badges.
        break;

      case 'folder_counts':
        api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        if (useStore.getState().folders[data.accountId]) {
          api.getFolders(data.accountId)
            .then(f => useStore.getState().setFolders(data.accountId, f)).catch(() => {});
        }
        break;

      case 'account_connected': {
        updateAccount(data.accountId, { sync_error: null });
        break;
      }

      case 'folders_synced': {
        // The folder structure was re-listed (periodic folder sync or a manual
        // "Sync folders now") — refetch so new/renamed folders appear in the sidebar.
        api.getFolders(data.accountId)
          .then(f => useStore.getState().setFolders(data.accountId, f))
          .catch(() => {});
        break;
      }

      case 'account_error': {
        updateAccount(data.accountId, { sync_error: data.error });
        break;
      }

      case 'backfill_all_start': {
        setBackfillProgress(data.accountId, { synced: 0, total: null });
        break;
      }

      case 'backfill_progress': {
        // Update progress state for the settings UI
        setBackfillProgress(data.accountId, { synced: data.synced, total: data.total });
        // Trigger a silent message list refresh so newly synced messages appear
        // Debounce to avoid hammering the API on every batch
        clearTimeout(backfillRefreshTimer);
        backfillRefreshTimer = setTimeout(() => {
          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        }, 2000);
        break;
      }

      case 'backfill_complete': {
        clearTimeout(backfillRefreshTimer);
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        break;
      }

      case 'backfill_all_complete': {
        clearTimeout(backfillRefreshTimer);
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        setBackfillProgress(data.accountId, null);
        break;
      }

      case 'folder_updated': {
        // Emitted by move/archive/delete routes after messages leave one folder and land in
        // another. The event names ONE folder (usually the move destination), but the change
        // matters to whoever is viewing the *source* too — that's the device the message must
        // disappear from. So refresh the current view for any relevant account rather than only
        // when the viewed folder matches the event's folder; otherwise a move on one device
        // isn't reflected on another until a manual reload. Blip the sync icon so the change is
        // visible, refresh counts for sidebar badges, but no sounds/notifications.
        const { accountId: fuAccountId } = data;
        const fuStore = useStore.getState();
        const fuRelevant =
          (fuStore.selectedAccountId === null && accountAffectsUnifiedInbox(fuStore.accounts, fuAccountId)) ||
          fuStore.selectedAccountId === fuAccountId;
        if (fuRelevant) {
          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
          window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
        }
        api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        break;
      }

      case 'sync_complete': {
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
        // Re-fetch unread counts so sidebar badges reflect messages marked read
        // in external clients (the message list refresh alone doesn't update counts).
        api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        // Re-fetch per-folder counts for the affected account so sidebar folder
        // badges stay in sync (unread_count, total_count). Only refresh accounts
        // whose folders are already loaded to avoid unnecessary requests.
        if (data.accountId && useStore.getState().folders[data.accountId]) {
          api.getFolders(data.accountId).then(f => setFolders(data.accountId, f)).catch(() => {});
        }
        break;
      }

      case 'drafts_changed': {
        // A Drafts folder gained or lost a draft: synced from another client (which saves it
        // read, so no new_messages), or saved, discarded or sent from another tab or device.
        // The Inbox re-checks its reply-draft markers; the visible list does not reload.
        useStore.getState().invalidateReplyDrafts();
        break;
      }

      case 'folder_emptied': {
        // Background empty finished (see mail.js /folders/empty). Toast the outcome and refresh
        // the view and counts either way — on failure the messages are still on the server and
        // should reappear.
        addNotification({ title: data.ok ? t('sidebar.emptied') : t('sidebar.emptyFailed') });
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
        api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        if (data.accountId && useStore.getState().folders[data.accountId]) {
          api.getFolders(data.accountId).then(f => setFolders(data.accountId, f)).catch(() => {});
        }
        break;
      }

      case 'rules_run_complete': {
        // Background "Run rules on inbox" finished (see rules.js /run). Toast the outcome,
        // hand the counts to the settings panel if it is open, and refresh views and
        // counts — rules move messages between folders.
        addNotification({
          title: data.ok === false
            ? t('admin.rules.runError')
            : t('admin.rules.runResult', { matched: data.matched, processed: data.processed }),
        });
        window.dispatchEvent(new CustomEvent('mailflow:rules-run-complete', { detail: data }));
        window.dispatchEvent(new Event('mailflow:rules-ran'));
        api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        break;
      }

      case 'snooze_wakeup': {
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        api.getUnreadCounts().then(counts => {
          useStore.getState().setUnreadCounts(counts);
        }).catch(() => {});
        break;
      }

      case 'flags_synced': {
        // Lightweight flag update (read/starred changed on another client).
        // Refresh the message list and unread counts, and blip the sync icon so background
        // sync activity stays visible now that sync_complete no longer fires every tick.
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
        api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        break;
      }

      case 'message_flags': {
        // A read/star flag changed on ANOTHER of this user's devices. Apply it to the matching
        // rows in place — no full folder refetch (that would flicker and refetch-storm while
        // speeding through mail on another device). Sidebar counts follow via a debounced poll.
        const { changes } = data;
        if (Array.isArray(changes) && changes.length) {
          const { updateMessage } = useStore.getState();
          for (const c of changes) {
            if (!c || !c.id) continue;
            const patch = {};
            if (typeof c.is_read === 'boolean') patch.is_read = c.is_read;
            if (typeof c.is_starred === 'boolean') patch.is_starred = c.is_starred;
            if (Object.keys(patch).length) updateMessage(c.id, patch);
          }
          clearTimeout(flagCountRefreshTimer);
          flagCountRefreshTimer = setTimeout(() => {
            api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
          }, 400);
        }
        break;
      }

      default:
        // A message type core doesn't handle — hand it to any activated plugin that registered for
        // it (e.g. GTD's 'gtd_sections_updated'). No-op when nothing is registered.
        dispatchPluginWsMessage(data);
    }
  }, [addNotification, updateAccount, setFolders, setBackfillProgress, t]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    const generation = refreshGeneration;
    return () => {
      mountedRef.current = false;
      ++generation.current;
      refreshPromise.current = null;
      clearTimeout(refreshTimer.current);
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        clearTimeout(wsRef.current._statusTimer);
        clearTimeout(wsRef.current._connectTimeout);
        clearInterval(wsRef.current._pingInterval);
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Revive a dropped socket the moment the user returns to the tab or the network comes back,
  // instead of waiting out the reconnect backoff or a suspended heartbeat.
  useEffect(() => {
    const revive = (event) => {
      if (event?.type === 'online' || event?.persisted) needsCatchUp.current = true;
      if (document.visibilityState !== 'visible') {
        if (hiddenSince.current === null) hiddenSince.current = Date.now();
        return;
      }
      if (hiddenSince.current !== null) {
        if (Date.now() - hiddenSince.current >= 1000) needsCatchUp.current = true;
        hiddenSince.current = null;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING ||
          (ws.readyState === WebSocket.OPEN && (needsCatchUp.current || event?.type === 'online' || event?.persisted ||
            Date.now() - (ws._lastActivity || 0) > 75000))) {
        clearTimeout(reconnectTimer.current);
        reconnectAttempt.current = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', revive);
    window.addEventListener('online', revive);
    window.addEventListener('focus', revive);
    window.addEventListener('pageshow', revive);
    return () => {
      document.removeEventListener('visibilitychange', revive);
      window.removeEventListener('online', revive);
      window.removeEventListener('focus', revive);
      window.removeEventListener('pageshow', revive);
    };
  }, [connect]);

  useEffect(() => {
    const retry = () => {
      if (Date.now() - lastRetry.current < 1000 || authBlocked.current) return;
      lastRetry.current = Date.now();
      if (wsRef.current?.readyState === WebSocket.CONNECTING) return;
      if (wsRef.current?.readyState === WebSocket.OPEN && wsRef.current._confirmed) reconcile();
      else connect();
    };
    const offline = () => {
      needsCatchUp.current = true;
      ++refreshGeneration.current;
      refreshPromise.current = null;
      clearTimeout(refreshTimer.current);
      setStatus('offline');
    };
    const scopeChanged = () => {
      if (useStore.getState().connectionStatus.phase === 'refreshError') reconcile();
    };
    window.addEventListener('mailflow:connection-retry', retry);
    window.addEventListener('mailflow:connection-scope', scopeChanged);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('mailflow:connection-retry', retry);
      window.removeEventListener('mailflow:connection-scope', scopeChanged);
      window.removeEventListener('offline', offline);
    };
  }, [connect, reconcile, setStatus]);

  return wsRef;
}
