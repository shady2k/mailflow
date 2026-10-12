import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js')) return { format: 'module', shortCircuit: true, source: 'export const useTranslation=()=>({t:(k,d)=>typeof d=== "string"?d:k}); export const initReactI18next={type:"3rdParty",init(){}};' };
  if (url.endsWith('.json')) return {format:'module',shortCircuit:true,source:`export default ${readFileSync(new URL(url),'utf8')}`};
  if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url),'utf8'), { transforms:['jsx'],jsxRuntime:'automatic' }).code };
  return nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url:'http://localhost:18089', pretendToBeVisual:true });
Object.assign(globalThis, {window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,
  requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window)});
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { useInboxNavigation } = await import('../hooks/useInboxNavigation.js');
const { isSinglePaneLayout } = await import('../layouts.js');
const InboxPanels = (await import('./InboxPanels.jsx')).default;
const InboxRowContent = (await import('./InboxRowContent.jsx')).default;

function Mailbox() {
  const state = useStore();
  const singlePane = isSinglePaneLayout(state.layout, false);
  useInboxNavigation(singlePane);
  return React.createElement(InboxPanels, { singlePane, selectedMessageId:state.selectedMessageId,onBack:()=>state.setSelectedMessage(null),
    list:React.createElement('div',{'data-mailflow-list-scroll':true,tabIndex:0},
      React.createElement('input',{value:state.searchQuery,onChange:()=>{}}),
      React.createElement('button',{onClick:()=>state.setSelectedMessage('synthetic-message')},'Open')),
    reader:React.createElement('div',null,'Synthetic reader'),divider:React.createElement('span',null,'Divider') });
}
const nextPop = () => new Promise(resolve => window.addEventListener('popstate',resolve,{once:true}));
test('list → message → back/forward keeps the mounted list, search, scroll and focus; layout switch retains it', async () => {
  useStore.setState({layout:'inbox',selectedMessageId:null,selectedAccountId:'a',selectedFolder:'Archive',searchQuery:'BodyToken'});
  const root=createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>root.render(React.createElement(Mailbox)));
    const list=document.querySelector('[data-mailflow-list-scroll]');list.scrollTop=456;
    const before=window.history.length;
    await React.act(async()=>document.querySelector('button').click());
    assert.equal(document.querySelector('[data-inbox-panel="list"]').style.display,'none');
    assert.equal(document.querySelector('[data-inbox-panel="reader"]').style.display,'flex');
    assert.equal(window.history.length,before+1);
    await React.act(async()=>{ const pop=nextPop(); document.querySelector('[data-inbox-panel="reader"] button').click();await pop; });
    assert.equal(useStore.getState().selectedMessageId,null);
    assert.equal(useStore.getState().searchQuery,'BodyToken');
    assert.equal(document.querySelector('[data-mailflow-list-scroll]'),list);
    await React.act(async()=>new Promise(resolve=>window.requestAnimationFrame(resolve)));
    assert.equal(list.scrollTop,456);
    assert.equal(document.activeElement,list);
    await React.act(async()=>{const pop=nextPop();window.history.forward();await pop;});
    assert.equal(useStore.getState().selectedMessageId,'synthetic-message');
    await React.act(async()=>{const pop=nextPop();window.history.back();await pop;});
    assert.equal(useStore.getState().selectedMessageId,null);
    await React.act(async()=>useStore.setState({layout:'compact'}));
    assert.equal(document.querySelector('[data-inbox-panel="list"]').style.display,'contents');
    assert.equal(document.querySelector('[data-mailflow-list-scroll]'),list);
    await React.act(async()=>useStore.setState({layout:'inbox'}));
    assert.equal(document.querySelector('[data-mailflow-list-scroll]'),list);
  } finally {await React.act(async()=>root.unmount());}
});
test('dense row selection and starring do not open the message', async () => {
  let selected=0,starred=0,opened=0;
  const root=createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>root.render(React.createElement('div',{onClick:()=>opened++},React.createElement(InboxRowContent,{
      message:{id:'m',from_name:'Иван',subject:'Спасибо',snippet:'Body preview',date:'2026-10-11',is_starred:false},unread:true,checked:false,showPreview:true,
      onToggleSelect:()=>selected++,onStar:()=>starred++,
    }))));
    await React.act(async()=>{document.querySelector('input[type="checkbox"]').click();document.querySelector('button').click();});
    assert.equal(selected,1);assert.equal(starred,1);assert.equal(opened,0);
    assert.ok(document.querySelector('[data-inbox-row]').textContent.includes('Спасибо'));
    await React.act(async()=>document.querySelector('[data-inbox-row]').click());
    assert.equal(opened,1);
  } finally {await React.act(async()=>root.unmount());}
});
test('Inbox preview has a separate ellipsized line only when enabled and nonempty', async () => {
  const root=createRoot(document.getElementById('root'));
  const message={id:'m',from_name:'Synthetic Sender',subject:'Long Subject '.repeat(80),snippet:'Long Preview '.repeat(100),date:'2026-10-11'};
  const render=async(showPreview, snippet=message.snippet)=>React.act(async()=>root.render(React.createElement(InboxRowContent,{message:{...message,snippet},unread:true,checked:false,showPreview,onStar:()=>{},onToggleSelect:()=>{}})));
  try {
    await render(true);
    const subject=document.querySelector('[data-inbox-subject]'),preview=document.querySelector('[data-inbox-snippet]');
    assert.equal(subject.textContent,message.subject);assert.equal(preview.textContent,message.snippet);
    assert.equal(subject.style.display,'block');assert.equal(preview.style.display,'block');
    assert.equal(subject.style.textOverflow,'ellipsis');assert.equal(preview.style.textOverflow,'ellipsis');
    assert.equal(document.querySelector('[data-inbox-row]').style.fontWeight,'600');
    await render(false);assert.equal(document.querySelector('[data-inbox-snippet]'),null);
    await render(true,'');assert.equal(document.querySelector('[data-inbox-snippet]'),null);
  } finally {await React.act(async()=>root.unmount());}
});
