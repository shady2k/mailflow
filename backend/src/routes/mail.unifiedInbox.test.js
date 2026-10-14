import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use('/api/mail', mailRoutes);
  return app;
}

describe('GET /api/mail/unread-counts unified total', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
  });

  it('keeps per-account counts but omits opted-out accounts from the unified total', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { account_id: 'included', count: '2', server_counts_at: new Date(), server_count_revision: '1', include_in_unified_inbox: true },
        { account_id: 'excluded', count: '5', server_counts_at: new Date(), server_count_revision: '2', include_in_unified_inbox: false },
      ],
    });

    const response = await fetch(`${base}/api/mail/unread-counts`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: true,
      total: 2,
      byAccount: { included: 2, excluded: 5 },
    });
  });

  it('identifies the count authority, user, write barrier and badge preference', async () => {
    query.mockResolvedValueOnce({ rows: [{ account_id: 'included', count: 2,
      server_counts_at: new Date(), server_count_revision: '10', status_attempt_revision: '11',
      include_in_unified_inbox: true, show_app_badge: false, barrier_revision: '20' }] });
    const response = await fetch(`${base}/api/mail/unread-counts`);
    expect(await response.json()).toMatchObject({ schemaVersion: 1, kind: 'inbox-unread',
      userId: 'user-1', showAppBadge: false, barrierRevision: '20', total: 2,
      snapshots: { included: { revision: '10', attemptRevision: '11' } } });
  });

  it('preserves unknown, empty, and stale counts distinctly, with user-scoped uncached responses', async () => {
    query.mockResolvedValueOnce({ rows: [
      { account_id: 'unknown', count: null },
      { account_id: 'empty', count: '0', server_counts_at: new Date(), server_count_revision: '2' },
      { account_id: 'offline', count: '3', server_counts_at: new Date(), server_count_revision: '3', status_attempt_revision: '4', status_error: 'offline' },
    ] });
    const response = await fetch(`${base}/api/mail/unread-counts`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ total: 3, complete: false,
      byAccount: { unknown: null, empty: 0, offline: 3 },
      snapshots: { unknown: { known: false, stale: true }, empty: { known: true, stale: false }, offline: { stale: true, attemptRevision: '4' } } });
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
    expect(query.mock.calls[0][0]).toContain('LEFT JOIN folders');
    expect(query.mock.calls[0][0]).not.toContain('FROM messages');
  });

  // The Snoozed view (#269) shows in the sidebar only while something is snoozed.
  it('says how many messages are snoozed, live snoozes in enabled accounts only', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ account_id: 'a', count: '1', server_counts_at: new Date(), server_count_revision: '1' }] })
      .mockResolvedValueOnce({ rows: [{ n: 3 }] });
    const body = await (await fetch(`${base}/api/mail/unread-counts`)).json();
    expect(body.snoozed).toBe(3);
    const [sql, params] = query.mock.calls[1];
    expect(params).toEqual(['user-1']);
    expect(sql).toContain('a.enabled');
    expect(sql).toContain('m.folder = sm.snoozed_folder');
  });

  it('still answers the counts when the snoozed count fails', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ account_id: 'a', count: '1', server_counts_at: new Date(), server_count_revision: '1' }] })
      .mockRejectedValueOnce(new Error('db hiccup'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/api/mail/unread-counts`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ total: 1, snoozed: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it('uses only opted-in accounts for unified category counts', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'included', include_in_unified_inbox: true },
          { id: 'excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ category: 'primary', unread_count: 2 }],
      });

    const response = await fetch(`${base}/api/mail/category-counts`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([['included']]);
  });

  it('returns whole-INBOX totals alongside unread counts independently of page and filters', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'included', include_in_unified_inbox: true }] })
      .mockResolvedValueOnce({ rows: [
        { category: 'primary', total_count: 120, unread_count: 0 },
        { category: 'automated', total_count: 7, unread_count: 2 },
      ] });
    const response = await fetch(`${base}/api/mail/category-counts?limit=1&offset=50&unreadOnly=true&category=automated&q=synthetic`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ counts: { primary: 0, automated: 2 }, totals: { primary: 120, automated: 7 } });
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
    const sql = query.mock.calls[1][0];
    expect(sql).toContain('COUNT(*)::int AS total_count');
    expect(sql).toContain('COUNT(*) FILTER (WHERE m.is_read = false)::int AS unread_count');
    expect(sql).toContain("m.folder = 'INBOX'");
    expect(sql).toContain('m.is_deleted = false');
    expect(sql).not.toMatch(/LIMIT|OFFSET/);
  });

  it('allows an owned opted-out account explicitly without including other accounts', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    query.mockResolvedValueOnce({ rows: [{ id, include_in_unified_inbox: false }, { id: 'other', include_in_unified_inbox: true }] })
      .mockResolvedValueOnce({ rows: [{ category: 'primary', total_count: 5, unread_count: 0 }] });
    const response = await fetch(`${base}/api/mail/category-counts?accountId=${id}`);
    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([[id]]);
    expect(await response.json()).toEqual({ counts: { primary: 0 }, totals: { primary: 5 } });
  });

  it('does not fall back to another account scope for an unowned or disabled account', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'owned', include_in_unified_inbox: true }] });
    const response = await fetch(`${base}/api/mail/category-counts?accountId=22222222-2222-4222-8222-222222222222`);
    expect(response.status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns empty aggregates when no enabled account belongs to the unified inbox', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'excluded', include_in_unified_inbox: false }] });
    const response = await fetch(`${base}/api/mail/category-counts`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ counts: {}, totals: {} });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('uses only opted-in accounts when expanding a unified thread', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'included', include_in_unified_inbox: true },
          { id: 'excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/mail/thread/thread-1?unified=true`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1][0]).toEqual(['included']);
  });
});
