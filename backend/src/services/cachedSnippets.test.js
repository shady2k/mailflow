import { it, expect, vi } from 'vitest';
import { backfillCachedSnippets } from './cachedSnippets.js';
import { BodyIndexer } from './bodyIndexer.js';
const row = { id: 'm', account_id: 'a', uid: 7, folder: 'INBOX', message_id: 'identity', body_text: null, body_html: null };
it.each([{body_text:'Plain preview'}, {body_html:'<style>hidden</style><p>HTML &amp; preview</p>'}, {body_text:''}])('fills only missing indexer snippet from fetched body %s', async body => {
 const query=vi.fn().mockResolvedValue({rows:[]});
 await new BodyIndexer({query,fetchBody:async()=>({text:body.body_text,html:body.body_html,found:true})}).index({...row,account:{id:'a'}});
 const [sql,params]=query.mock.calls[0];expect(sql).toContain("CASE WHEN COALESCE(snippet, '') = '' THEN $8 ELSE snippet END");
 expect(params[7]).toBe(body.body_text ?? 'HTML & preview');expect(sql).toContain('message_id IS NOT DISTINCT');
});
it('backfills plain and HTML cache, skips empty, and guards identity/body/existing snippet',async()=>{
 const rows=[{...row,id:'1',body_text:'Plain'}, {...row,id:'2',body_html:'<p>HTML &amp; preview</p>'}, {...row,id:'3',body_text:''}, {...row,id:'4',body_text:'Changed'}];
 const query=vi.fn().mockResolvedValueOnce({rows}).mockResolvedValueOnce({rows:[{id:'1'}]}).mockResolvedValueOnce({rows:[{id:'2'}]}).mockResolvedValueOnce({rows:[]});
 const r=await backfillCachedSnippets(query,{batchSize:10});expect(r).toMatchObject({scanned:4,updated:2,empty:1,changed:1,complete:true});
 const [sql,params]=query.mock.calls[1];for(const guard of ['account_id = $3','uid = $4','folder = $5','message_id IS NOT DISTINCT','body_text IS NOT DISTINCT','body_html IS NOT DISTINCT',"COALESCE(snippet, '') = ''"])expect(sql).toContain(guard);expect(params[0]).toBe('Plain');
});
it('is bounded, advances past empty rows and repeated completed pass performs no updates',async()=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{...row,id:'1',body_text:''}]}).mockResolvedValueOnce({rows:[]});
 expect(await backfillCachedSnippets(query,{batchSize:1,maxBatches:1})).toMatchObject({scanned:1,empty:1,after:'1',complete:false});
 expect(await backfillCachedSnippets(query,{after:'1'})).toMatchObject({scanned:0,updated:0,complete:true});expect(query.mock.calls[1][1][0]).toBe('1');
 await expect(backfillCachedSnippets(query,{batchSize:501})).rejects.toThrow('Invalid');
});
