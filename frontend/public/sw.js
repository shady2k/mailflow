// MailFlow Service Worker — handles Web Push and notification clicks.
// Intentionally minimal: no fetch interception, no caching strategy.
// The sole purpose of this SW is push delivery and notification click handling.

// Local-only diagnostics. Never stores notification text, URLs, account IDs or credentials.
const SW_DIAGNOSTICS_VERSION = 'badge-event-proof-v1';
let traceWrites = Promise.resolve();
let traceMemory = [];
function traceStore(entry = null) {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    let db, settled = false;
    const done = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); db?.close(); resolve(value);
    };
    const timer = setTimeout(() => done(null), 800);
    try {
      const open = indexedDB.open('mailflow-sw-diagnostics', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = open.onblocked = () => done(null);
      open.onsuccess = () => {
        db = open.result;
        if (settled) { db.close(); return; }
        try {
          const tx = db.transaction('kv', entry ? 'readwrite' : 'readonly');
          const store = tx.objectStore('kv'); const read = store.get('events'); let entries;
          read.onsuccess = () => {
            entries = Array.isArray(read.result) ? read.result : [];
            entries = entries.filter(e => Date.now() - e.at < 86400000);
            if (entry) entries.push(entry);
            entries = entries.slice(-60);
            if (entry) store.put(entries, 'events');
          };
          tx.oncomplete = () => done(entries || []);
          tx.onerror = tx.onabort = () => done(null);
        } catch { done(null); }
      };
    } catch { done(null); }
  });
}
function swTrace(event, fields = {}) {
  const entry = { at: Date.now(), version: SW_DIAGNOSTICS_VERSION, event, ...fields };
  traceMemory = [...traceMemory, entry].slice(-60);
  traceWrites = traceWrites.catch(() => {}).then(async () => {
    await traceStore(entry);
  });
}
self.addEventListener('message', event => {
  if (event.data?.type !== 'mailflow:sw_diagnostics') return;
  event.waitUntil((async () => {
    await traceWrites;
    const saved = await traceStore();
    event.ports?.[0]?.postMessage({ version: SW_DIAGNOSTICS_VERSION,
      persisted: saved !== null, badgeApiAvailable: Boolean(self.navigator && 'setAppBadge' in self.navigator),
      events: saved || traceMemory });
  })());
});

self.addEventListener('install', () => {
  // Force this SW to activate immediately, bypassing the waiting phase.
  // Safe here because this SW does no fetch interception or caching — there
  // is no state to hand off from the old version to the new one.
  self.skipWaiting();
  swTrace('install');
});

self.addEventListener('activate', (event) => {
  // Take control of all existing clients so push events reach this SW version.
  swTrace('activate');
  event.waitUntil(Promise.all([self.clients.claim(), traceWrites]));
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch (_) {
    return;
  }

  const {
    title       = 'MailFlow',
    body        = 'New message',
    icon        = '/icon-512.png',
    badge       = '/badge-96.png',
    url         = '/',
  } = data;

  swTrace('push', { hasEventProof: Boolean(data.badgeEvent) });
  // Notification delivery never waits for a client lookup, HTTP or IMAP STATUS.
  const notification = self.registration.showNotification(title, {
    body, icon, badge, data: { url }, tag: 'mailflow-new-mail', renotify: true,
  }).then(() => { swTrace('notification_resolved'); }, () => { swTrace('notification_rejected'); });
  const refresh = self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => {
      swTrace('clients', { visible: clients.filter(c => c.visibilityState === 'visible').length,
        hidden: clients.filter(c => c.visibilityState !== 'visible').length });
      for (const client of clients) client.postMessage({ type: 'mailflow:counts_refresh' });
      if (clients.some(client => client.visibilityState === 'visible')) {
        swTrace('badge_skipped', { reason: 'visible_client' }); return;
      }
      return refreshAppBadge(data.badgeEvent);
    }).catch(() => { swTrace('badge_skipped', { reason: 'client_lookup_or_refresh_failed' }); });
  event.waitUntil(Promise.all([notification, refresh]).finally(() => traceWrites));
});

let badgeRefreshGeneration = 0;
let badgeWrite = Promise.resolve();
self.addEventListener('message', event => {
  if (event.data?.type !== 'mailflow:badge') return;
  ++badgeRefreshGeneration;
  swTrace('page_badge', { total: Number.isFinite(event.data.total) ? event.data.total : null, enabled: event.data.enabled === true });
  // All controlled tabs/PWA instances share this writer. Preserve submission order even
  // when the OS API is asynchronous, and keep a failed call from poisoning the queue.
  event.waitUntil(queueBadge(event.data.total, event.data.enabled).finally(() => traceWrites));
});

function queueBadge(total, enabled = true) {
  if (!Number.isFinite(total) || total < 0) return Promise.resolve();
  badgeWrite = badgeWrite.catch(() => {}).then(async () => {
    if (!self.navigator || !('setAppBadge' in self.navigator)) { swTrace('badge_skipped', { reason: 'api_unavailable' }); return; }
    swTrace('badge_requested', { total: enabled ? total : 0 });
    if (enabled && total > 0) await self.navigator.setAppBadge(total);
    else await self.navigator.clearAppBadge();
    swTrace('badge_resolved', { total: enabled ? total : 0 });
  }).catch(() => { swTrace('badge_rejected'); });
  return badgeWrite;
}

const BADGE_FETCH_MS = 4000;
const BADGE_RETRY_MS = 3000;
function postEventSnapshot(counts, event) {
  const sample = counts.snapshots?.[event.accountId];
  return sample?.known === true && !sample.stale && /^\d{1,20}$/.test(String(sample.revision))
    && BigInt(sample.revision) > BigInt(event.afterRevision);
}
async function fetchBadgeSnapshot(refresh) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BADGE_FETCH_MS);
  const started = Date.now();
  try {
    const response = await fetch('/api/mail/unread-counts' + (refresh ? '?refresh=1' : ''), {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'X-Requested-With': 'MailFlow' },
    });
    swTrace('counts_http', { status: response.status, refresh, durationMs: Date.now() - started });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    swTrace('counts_failed', { reason: controller.signal.aborted ? 'timeout' : error?.name === 'SyntaxError' ? 'invalid_json' : 'network_or_redirect', refresh });
    return null;
  } finally { clearTimeout(timer); }
}
async function refreshAppBadge(event) {
  const generation = ++badgeRefreshGeneration;
  if (!self.navigator || !('setAppBadge' in self.navigator)) { swTrace('badge_skipped', { reason: 'api_unavailable' }); return; }
  if (!event || typeof event.accountId !== 'string' || !/^\d{1,20}$/.test(event.afterRevision || '')) {
    swTrace('badge_skipped', { reason: 'missing_event_proof' }); return;
  }
  // Existing backend STATUS coalescing and the 5s minimum interval bound IMAP work
  // across devices. The HTTP/retry budget is 18s (3 x 4s fetch + 2 x 3s delay);
  // showNotification runs independently, without waiting for STATUS.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (generation !== badgeRefreshGeneration) { swTrace('badge_skipped', { reason: 'superseded' }); return; }
    const counts = await fetchBadgeSnapshot(attempt > 0);
    if (generation !== badgeRefreshGeneration) { swTrace('badge_skipped', { reason: 'superseded' }); return; }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (generation !== badgeRefreshGeneration) return;
    if (clients.some(client => client.visibilityState === 'visible')) {
      for (const client of clients) client.postMessage({ type: 'mailflow:counts_refresh' });
      swTrace('badge_skipped', { reason: 'visible_client' }); return;
    }
    if (counts?.showAppBadge === false) { await queueBadge(0, false); return; }
    const proof = counts ? postEventSnapshot(counts, event) : false;
    swTrace('counts_decision', { attempt, complete: counts?.complete === true,
      total: Number.isFinite(counts?.total) ? counts.total : null, proof, afterRevision: event.afterRevision,
      sampleRevision: /^\d{1,20}$/.test(String(counts?.snapshots?.[event.accountId]?.revision)) ? String(counts.snapshots[event.accountId].revision) : null });
    if (counts?.complete && Number.isSafeInteger(counts.total) && counts.total >= 0 && proof) {
      await queueBadge(counts.total); return;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, BADGE_RETRY_MS));
  }
  swTrace('badge_skipped', { reason: 'fresh_snapshot_unavailable' });
}

// Persist a deep-link target in IndexedDB so the page can consume it on focus or
// launch. This is the reliable channel on iOS: postMessage can be missed on a
// focus-with-reload, and iOS ignores the openWindow() URL on a cold launch — but a
// persisted target survives both. Fully guarded so a storage error never rejects
// the waitUntil. (Only reachable when the app is backgrounded — iOS does not fire
// notificationclick at all for a fully-terminated PWA.)
function storePendingDeepLink(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const open = indexedDB.open('mailflow-nav', 1);
      open.onupgradeneeded = () => { try { open.result.createObjectStore('kv'); } catch (_) {} };
      open.onerror = done;
      open.onblocked = done;
      open.onsuccess = () => {
        try {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(url, 'pending_deeplink');
          tx.oncomplete = () => { db.close(); done(); };
          tx.onerror = () => { db.close(); done(); };
          tx.onabort = () => { db.close(); done(); };
        } catch (_) { done(); }
      };
    } catch (_) { done(); }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  const deepLink = !!targetUrl && targetUrl !== '/';

  event.waitUntil(
    (deepLink ? storePendingDeepLink(targetUrl) : Promise.resolve())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => {
        const existing = clients.find(
          (c) => new URL(c.url).origin === self.location.origin
        );
        if (existing) {
          // Nudge the live client to consume the persisted deep-link immediately
          // (no reload). Harmless if nothing is listening.
          if (deepLink) existing.postMessage({ type: 'mailflow_deeplink' });
          return existing.focus();
        }
        // Cold/killed: openWindow's URL is honored on Chromium and ignored on iOS,
        // but the persisted target above covers iOS on the next app launch.
        return self.clients.openWindow(targetUrl);
      })
  );
});
