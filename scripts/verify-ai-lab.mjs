import assert from 'node:assert/strict';
assert.equal(process.env.DB_HOST, 'postgres'); assert.equal(process.env.APP_URL, 'http://localhost:18090');
let cookies = '';
async function api(path, data, method = data ? 'POST' : 'GET') {
  const response = await fetch('http://localhost:3000/api/'+path, { method, headers: { 'Content-Type':'application/json','X-Requested-With':'MailFlow',Origin:'http://localhost:18090',Cookie:cookies }, body: data ? JSON.stringify(data) : undefined });
  if(response.headers.getSetCookie().length) cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const result=await response.json();assert(response.ok,JSON.stringify(result));return result;
}
await api('auth/login',{username:'demo',password:'DemoMail123!'});
assert((await api('accounts')).every(a=>a.email_address.endsWith('@lab.test')));
const original=await api('admin/ai');
assert(!original.config || original.config.apiKeyConfig?.baseUrl==='http://127.0.0.1:3801/v1','Refusing to replace non-synthetic AI config');
const config={enabled:true,provider:'api-key',apiKeyConfig:{baseUrl:'http://127.0.0.1:3801/v1',model:'synthetic-model',apiKey:'public-synthetic-ai-key',headers:[{name:'x-opencode-session',value:'{session_id}'},{name:'x-static',value:'public-synthetic-value'}]}};
await api('admin/ai/test',config);assert.deepEqual(await api('admin/ai'),original);
const saved=await api('admin/ai',config,'PATCH');assert(saved.config.apiKeyConfig.headers.every(h=>h.value==='••••••••'));
await api('admin/ai',saved.config,'PATCH');assert.deepEqual((await api('admin/ai')).config,saved.config);
const {summarizeMessage}=await import('/app/src/services/summarize.js');const {aiClassifyMessage}=await import('/app/src/services/categorizer.js');const {streamChat}=await import('/app/src/services/aiProvider.js');
assert.equal(await summarizeMessage({subject:'Synthetic',content:'Synthetic body'}),'Synthetic summary');
assert.equal(await aiClassifyMessage('Synthetic','sender@lab.test','Synthetic preview'),'primary');
for(const task of ['compose','action']){let text='';for await(const chunk of streamChat([{role:'user',content:'Synthetic '+task}]))text+=chunk;assert.equal(text,'Synthetic response');}
const {query,pool}=await import('/app/src/services/db.js');
const stored=JSON.parse((await query("SELECT value FROM system_settings WHERE key='ai_config'")).rows[0].value);
assert(stored.apiKeyConfig.headers.every(h=>h.value.startsWith('enc:v1:')));assert(!JSON.stringify(stored).includes('public-synthetic-value'));
const records=await(await fetch('http://127.0.0.1:3801/stats')).json();
assert(records.every(r=>r.staticValue==='public-synthetic-value' && /^[0-9a-f-]{36}$/.test(r.sessionId)));
assert.equal(new Set(records.slice(-4).map(r=>r.sessionId)).size,4);
console.log(JSON.stringify({unsavedConnectionTest:'passed',savedEncryptedRedactedReload:'passed',composeActionsSummaryClassification:'passed',distinctTaskIDs:'passed',requests:records.length},null,2));
await pool.end();
