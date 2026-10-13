import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { freeTextTermCondition, searchRowsSQL } from './searchText.js';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Unicode body search PostgreSQL', () => {
  let database;
  const account = '11111111-1111-4111-8111-111111111111';
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    const schema = 'mf_qa_' + randomUUID().replaceAll('-', '');
    await database.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, pg_temp, pg_catalog`);
    database.fixtureSchema = schema;

    const migration = readFileSync(new URL('../../migrations/0066_unicode_body_index.sql', import.meta.url), 'utf8');
    await database.query(migration.slice(0, migration.indexOf('ALTER TABLE')));
    await database.query(`CREATE TEMP TABLE email_accounts (id uuid, name text, email_address text, color text);
      CREATE TEMP TABLE messages (id uuid, account_id uuid, uid bigint, folder text, message_id text,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        in_reply_to text, thread_references jsonb, date timestamptz, snippet text,
        is_read boolean, is_starred boolean, has_attachments boolean, is_deleted boolean DEFAULT false,
        body_text text, search_body_text text, body_indexed_at timestamptz);
      INSERT INTO email_accounts VALUES ('${account}', 'Synthetic', 'synthetic@example.invalid', '#000');`);
    await database.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,subject,date,search_body_text,body_text,body_indexed_at)
      VALUES ('22222222-2222-4222-8222-222222222222',$1,1,'INBOX','<synthetic@example.invalid>','Unrelated subject',now(),
        'Поздняя MIME часть: ЁЖИК Спасибо ENbody','First part only',now())`, [account]);
  });
  afterAll(async () => { if (database?.fixtureSchema) await database.query(`DROP SCHEMA ${database.fixtureSchema} CASCADE`);
    await database?.end(); });
  it.each(['ёжик', 'ЁЖИК', 'спасибо', 'СПАСИБО', 'enbody', 'ENBODY'])('finds %s in verified full-body text regardless of RU/EN case', async term => {
    const { rows } = await database.query(searchRowsSQL([freeTextTermCondition(2)], 3), [[account], `%${term}%`, 50, 0]);
    expect(rows.map(row => row.uid)).toEqual(['1']);
  });
  it('does not expose another account through a matching body', async () => {
    const { rows } = await database.query(searchRowsSQL([freeTextTermCondition(2)], 3), [['33333333-3333-4333-8333-333333333333'], '%Спасибо%', 50, 0]);
    expect(rows).toEqual([]);
  });
});
