import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerConnectionRefresh, refreshConnectionData } from './connectionRefresh.js';
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent = class {};
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
test('catch-up waits for actual list, category and unread results and retains failures', async () => {
  const list=deferred(), category=deferred(), counts=deferred();
  const a=registerConnectionRefresh('messages',()=>list.promise), b=registerConnectionRefresh('categories',()=>category.promise);
  let settled=false;
  const work=refreshConnectionData(()=>true,()=>counts.promise).then(value=>{settled=true;return value;});
  counts.resolve(true);list.resolve(true);await Promise.resolve();assert.equal(settled,false);
  category.reject(new Error('Synthetic server failure'));
  await assert.rejects(work,/Synthetic server failure/);a();b();
});
test('navigation re-runs current scope; expired generations never signal success', async () => {
  const old=deferred();let oldCalls=0,newCalls=0,current=true;
  const a=registerConnectionRefresh('messages',()=>{oldCalls++;return old.promise;});
  const b=registerConnectionRefresh('categories',async()=>true);
  const work=refreshConnectionData(()=>current,async()=>true);
  const c=registerConnectionRefresh('messages',async()=>{newCalls++;return true;});
  a();old.resolve(true);assert.equal(await work,true);assert.equal(oldCalls,1);assert.equal(newCalls,1);
  const late=deferred();const d=registerConnectionRefresh('messages',()=>late.promise);
  const obsolete=refreshConnectionData(()=>current,async()=>true);current=false;late.resolve(true);
  assert.equal(await obsolete,false);c();d();b();
});
test('missing consumers and superseded results defer readiness without reporting a failed request', async () => {
  assert.equal(await refreshConnectionData(()=>true,async()=>true),false);
  const a=registerConnectionRefresh('messages',async()=>false),b=registerConnectionRefresh('categories',async()=>true);
  assert.equal(await refreshConnectionData(()=>true,async()=>true),false);a();b();
});
