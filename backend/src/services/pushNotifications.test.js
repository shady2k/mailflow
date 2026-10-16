import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn().mockResolvedValue() } }));
import { query } from './db.js';
import webPush from 'web-push';
let sendPushToUser;
beforeAll(async () => {
  vi.stubEnv('VAPID_PUBLIC_KEY', 'synthetic-public');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'synthetic-private');
  ({ sendPushToUser } = await import('./pushNotifications.js'));
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => { query.mockReset(); webPush.sendNotification.mockClear(); });
const subscription = { id: 's', endpoint: 'https://push.example.invalid/synthetic', p256dh: 'synthetic', auth: 'synthetic' };
it('push uses the same server Inbox observation and scope as HTTP, dropping legacy cached tallies', async () => {
  query.mockResolvedValueOnce({ rows: [subscription] }).mockResolvedValueOnce({ rows: [
    { account_id: 'included', count: 2, server_counts_at: new Date(), server_count_revision: '10', include_in_unified_inbox: true, barrier_revision: '12', show_app_badge: false },
    { account_id: 'excluded', count: 5, server_counts_at: new Date(), server_count_revision: '11', include_in_unified_inbox: false, barrier_revision: '12', show_app_badge: false },
  ] });
  await sendPushToUser('user-1', { title: 'Synthetic notification', unreadCount: 99 }, { countAccountId: 'included' });
  const payload = JSON.parse(webPush.sendNotification.mock.calls[0][1]);
  expect(payload.unreadCount).toBeUndefined();
  expect(payload.badgeEvent).toEqual({ accountId: 'included', afterRevision: '12' });
  expect(payload.countUserId).toBe('user-1');
  expect(payload.counts).toMatchObject({ kind: 'inbox-unread', userId: 'user-1', total: 2,
    byAccount: { included: 2, excluded: 5 }, showAppBadge: false, barrierRevision: '12' });
  expect(query.mock.calls[1][0]).not.toContain('FROM messages');
});
it('count query failure still delivers the notification without inventing a zero badge', async () => {
  query.mockResolvedValueOnce({ rows: [subscription] }).mockRejectedValueOnce(new Error('Synthetic database failure'));
  await sendPushToUser('user-1', { title: 'Synthetic notification', unreadCount: 9 });
  const payload = JSON.parse(webPush.sendNotification.mock.calls[0][1]);
  expect(payload.title).toBe('Synthetic notification');
  expect(payload.counts).toBeUndefined();
  expect(payload.unreadCount).toBeUndefined();
});

it('ignores a caller-supplied badge event and omits proof when its own snapshot fails', async () => {
  query.mockResolvedValueOnce({ rows: [subscription] }).mockRejectedValueOnce(new Error('Synthetic count failure'));
  await sendPushToUser('user-1', { title: 'Still notify', badgeEvent: { accountId: 'forged', afterRevision: '0' } }, { countAccountId: 'included' });
  const payload = JSON.parse(webPush.sendNotification.mock.calls[0][1]);
  expect(payload.title).toBe('Still notify'); expect(payload.badgeEvent).toBeUndefined();
});
