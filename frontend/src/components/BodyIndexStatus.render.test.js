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
Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,CustomEvent:dom.window.CustomEvent});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {useStore}=await import('../store/index.js');
const {api}=await import('../utils/api.js');
const BodyIndexStatus=(await import('./BodyIndexStatus.jsx')).default;
const row={account_id:'a',account_name:'Synthetic Alice',headers_loaded:53713,bodies_searchable:54,pending:53659,failed:2,last_error:'Synthetic transient error'};
async function mount(props, searchQuery = '') {
  useStore.setState({accountsReady:true,selectedAccountId:'other',searchQuery});
  const root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(React.createElement(BodyIndexStatus,props)));
  return root;
}
test('mail screen poll is invisible even for pending coverage and API errors',async()=>{
  api.bodyIndexStatus=async()=>({accounts:[row]});
  let root=await mount({silent:true}, 'synthetic');assert.equal(document.getElementById('root').textContent,'');
  await React.act(async()=>root.unmount());
  api.bodyIndexStatus=async()=>{throw new Error('Synthetic unavailable');};
  root=await mount({silent:true}, 'synthetic');assert.equal(document.getElementById('root').textContent,'');
  await React.act(async()=>root.unmount());
});
test('search observer stays idle outside search and refreshes results when coverage grows',async()=>{
  let calls=0, updates=0;
  api.bodyIndexStatus=async()=>{calls++;return {accounts:[row]};};
  let root=await mount({silent:true});
  assert.equal(calls,0);
  await React.act(async()=>root.unmount());
  root=await mount({silent:true}, 'synthetic');
  assert.equal(calls,1);
  const onUpdate=()=>{updates++;};
  window.addEventListener('mailflow:search_index_updated',onUpdate);
  api.bodyIndexStatus=async()=>{calls++;return {accounts:[{...row,bodies_searchable:100}]};};
  await React.act(async()=>window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(calls,2);assert.equal(updates,1);
  assert.equal(document.getElementById('root').textContent,'');
  window.removeEventListener('mailflow:search_index_updated',onUpdate);
  await React.act(async()=>root.unmount());
});
