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
          ) pending WHERE a.enabled AND a.protocol = 'imap'
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
      if (!this.canFetch(row.account)) throw new Error('Provider temporarily limiting background connections');
      const body = await this.fetchBody(row.account, row.uid, row.folder);
      if (!body.found && body.text == null && body.html == null) throw new Error('Message body unavailable; retry pending');
      const text = searchableBody(body);
      await this.query(`UPDATE messages SET search_body_text = $1, body_indexed_at = now(),
        body_index_error = NULL, body_index_retry_at = NULL, body_index_lease_until = NULL
        WHERE id = $2 AND uid = $3 AND folder = $4
          AND message_id IS NOT DISTINCT FROM $5 AND NOT is_deleted
          AND body_text IS NOT DISTINCT FROM $6 AND body_html IS NOT DISTINCT FROM $7`,
      [text, row.id, row.uid, row.folder, row.message_id, row.body_text, row.body_html]);
    } catch (err) {
      const attempts = row.body_index_attempts + 1;
      await this.query(`UPDATE messages SET body_index_attempts = $1, body_index_error = $2,
        body_index_retry_at = now() + $3 * interval '1 millisecond', body_index_lease_until = NULL
        WHERE id = $4 AND uid = $5 AND folder = $6 AND message_id IS NOT DISTINCT FROM $7`,
      [attempts, String(err.message).slice(0, 300), retryDelay(attempts), row.id, row.uid, row.folder, row.message_id]);
    }
  }
}

export async function bodyIndexStatus(query, userId) {
  const { rows } = await query(`SELECT a.id AS account_id, a.name AS account_name,
    count(m.id)::int AS headers_loaded,
    count(m.id) FILTER (WHERE m.body_indexed_at IS NOT NULL)::int AS bodies_searchable,
    count(m.id) FILTER (WHERE m.body_indexed_at IS NULL)::int AS pending,
    count(m.id) FILTER (WHERE m.body_indexed_at IS NULL AND m.body_index_error IS NOT NULL)::int AS failed,
    max(m.body_index_error) FILTER (WHERE m.body_indexed_at IS NULL) AS last_error
    FROM email_accounts a LEFT JOIN messages m ON m.account_id = a.id AND NOT m.is_deleted
    WHERE a.user_id = $1 AND a.enabled AND a.protocol = 'imap'
    GROUP BY a.id ORDER BY a.name`, [userId]);
  return rows.map(row => ({ ...row, complete: row.pending === 0 }));
}
