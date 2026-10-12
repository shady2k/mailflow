import { before as beforeAll, after as afterAll, beforeEach, describe, it } from 'node:test';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BodyIndexer, bodyIndexStatus, controlBodyIndex } from './bodyIndexer.js';
import { freeTextTermCondition, foldedMatch, searchRowsSQL } from './searchText.js';

function expect(value) {
  return {
    toBe: expected => assert.equal(value, expected),
    toHaveLength: expected => assert.equal(value.length, expected),
    toContain: expected => assert.ok(value.includes(expected), `Missing ${expected}`),
    toBeNull: () => assert.equal(value, null),
  };
}
const url = process.env.SEARCH_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL C-locale full-body search and durable queue', () => {
  const client = new pg.Client({ connectionString: url });
  const schema = 'search_test_' + randomUUID().replaceAll('-', '');
  const query = (sql, values) => client.query(sql, values);
  let a, b;
  beforeAll(async () => {
    await client.connect();
    await query(`CREATE SCHEMA ${schema}`);
    await query(`SET search_path TO ${schema}, public`);
    await query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await query(`CREATE TABLE email_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      name text, email_address text, color text, enabled boolean DEFAULT true, protocol text DEFAULT 'imap');
      CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, uid integer,
      folder text DEFAULT 'INBOX', message_id text, subject text, from_name text, from_email text,
      date timestamptz DEFAULT '2026-01-01', is_deleted boolean DEFAULT false, body_text text, body_html text,
      to_addresses jsonb, cc_addresses jsonb, in_reply_to text, thread_references text[], snippet text,
      is_read boolean DEFAULT false, is_starred boolean DEFAULT false, has_attachments boolean DEFAULT false)`);
    if (process.env.SEARCH_TEST_NO_ICU) await query('CREATE COLLATION mailflow_search FROM "C"');
    const migrations = ['0066_unicode_body_index.sql', '0067_unicode_search_indexes.sql', '0068_body_index_controls.sql'];
    for (const file of migrations) {
      const sql = await readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8');
      if (file.startsWith('0067')) {
        for (const statement of sql.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) await query(statement);
      } else await query(sql);
    }
    console.log((await query('SELECT version(), datctype AS locale FROM pg_database WHERE datname=current_database()')).rows[0]);
  }, { timeout: 30000 });
  afterAll(async () => { await query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); });
  beforeEach(async () => {
    await query('TRUNCATE messages, email_accounts');
    const user = randomUUID();
    a = (await query("INSERT INTO email_accounts(user_id,name) VALUES ($1,'Alice') RETURNING *", [user])).rows[0];
    b = (await query("INSERT INTO email_accounts(user_id,name) VALUES ($1,'Bob') RETURNING *", [user])).rows[0];
  });
  const insert = async (account, uid, fields = {}) => (await query(`INSERT INTO messages
    (account_id, uid, folder, message_id, subject, from_name, from_email, body_text, body_html)
    VALUES ($1,$2,$3,$4,$5,$6,'sender@lab.test',$7,$8) RETURNING *`,
  [account.id, uid, fields.folder || 'INBOX', fields.mid || `<${uid}@lab.test>`, fields.subject || 'Спасибо HELLO', fields.sender || 'АЛЕКСЕЙ Smith', fields.text ?? null, fields.html ?? null])).rows[0];
  const search = async term => (await query(`SELECT m.* FROM messages m WHERE ${freeTextTermCondition(1)}`, [`%${term}%`])).rows;

  it('persists pause across workers, resumes, and retries without removing cached data', async () => {
    const m = await insert(a, 51, { text: 'Cached text', html: '<p>Cached HTML</p>' });
    assert.equal(await controlBodyIndex(query, randomUUID(), a.id, 'pause'), false);
    assert.equal(await controlBodyIndex(query, a.user_id, a.id, 'pause'), true);
    const fetchBody = async () => { throw new Error('Should not fetch while paused'); };
    await new BodyIndexer({ query, fetchBody }).tick();
    assert.equal((await bodyIndexStatus(query, a.user_id))[0].state, 'paused');
    assert.equal((await query('SELECT body_index_attempts FROM messages WHERE id=$1', [m.id])).rows[0].body_index_attempts, 0);
    await controlBodyIndex(query, a.user_id, a.id, 'resume');
    await new BodyIndexer({ query, fetchBody: async () => ({ text: 'Verified complete body', found: true }) }).tick();
    const indexed = (await query('SELECT * FROM messages WHERE id=$1', [m.id])).rows[0];
    await controlBodyIndex(query, a.user_id, a.id, 'retry');
    const after = (await query('SELECT * FROM messages WHERE id=$1', [m.id])).rows[0];
    assert.equal(after.search_body_text, indexed.search_body_text);
    assert.equal(after.body_html, '<p>Cached HTML</p>');
    assert.equal(after.body_text, 'Cached text');
    assert.ok(after.body_indexed_at);
  });

  it('retry skips live leases and ready messages, resetting only failed work', async () => {
    const ready = await insert(a, 61);
    const failed = await insert(a, 62);
    const active = await insert(a, 63);
    await query("UPDATE messages SET search_body_text='kept', body_indexed_at=now() WHERE id=$1", [ready.id]);
    await query("UPDATE messages SET body_index_error='fetch_failed',body_index_attempts=3,body_index_retry_at=now()+interval '1 hour' WHERE id=ANY($1)", [[failed.id,active.id]]);
    await query("UPDATE messages SET body_index_lease_until=now()+interval '10 minutes' WHERE id=$1", [active.id]);
    await controlBodyIndex(query, a.user_id, a.id, 'retry');
    const rows = (await query('SELECT * FROM messages WHERE account_id=$1 ORDER BY uid', [a.id])).rows;
    assert.equal(rows[0].search_body_text, 'kept');
    assert.equal(rows[1].body_index_error, null);
    assert.equal(rows[1].body_index_attempts, 0);
    assert.equal(rows[2].body_index_error, 'fetch_failed');
    assert.ok(rows[2].body_index_lease_until);
  });

  it('folds Cyrillic and English under C and matches the same expression index', async () => {
    await insert(a, 1, { text: 'Полное СОДЕРЖИМОЕ English' });
    expect((await query('SELECT mailflow_search_fold($1) AS folded', ['СПАСИБО ЁЖ HELLO'])).rows[0].folded).toBe('спасибо ёж hello');
    expect(await search('спасибо')).toHaveLength(1);
    expect(await search('алексей')).toHaveLength(1);
    expect(await search('english')).toHaveLength(1);
    await query('SET enable_seqscan=off');
    const plan = (await query(`EXPLAIN SELECT id FROM messages WHERE
      (mailflow_search_fold(subject) COLLATE mailflow_search) LIKE mailflow_search_fold($1) COLLATE mailflow_search`, ['%спасибо%'])).rows.map(r => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('idx_messages_subject_unicode_trgm');
    await query('RESET enable_seqscan');
  });
  it('materializes unopened plain/HTML in multiple accounts and archive; repeated ticks do not redownload', async () => {
    await insert(a, 2);
    await insert(b, 3, { folder: '[Gmail]/All Mail' });
    let fetches = 0;
    const fetchBody = async (_account, uid) => { fetches++; return uid === 2
      ? { text: 'OnlyPlainToken ПРИВЕТ', found: true }
      : { html: '<script>DoNotIndex</script><p>' + 'x'.repeat(650000) + '</p><p>OnlyHtmlToken АРХИВ</p>', found: true }; };
    const worker = new BodyIndexer({ query, fetchBody });
    await worker.tick();
    expect(await search('onlyplaintoken')).toHaveLength(1);
    expect(await search('onlyhtmltoken')).toHaveLength(1);
    expect(await search('архив')).toHaveLength(1);
    expect(await search('DoNotIndex')).toHaveLength(0);
    expect((await query("SELECT count(*)::int AS n FROM messages WHERE folder='[Gmail]/All Mail' AND body_indexed_at IS NOT NULL")).rows[0].n).toBe(1);
    await new BodyIndexer({ query, fetchBody }).tick();
    expect(fetches).toBe(2);
    expect((await bodyIndexStatus(query, a.user_id)).every(s => s.complete)).toBe(true);
  });
  it('persists retry/error across restart and resumes expired claims', async () => {
    const message = await insert(a, 4);
    await new BodyIndexer({ query, fetchBody: async () => { throw new Error('synthetic transient'); } }).tick();
    const status = await bodyIndexStatus(query, a.user_id);
    expect(status.find(s => s.account_id === a.id).failed).toBe(1);
    const fetchBody = async () => ({ text: 'RecoveredToken', found: true });
    await new BodyIndexer({ query, fetchBody }).tick();
    expect(await search('RecoveredToken')).toHaveLength(0);
    await query("UPDATE messages SET body_index_retry_at=now()-interval '1 minute', body_index_lease_until=now()-interval '1 minute' WHERE id=$1", [message.id]);
    await new BodyIndexer({ query, fetchBody }).tick();
    expect(await search('RecoveredToken')).toHaveLength(1);
    expect((await bodyIndexStatus(query, a.user_id)).find(s => s.account_id === a.id).failed).toBe(0);
  });
  it('indexes all accounts fairly without trusting duplicate Message-IDs', async () => {
    await insert(a, 5, { text: 'DuplicateBody', mid: '<same>' });
    await new BodyIndexer({ query, fetchBody: async () => ({ text: 'DuplicateBody', found: true }) }).tick();
    await insert(a, 6, { folder: '[Gmail]/All Mail', mid: '<same>' });
    await insert(b, 7, { text: 'OtherAccountBody' });
    const fetchBody = async (account) => ({ text: account.id === a.id ? 'DistinctDuplicateBody' : 'OtherAccountBody', found: true });
    const worker = new BodyIndexer({ query, fetchBody });
    await worker.tick(); await worker.tick();
    expect(await search('duplicatebody')).toHaveLength(2);
    expect(await search('otheraccountbody')).toHaveLength(1);
  });
  it('deduplicates within account after folder filters, preserves archive and account copies', async () => {
    await insert(a, 10, { text: 'FolderToken', mid: '<same>', folder: 'INBOX' });
    await insert(a, 11, { text: 'FolderToken', mid: '<same>', folder: '[Gmail]/All Mail' });
    await insert(a, 12, { text: 'FolderToken', mid: '<archive-only>', folder: '[Gmail]/All Mail' });
    await insert(b, 13, { text: 'FolderToken', mid: '<same>' });
    await query('UPDATE messages SET search_body_text=body_text, body_indexed_at=now()');
    const all = await query(searchRowsSQL([freeTextTermCondition(2)], 3), [[a.id,b.id], '%foldertoken%', 50, 0]);
    expect(all.rows).toHaveLength(3);
    const archived = await query(searchRowsSQL([freeTextTermCondition(2), 'm.folder = $3'], 4), [[a.id], '%FOLDERTOKEN%', '[Gmail]/All Mail', 50, 0]);
    expect(archived.rows).toHaveLength(2);
    const subjects = await query(searchRowsSQL([foldedMatch('m.subject', 2), foldedMatch('m.from_name', 3)], 4), [[a.id,b.id], '%спасибо%', '%алексей%', 50, 0]);
    expect(subjects.rows).toHaveLength(3);
    await insert(a, 14, { text: 'FolderToken', mid: '<same>', folder: 'INBOX' });
    await query('UPDATE messages SET search_body_text=body_text, body_indexed_at=now()');
    const repeated = await query(searchRowsSQL([freeTextTermCondition(2)], 3), [[a.id,b.id], '%foldertoken%', 50, 0]);
    expect(repeated.rows).toHaveLength(4);
    await insert(a, 15, { text: 'DifferentBodyToken', mid: '<same>', folder: 'INBOX' });
    await query('UPDATE messages SET search_body_text=body_text, body_indexed_at=now()');
    expect((await query(searchRowsSQL([freeTextTermCondition(2)], 3), [[a.id], '%differentbodytoken%', 50, 0])).rows).toHaveLength(1);
  });
  it('invalidates changed draft text and refuses a result for a changed/moved row', async () => {
    const message = await insert(a, 8, { text: 'OldDraft' });
    const worker = new BodyIndexer({ query, fetchBody: async () => ({ text: 'NewDraft', found: true }) });
    await worker.tick();
    await query('UPDATE messages SET body_text=$1 WHERE id=$2', ['NewDraft', message.id]);
    expect((await query('SELECT body_indexed_at FROM messages WHERE id=$1',[message.id])).rows[0].body_indexed_at).toBeNull();
    await worker.index({ ...message, account: a, body_index_attempts: 0 });
    expect((await query('SELECT body_indexed_at FROM messages WHERE id=$1',[message.id])).rows[0].body_indexed_at).toBeNull();
    await worker.tick();
    expect(await search('newdraft')).toHaveLength(1);
    expect(await search('olddraft')).toHaveLength(0);
  });
});
