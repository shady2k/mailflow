import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const migration = name => readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8');
it.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('both 0066 migrations coexist on fresh install and preserve indexed bodies on upgrade', async () => {
 const client=new pg.Client({connectionString:process.env.MAILFLOW_TEST_DATABASE_URL});await client.connect();
 try {
  for(const upgrade of [false,true]) {
   await client.query('BEGIN');
   const schema='mf_migration_'+randomUUID().replaceAll('-','');
   await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema},pg_temp,pg_catalog;
    CREATE TABLE email_accounts(id uuid PRIMARY KEY);
    CREATE TABLE messages(id uuid PRIMARY KEY,message_id text,body_text text,body_html text);
    CREATE TABLE schema_migrations(version text PRIMARY KEY);`);
   const icon='0066_email_accounts_icon',unicode='0066_unicode_body_index';
   if(!upgrade){await client.query(migration(icon));await client.query('INSERT INTO schema_migrations VALUES($1)',[icon]);}
   await client.query(migration(unicode));await client.query('INSERT INTO schema_migrations VALUES($1)',[unicode]);
   const id=randomUUID();
   await client.query("INSERT INTO messages(id,message_id,body_text,search_body_text,body_index_attempts) VALUES($1,'synthetic','Тело','индекс',2)",[id]);
   if(upgrade){await client.query(migration(icon));await client.query('INSERT INTO schema_migrations VALUES($1)',[icon]);}
   expect((await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version)).toEqual([icon,unicode]);
   expect((await client.query('SELECT body_text,search_body_text,body_index_attempts FROM messages WHERE id=$1',[id])).rows[0]).toEqual({body_text:'Тело',search_body_text:'индекс',body_index_attempts:2});
   expect((await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='email_accounts' AND column_name='icon'",[schema])).rowCount).toBe(1);
   await client.query('ROLLBACK');
  }
 } finally {await client.query('ROLLBACK');await client.end();}
});
