import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../extension-cloudflare/content.js', import.meta.url), 'utf8');
test('extension loads settings, discovers current labels, and resets catalog on reconnect', async () => {
 let labels = ['Fast', 'Thinking', 'Pro'];
 const messages = [], sockets = [], timers = [], handlers = {};
 const node = text => ({innerText:text, textContent:text, style:{}, classList:{contains:()=>false}, getAttribute:()=>null, querySelector:()=>null, addEventListener(){}, remove(){}});
 const document = {querySelectorAll:()=>labels.map(node), createElement:()=>node(''), body:{appendChild(){}}, head:{appendChild(){}}, addEventListener:(name,fn)=>{handlers[name]=fn;}};
 const window = {addEventListener:(name,fn)=>{handlers['window:'+name]=fn;},postMessage(){}};
 class WebSocket {
  static OPEN=1; static CONNECTING=0;
  readyState=0;
  constructor(url){this.url=url;sockets.push(this);}
  send(raw){messages.push(JSON.parse(raw));}
  close(){this.readyState=3;this.onclose({code:1000});}
 }
 vm.runInNewContext(source,{console:{log(){},warn(){},error(){}},URL,Map,Array,Boolean,document,window,WebSocket,
  setTimeout:(fn)=>{timers.push(fn);return timers.length;},clearTimeout(){},
  chrome:{runtime:{getURL:p=>p}, storage:{sync:{get:async()=>({workerUrl:'https://example.test',bridgeToken:'test-token'})},onChanged:{addListener(){}}}}});
 await Promise.resolve();
 handlers['window:message']({source:window,data:{source:'GEMINI_INJECTED',type:'TOKENS_EXTRACTED',payload:{at:'test'}}});
 sockets[0].readyState=1;sockets[0].onopen();
 assert.equal(new URL(sockets[0].url).host,'example.test');
 assert.equal(new URL(sockets[0].url).searchParams.get('token'),'test-token');
 const ready=messages.find(m=>m.type==='SESSION_READY');
 assert.deepEqual(Array.from(ready.models,m=>m.id),['gemini-fast','gemini-thinking','gemini-pro']);
 assert.equal(ready.models.find(m=>m.id==='gemini-thinking').thinking,true);
 labels=[];sockets[0].close();timers.at(-1)();
 sockets[1].readyState=1;sockets[1].onopen();
 assert.equal(messages.filter(m=>m.type==='SESSION_READY').at(-1).models.length,0);
});
