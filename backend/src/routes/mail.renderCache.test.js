import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { BodyIndexer } from '../services/bodyIndexer.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'synthetic-user' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { fetchMessageBody: vi.fn(), noteUserActivity: vi.fn() } }));
import routes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const id = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
describe('render cache after body indexing and repeated opens', () => {
  let server, base, message;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use(routes).listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/messages/${id}/body`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    message = { id, account_id: 'synthetic-account', uid: 42, folder: 'INBOX', message_id: '<synthetic@lab.test>',
      body_html: null, body_text: null, body_index_attempts: 0, snippet: 'Synthetic preview' };
    vi.clearAllMocks();
    query.mockImplementation(async (sql, args) => {
      if (sql.includes('UPDATE messages') && sql.includes('SET body_html =')) {
        if (args[5] !== message.uid || args[7] !== message.message_id) return { rows: [] };
        message.body_html = args[0]; message.body_text = args[1]; message.attachments = args[2];
        if (sql.includes('body_render_cached_at') && args[10]) message.body_render_cached_at = new Date();
      } else if (sql.includes('UPDATE messages SET body_text =')) {
        message.body_text = args[0]; message.body_html = args[1]; message.attachments = args[2];
        message.body_render_cached_at = new Date();
      } else if (sql.includes('SET search_body_text')) {
        message.search_body_text = args[0]; message.body_indexed_at = new Date();
      }
      return { rows: [sql.includes('SELECT * FROM email_accounts') ? { id: 'synthetic-account' } : { ...message }] };
    });
  });
  const open = async () => {
    const res = await fetch(base); expect(res.status).toBe(200); return res.json();
  };
  it('orphan CID does not cause an IMAP fetch on every repeated open', async () => {
    imapManager.fetchMessageBody.mockResolvedValue({ html: '<p>Synthetic HTML<img src="cid:missing"></p>', text: null, attachments: [], found: true, renderComplete: true });
    await open(); await open();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['plain', { html: null, text: 'Synthetic plain body', attachments: [] }],
    ['HTML', { html: '<p>Synthetic HTML body</p>', text: null, attachments: [] }],
    ['empty', { html: null, text: '', attachments: [] }],
    ['attachment-only', { html: null, text: null, attachments: [{ part: '1', filename: 'synthetic.txt', type: 'text/plain', size: 10 }] }],
  ])('uses the completed %s cache on repeated opens', async (_kind, body) => {
    imapManager.fetchMessageBody.mockResolvedValue({ ...body, found: true, renderComplete: true });
    const first = await open(); const second = await open();
    expect(second.text).toBe(first.text);
    expect(second.attachments).toEqual(first.attachments);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(imapManager.noteUserActivity).toHaveBeenCalledWith('synthetic-account');
  });
  it.each([
    ['plain', { html: null, text: 'Visible plain', attachments: [] }],
    ['HTML', { html: '<p>Visible HTML</p>', text: null, attachments: [] }],
  ])('reuses the separately cached %s display body after search extraction', async (_kind, readerBody) => {
    imapManager.fetchMessageBody.mockResolvedValue({ html: readerBody.html, text: 'Complete searchable text including later MIME parts',
      readerBody, attachments: [], found: true, renderComplete: true });
    const worker = new BodyIndexer({ query, fetchBody: imapManager.fetchMessageBody });
    await worker.index({ ...message, account: { id: 'synthetic-account' } });
    expect(message.search_body_text).toContain('later MIME');
    const shown = await open(); await open();
    expect(shown.text).toBe(readerBody.text);
    expect(shown.html).toBe(readerBody.html);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
  });
  it('retries an incomplete reader fetch rather than permanently caching it', async () => {
    imapManager.fetchMessageBody.mockResolvedValueOnce({ html: null, text: null, attachments: [], found: true, renderComplete: false })
      .mockResolvedValue({ html: null, text: 'Complete later', attachments: [], found: true, renderComplete: true });
    await open();
    expect(message.body_render_cached_at).toBeUndefined();
    await open(); await open();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(2);
  });
  it('refuses to persist a fetched body after message identity changes', async () => {
    imapManager.fetchMessageBody.mockImplementation(async () => {
      message.uid = 99; message.message_id = '<replacement@lab.test>';
      return { html: null, text: 'Stale old message', attachments: [], renderComplete: true };
    });
    const res = await fetch(base);
    expect(res.status).toBe(409);
    expect(message.body_text).toBeNull();
    expect(message.body_render_cached_at).toBeUndefined();
  });
  it('does not overwrite a concurrent reader cache with search-only content', async () => {
    message.body_html = '<p>Already rendered</p>';
    imapManager.fetchMessageBody.mockResolvedValue({ text: 'Complete search text', found: true, renderComplete: true,
      readerBody: { html: '<p>Other render</p>', text: null } });
    await new BodyIndexer({ query, fetchBody: imapManager.fetchMessageBody }).index({ ...message, account: { id: 'synthetic-account' } });
    expect(message.body_html).toBe('<p>Already rendered</p>');
  });
});
