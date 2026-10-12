import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js')) return { format:'module',shortCircuit:true,source:'export const useTranslation=()=>({t:(k,d,o)=> typeof d === "string" ? d.replace(/{{(\\w+)}}/g,(_,x)=>o?.[x] ?? "") : k}); export const initReactI18next={type:"3rdParty",init(){}};' };
  if (url.endsWith('.json')) return {format:'module',shortCircuit:true,source:`export default ${readFileSync(new URL(url),'utf8')}`};
  if (url.endsWith('.jsx')) return {format:'module',shortCircuit:true,source:transform(readFileSync(new URL(url),'utf8'),{transforms:['jsx'],jsxRuntime:'automatic'}).code};
  return nextLoad(url,context);
} });
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:18089',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {useStore}=await import('../store/index.js');
const {api}=await import('../utils/api.js');
const BodyIndexStatus=(await import('./BodyIndexStatus.jsx')).default;
const row={account_id:'a',account_name:'Synthetic Alice',headers_loaded:53713,bodies_searchable:54,pending:53659,failed:2,last_error:'Synthetic transient error'};
async function mount(props) {
  useStore.setState({accountsReady:true,selectedAccountId:'other'});
  const root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(React.createElement(BodyIndexStatus,props)));
  return root;
}
test('mail screen poll is invisible even for pending coverage and API errors',async()=>{
  api.bodyIndexStatus=async()=>({accounts:[row]});
  let root=await mount({silent:true});assert.equal(document.getElementById('root').textContent,'');
  await React.act(async()=>root.unmount());
  api.bodyIndexStatus=async()=>{throw new Error('Synthetic unavailable');};
  root=await mount({silent:true});assert.equal(document.getElementById('root').textContent,'');
  await React.act(async()=>root.unmount());
});
test('account settings show scoped persisted coverage/errors and reload read-only status',async()=>{
  let calls=0;
  api.bodyIndexStatus=async()=>{calls++;return {accounts:[row,{...row,account_id:'b',account_name:'Hidden Bob'}]};};
  let root=await mount({accountId:'a',detailed:true});
  assert.match(document.body.textContent,/54\/53713/);assert.match(document.body.textContent,/Pending: 53659/);
  assert.match(document.body.textContent,/Synthetic transient error/);assert.doesNotMatch(document.body.textContent,/Hidden Bob/);
  await React.act(async()=>document.querySelector('button').click());assert.equal(calls,2);
  await React.act(async()=>root.unmount());
  api.bodyIndexStatus=async()=>({accounts:[{...row,bodies_searchable:100,pending:53613,failed:0,last_error:null}]});
  root=await mount({accountId:'a',detailed:true});assert.match(document.body.textContent,/100\/53713/);assert.doesNotMatch(document.body.textContent,/transient error/);
  await React.act(async()=>root.unmount());
});
