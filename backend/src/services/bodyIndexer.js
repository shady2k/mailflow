import { snippetFromBody } from './messageParser.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { Parser } from 'htmlparser2';

export function searchableBody({ text, html }) {
  let out = '';
  let depth = 0;
  const hidden = new Set(['script', 'style', 'head', 'noscript']);
  const parser = new Parser({
    onopentag(name) { if (hidden.has(name)) depth++; if (!depth) out += ' '; },
    onclosetag(name) { if (hidden.has(name) && depth) depth--; if (!depth) out += ' '; },
    ontext(value) { if (!depth) out += value; },
  }, { decodeEntities: true });
  if (html) { parser.write(html); parser.end(); }
  return [text || '', out].join('\n').replace(/\0/g, '').trim();
}

export function retryDelay(attempts) {
  return Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7));
}

export class BodyIndexer {
  constructor({ query, fetchBody, canFetch = () => true, concurrency = 2, delay = 1000 }) {
    Object.assign(this, { query, fetchBody, canFetch, concurrency, delay });
    this.running = false;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try { await this.tick(); } catch (err) { console.warn('Body index scheduler:', err.message); }
      if (!this.stopped) { this.timer = setTimeout(loop, this.delay); this.timer.unref?.(); }
    };
    void loop();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const { rows } = await this.query(`
        WITH candidates AS (
          SELECT pending.id FROM email_accounts a CROSS JOIN LATERAL (
            SELECT m.id FROM messages m WHERE m.account_id = a.id AND NOT m.is_deleted
              AND m.body_indexed_at IS NULL
              AND (m.body_index_retry_at IS NULL OR m.body_index_retry_at <= now())
              AND (m.body_index_lease_until IS NULL OR m.body_index_lease_until <= now())
            ORDER BY m.date DESC NULLS LAST, m.id LIMIT 1 FOR UPDATE SKIP LOCKED
          ) pending WHERE a.enabled AND a.protocol = 'imap' AND NOT a.body_index_paused
          ORDER BY a.body_index_last_run ASC NULLS FIRST, a.id LIMIT $1
        ), claimed AS (
          UPDATE messages m SET body_index_lease_until = now() + interval '10 minutes'
          FROM candidates c WHERE m.id = c.id RETURNING m.*
        ), touched AS (
          UPDATE email_accounts SET body_index_last_run = now()
          WHERE id IN (SELECT account_id FROM claimed) RETURNING id
        ) SELECT c.*, to_jsonb(a) AS account FROM claimed c JOIN touched t ON t.id = c.account_id
          JOIN email_accounts a ON a.id = c.account_id`, [this.concurrency]);
      await Promise.all(rows.map(row => this.index(row)));
    } finally { this.running = false; }
  }

  async index(row) {
    try {
      // Rendering caches may omit later MIME parts; verify full coverage once.
      if (row.account.body_index_paused || this.canFetch(row.account) !== true) {
        await this.query(`UPDATE messages SET body_index_lease_until = NULL,
          body_index_retry_at = now() + interval '5 seconds'
          WHERE id = $1 AND uid = $2 AND folder = $3 AND message_id IS NOT DISTINCT FROM $4`,
        [row.id, row.uid, row.folder, row.message_id]);
        return;
      }
      const body = await this.fetchBody(row.account, row.uid, row.folder);
      if (!body.found && body.text == null && body.html == null) throw Object.assign(new Error('Message body unavailable'), { code: 'body_unavailable' });
      const text = searchableBody(body);
      let cachedText = row.body_text, cachedHtml = row.body_html;
      if (body.readerBody && row.body_text == null && row.body_html == null
          && !/\bcid:/i.test(body.readerBody.html || '')) {
        cachedText = body.readerBody.text?.replace(/\0/g, '') ?? null;
        cachedHtml = body.readerBody.html == null ? null : sanitizeEmail(body.readerBody.html).replace(/\0/g, '');
        const cache = await this.query(`UPDATE messages SET body_text = $1, body_html = $2,
          attachments = $3, body_render_cached_at = now()
          WHERE id = $4 AND uid = $5 AND folder = $6 AND message_id IS NOT DISTINCT FROM $7
            AND NOT is_deleted AND body_text IS NULL AND body_html IS NULL RETURNING id`,
        [cachedText, cachedHtml, JSON.stringify(body.readerBody.attachments || []), row.id, row.uid, row.folder, row.message_id]);
        if (!cache.rows.length) return;
      }
      await this.query(`UPDATE messages SET search_body_text = $1, body_indexed_at = now(),
        body_index_error = NULL, body_index_retry_at = NULL, body_index_lease_until = NULL,
        snippet = CASE WHEN COALESCE(snippet, '') = '' THEN $8 ELSE snippet END
        WHERE id = $2 AND uid = $3 AND folder = $4
          AND message_id IS NOT DISTINCT FROM $5 AND NOT is_deleted
          AND body_text IS NOT DISTINCT FROM $6 AND body_html IS NOT DISTINCT FROM $7`,
      [text, row.id, row.uid, row.folder, row.message_id, cachedText, cachedHtml,
        snippetFromBody(body.readerBody?.text ?? body.text, body.readerBody?.html ?? body.html).replace(/\0/g, '')]);
    } catch (err) {
      if (err.backgroundDeferred) {
        await this.query(`UPDATE messages SET body_index_lease_until = NULL,
          body_index_retry_at = now() + interval '5 seconds'
          WHERE id = $1 AND uid = $2 AND folder = $3 AND message_id IS NOT DISTINCT FROM $4`,
        [row.id, row.uid, row.folder, row.message_id]);
        return;
      }
      const attempts = row.body_index_attempts + 1;
      await this.query(`UPDATE messages SET body_index_attempts = $1, body_index_error = $2,
        body_index_retry_at = now() + $3 * interval '1 millisecond', body_index_lease_until = NULL
        WHERE id = $4 AND uid = $5 AND folder = $6 AND message_id IS NOT DISTINCT FROM $7`,
      [attempts, err.code === 'body_unavailable' ? 'body_unavailable' : 'fetch_failed', retryDelay(attempts), row.id, row.uid, row.folder, row.message_id]);
    }
  }
}

export function bodyIndexWaitReason(manager, account, now = Date.now()) {
  if (manager._secondaryConnectBlocked(account.id)) return 'connection_wait';
  if (manager.backfillAllRunning.has(account.id)) return 'sync_running';
  if (now - (manager.lastUserActivity.get(account.id) || 0) < 5000) return 'user_active';
  return null;
}

export async function controlBodyIndex(query, userId, accountId, action) {
  if (action === 'pause' || action === 'resume') {
    const { rows } = await query(`UPDATE email_accounts SET body_index_paused = $3
      WHERE id = $1 AND user_id = $2 AND enabled AND protocol = 'imap' RETURNING id`,
    [accountId, userId, action === 'pause']);
    return rows.length > 0;
  }
  if (action !== 'retry') throw new TypeError('Invalid indexing action');
  const { rows } = await query(`WITH owned AS (
    SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled AND protocol = 'imap'
    FOR UPDATE
  ), retried AS (
    UPDATE messages SET body_index_error = NULL, body_index_attempts = 0, body_index_retry_at = NULL
    WHERE account_id IN (SELECT id FROM owned) AND NOT is_deleted AND body_indexed_at IS NULL
      AND body_index_error IS NOT NULL
      AND (body_index_lease_until IS NULL OR body_index_lease_until <= now()) RETURNING id
  ) SELECT id FROM owned`, [accountId, userId]);
  return rows.length > 0;
}

export async function bodyIndexStatus(query, userId, waitReason = () => null) {
  const { rows } = await query(`SELECT a.id AS account_id, a.name AS account_name, a.body_index_paused AS paused,
    count(m.id)::int AS headers_loaded,
    count(m.id) FILTER (WHERE m.body_indexed_at IS NOT NULL)::int AS bodies_searchable,
    count(m.id) FILTER (WHERE m.body_indexed_at IS NULL)::int AS pending,
    count(m.id) FILTER (WHERE m.body_indexed_at IS NULL AND m.body_index_error IS NOT NULL)::int AS failed,
    count(m.id) FILTER (WHERE m.body_indexed_at IS NULL AND m.body_index_lease_until > now())::int AS active,
    min(m.body_index_retry_at) FILTER (WHERE m.body_indexed_at IS NULL AND m.body_index_error IS NOT NULL) AS retry_at
    FROM email_accounts a LEFT JOIN messages m ON m.account_id = a.id AND NOT m.is_deleted
    WHERE a.user_id = $1 AND a.enabled AND a.protocol = 'imap'
    GROUP BY a.id ORDER BY a.name`, [userId]);
  return rows.map(row => ({ ...row, complete: row.pending === 0,
    state: row.paused ? 'paused' : row.pending === 0 ? 'complete'
      : waitReason({ id: row.account_id }) || (row.active > 0 ? 'indexing' : row.failed > 0 ? 'retrying' : 'queued'),
  }));
}
