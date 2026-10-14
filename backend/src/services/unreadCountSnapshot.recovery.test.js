import { it,expect,vi,beforeEach } from 'vitest';
vi.mock('./db.js',()=>({query:vi.fn()}));
import {query} from './db.js';
import {getFreshUnreadCountSnapshot} from './unreadCountSnapshot.js';
beforeEach(()=>{query.mockReset();});
it('captures watermark before observations and limits refresh to current enabled IMAP accounts',async()=>{
 const order=[];
 query.mockImplementation(async sql=>{
  if(sql.startsWith('SELECT last_value')){order.push('barrier');return {rows:[{revision:'10'}]};}
  if(sql.startsWith('SELECT * FROM email_accounts')){expect(sql).toContain("user_id=$1 AND enabled AND protocol='imap'");return {rows:[{id:'a'}]};}
  order.push('snapshot');return {rows:[{account_id:'a',count:0,server_total_count:0,server_counts_at:new Date(),server_count_revision:'11',status_attempt_revision:'11',barrier_revision:'12'}]};
 });
 const result=await getFreshUnreadCountSnapshot('u',async()=>{order.push('observe');});
 expect(order).toEqual(['barrier','observe','snapshot']);expect(result.recoveryBarrierRevision).toBe('10');expect(result.snapshots.a.recoveryBarrierRevision).toBe('10');expect(result.byAccount.a).toBe(0);
});
it('failed observation retains old authority and never invents a fresh revision',async()=>{
 query.mockResolvedValueOnce({rows:[{revision:'10'}]}).mockResolvedValueOnce({rows:[{id:'a'}]}).mockResolvedValueOnce({rows:[{account_id:'a',count:1,server_total_count:1,server_counts_at:new Date(),server_count_revision:'9',status_attempt_revision:'9',barrier_revision:'10'}]});
 const result=await getFreshUnreadCountSnapshot('u',async()=>{throw new Error('Synthetic STATUS failure');});
 expect(result.snapshots.a.revision).toBe('9');expect(result.recoveryBarrierRevision).toBe('10');
});
