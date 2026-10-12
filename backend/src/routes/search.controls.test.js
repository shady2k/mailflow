import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, res, next) => {
  if (!req.headers['x-test-user']) return res.sendStatus(401);
  req.session = { userId: req.headers['x-test-user'] }; next();
} }));
import routes from './search.js';
import { query } from '../services/db.js';

describe('owned background indexing controls', () => {
  let server, base;
  const id = '7f9d2206-5f82-4447-8221-7ba0b1d62c1b';
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use(express.json()).use(routes).listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/index-status/`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [{ id }] }); });
  const post = (account, action, user = 'owner') => fetch(base + account, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify({ action }),
  });
  it('requires authentication and validates account/action before SQL', async () => {
    expect((await post(id, 'pause', null)).status).toBe(401);
    expect((await post('bad', 'pause')).status).toBe(400);
    expect((await post(id, 'clear')).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('returns 404 for other owners, disabled or non-IMAP accounts', async () => {
    query.mockResolvedValue({ rows: [] });
    expect((await post(id, 'pause', 'other')).status).toBe(404);
    expect(query.mock.calls[0][1]).toEqual([id, 'other', true]);
    expect(query.mock.calls[0][0]).toContain("enabled AND protocol = 'imap'");
  });
  it('persists each valid action in the session owner scope', async () => {
    for (const action of ['pause', 'resume', 'retry']) expect((await post(id, action)).status).toBe(200);
    expect(query.mock.calls.every(([, args]) => args[0] === id && args[1] === 'owner')).toBe(true);
  });
});
