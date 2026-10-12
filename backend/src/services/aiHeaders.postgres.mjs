import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createMessageAiContextStore } from './aiTaskContext.js';
test('durable atomic AI summary contexts are account/message scoped and survive reconstructed workers', { skip: !process.env.SEARCH_TEST_DATABASE_URL }, async () => {
  const db = new pg.Client({ connectionString: process.env.SEARCH_TEST_DATABASE_URL }); await db.connect();
  const second = new pg.Client({ connectionString: process.env.SEARCH_TEST_DATABASE_URL }); await second.connect();
  const schema = 'ai_context_'+randomUUID().replaceAll('-', '');
  try {
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; CREATE TABLE messages (id uuid PRIMARY KEY, account_id uuid, is_deleted boolean DEFAULT false, plugin_annotations jsonb)`);
    const account = randomUUID(), id = randomUUID(), other = randomUUID();
    await db.query('INSERT INTO messages(id,account_id,plugin_annotations) VALUES($1,$2,$3),($4,$2,null)', [id,account,{other:{kept:true},gtd:{existing:'kept'}},other]);
    const store = createMessageAiContextStore(db.query.bind(db));
    const first = await store(account,id,'gtd');
    await second.query(`SET search_path TO ${schema}`);
    const rebuilt = createMessageAiContextStore(second.query.bind(second));
    const concurrent = await Promise.all([store(account,id,'gtd'),rebuilt(account,id,'gtd')]);
    assert.deepEqual(concurrent,[first,first]); assert.match(first.sessionId,/^[0-9a-f-]{36}$/);
    await db.query("UPDATE messages SET plugin_annotations=jsonb_set(plugin_annotations,'{gtd}',(plugin_annotations->'gtd')||$2::jsonb) WHERE id=$1",[id,JSON.stringify({aiSummarySessionId:null,gist:'Synthetic completed'})]);
    assert.equal(await rebuilt(account,id,'gtd'),null);
    await db.query("UPDATE messages SET plugin_annotations=jsonb_set(plugin_annotations,'{gtd,gist}','null'::jsonb) WHERE id=$1",[id]);
    const newTask=await rebuilt(account,id,'gtd');assert.notEqual(newTask.sessionId,first.sessionId);
    assert.deepEqual(await store(account,id,'gtd'),newTask);
    const raced = await Promise.all([store(account,other,'gtd'),rebuilt(account,other,'gtd')]);
    assert.deepEqual(raced[0],raced[1]);assert.notEqual(raced[0].sessionId,first.sessionId);
    assert.equal(await rebuilt(randomUUID(),id,'gtd'),null);
    const row = (await db.query('SELECT plugin_annotations FROM messages WHERE id=$1',[id])).rows[0].plugin_annotations;
    assert.equal(row.other.kept,true); assert.equal(row.gtd.existing,'kept'); assert.equal(row.gtd.aiSummarySessionId,newTask.sessionId);
    await db.query('UPDATE messages SET is_deleted=true WHERE id=$1',[id]);assert.equal(await rebuilt(account,id,'gtd'),null);
  } finally { await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();await second.end(); }
});
