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
const AiHeadersEditor=(await import('./AiHeadersEditor.jsx')).default;
let lastHeaders;
function Harness({ initial }) {
  const [headers,setHeaders]=React.useState(initial);
  return React.createElement(AiHeadersEditor,{headers,inputStyle:{},onChange:next=>{lastHeaders=next;setHeaders(next);}});
}
test('native header table starts with one row, adds/removes rows and hides saved values',async()=>{
  const root=createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>root.render(React.createElement(Harness,{initial:undefined})));
    assert.equal(document.querySelectorAll('tbody tr').length,1);
    await React.act(async()=>document.querySelectorAll('button')[1].click());
    assert.equal(document.querySelectorAll('tbody tr').length,2);
    await React.act(async()=>document.querySelector('tbody button').click());
    assert.equal(document.querySelectorAll('tbody tr').length,1);
    assert.equal(lastHeaders.length,1);
    await React.act(async()=>root.unmount());
  } finally { if(document.getElementById('root').children.length) await React.act(async()=>root.unmount()); }
  const saved=createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>saved.render(React.createElement(Harness,{initial:[{name:'x-private',value:'••••••••'}]})));
    const value=document.querySelector('input[type=password]');assert.equal(value.value,'');
    assert.equal(value.placeholder,'admin.ai.headerStored');
    assert.equal(document.querySelector('input').value,'x-private');
  } finally {await React.act(async()=>saved.unmount());}
});
