import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as catalog from '../src/model-catalog.js';
import * as emulator from '../src/tool-emulator.ts';
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const context = { ...catalog, ...emulator, DurableObject: class {}, crypto, Request, Response, URL, TextEncoderStream, console, setTimeout, clearTimeout, setInterval: () => {} };
const { GeminiBridgeDO, ProtocolDecoder } = vm.runInNewContext(source.replace(/import[\s\S]*?from "[^"\n]+";/g, '').replaceAll('export class ', 'class ').replace('export default {', 'const entry = {') + '\n;({GeminiBridgeDO, ProtocolDecoder})', context);
const tool = emulator.SUPPORTED_TOOLS.terminal;
const policy = { tools: [tool], required: false, parallel: true };
const call = '<tool_call>{"name":"terminal","arguments":{"command":"pwd"}}</tool_call>';
function bridge(models = [{id:"gemini-9-pro-thinking",name:"9 Pro",thinking:true,verification:'verified',mapping_revision:'rev-1'}]) {
 const b = new GeminiBridgeDO({}, { CLIENT_API_TOKEN: 'test', BRIDGE_AUTH_TOKEN: 'bridge' });
 b.currentTokens = { sessionReady: true };
 b.replaceModelCatalog({ protocolVersion: 2, models });
 b.activeSocket = { readyState: 1, send(raw) {
   const req = JSON.parse(raw);
   const handler = b.activeStreams.get(req.requestId);
   if (req.type === 'PREPARE_MODEL') {
     handler({ type: 'MODEL_READY', requestId: req.requestId, model: req.model, mappingRevision: 'rev-1' });
     return;
   }
   const wire = JSON.stringify([['wrb.fr', null, JSON.stringify([null,null,null,null,[['choice',[call]]]])]]);
   for (const chunk of wire) handler({ type: 'STREAM_CHUNK', chunk });
   handler({ type: 'STREAM_DONE' });
 }};
 return b;
}
test('history preserves call and final result, with no inherited conversation', () => {
 const messages = [{role:'user',content:'pwd'}, {role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'terminal',arguments:'{"command":"pwd"}'}}]}, {role:'tool',tool_call_id:'c1',content:'/workspace'}];
 const req = JSON.parse(JSON.parse(ProtocolDecoder.encodeRequest(messages, {}))[1]);
 assert.match(req[0][0], /"tool_call_id":"c1"/);
 assert.match(req[0][0], /\/workspace/);
 assert.match(req[0][0], /"tool_calls"/);
 assert.equal(req[2][0], null);
});
test('multiple calls have unique IDs and preserve trailing text', () => {
 const result = emulator.parseToolCompletion(call + call + 'done', policy);
 assert.equal(result.message.tool_calls.length, 2);
 assert.notEqual(...result.message.tool_calls.map(c => c.id));
 assert.equal(result.message.content, 'done');
});
test('invalid and disallowed calls cannot execute', () => {
 for (const text of [call.replace('terminal','unknown'),call.replace('"command":"pwd"','"wrong":1'),call.replace('</tool_call>',''), '<tool_call>{}</tool_call>']) assert.throws(() => emulator.parseToolCompletion(text, policy));
 assert.throws(() => emulator.parseToolCompletion(call+call,{...policy,parallel:false}));
 assert.throws(() => emulator.parseToolCompletion('hello',{...policy,required:true}));
 assert.equal(emulator.parseToolCompletion(call,{...policy,tools:[]}).message.tool_calls, undefined);
});
test('body schema wins over legacy header and tool_choice is enforced', () => {
 const req = new Request('https://test', {headers:{'x-hermes-tools':'git'}});
 assert.equal(emulator.resolveToolPolicy(req,{tools:[tool]}).tools[0].function.name,'terminal');
 assert.equal(emulator.resolveToolPolicy(req,{tools:[tool],tool_choice:'none'}).tools.length,0);
 assert.throws(() => emulator.resolveToolPolicy(req,{tools:[tool],tool_choice:{type:'function',function:{name:'git'}}}));
});
test('RPC arbitrary boundaries survive execution', async () => {
 assert.equal(await bridge().executeThroughExtension([{role:'user',content:'pwd'}]),call);
});
test('HTTP streaming and JSON both return tool calls', async () => {
 for (const stream of [false,true]) {
  const response = await bridge().fetch(new Request('https://test/v1/chat/completions', {method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({messages:[{role:'user',content:'pwd'}],tools:[tool],stream})}));
  assert.equal(response.status,200);
  const text = await response.text();
  if (!stream) assert.equal(JSON.parse(text).choices[0].message.tool_calls[0].function.name,'terminal');
  else {
   const chunks = text.split('\n\n').filter(s=>s.startsWith('data: {')).map(s=>JSON.parse(s.slice(6)));
   assert.equal(chunks.filter(c=>c.choices[0].finish_reason !== null).length,1);
   assert.equal(chunks.at(-1).choices[0].finish_reason,'tool_calls');
   assert.match(text,/data: \[DONE\]/);
  }
 }
});
test('missing websocket credentials are rejected', async () => {
 assert.equal((await bridge().fetch(new Request('https://test/bridge'))).status,401);
});
test('Hermes roundtrip consumes tool result and ends without repeating call', async () => {
 const b = bridge();
 const request = messages => new Request('https://test/v1/chat/completions', {method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({messages,tools:[tool]})});
 const history = [{role:'user',content:'pwd'}];
 const first = await (await b.fetch(request(history))).json();
 history.push(first.choices[0].message);
 history.push({role:'tool',tool_call_id:first.choices[0].message.tool_calls[0].id,content:'/workspace'});
 b.activeSocket.send = raw => {
  const req = JSON.parse(raw);
  const handler = b.activeStreams.get(req.requestId);
  if (req.type === 'PREPARE_MODEL') {
    handler({ type: 'MODEL_READY', requestId: req.requestId, model: req.model, mappingRevision: 'rev-1' });
    return;
  }
  const encoded = JSON.parse(JSON.parse(req.payload.f_req)[1]);
  assert.match(encoded[0][0], /\/workspace/);
  assert.ok(encoded[0][0].includes(history[2].tool_call_id));
  assert.equal(encoded[2][0],null);
  handler({type:'STREAM_CHUNK',chunk:JSON.stringify([['wrb.fr',null,JSON.stringify([null,null,null,null,[['choice',['Current directory: /workspace']]]])]])});
  handler({type:'STREAM_DONE'});
 };
 const final = await (await b.fetch(request(history))).json();
 assert.equal(final.choices[0].finish_reason,'stop');
 assert.equal(final.choices[0].message.content,'Current directory: /workspace');
});
test('invalid request bodies return 400', async () => {
 const response = await bridge().fetch(new Request('https://test/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test'},body:'null'}));
 assert.equal(response.status,400);
});
test('model snapshots replace old IDs including empty discovery', async () => {
 const b = bridge();
 const get = () => b.fetch(new Request('https://test/v1/models',{headers:{Authorization:'Bearer test'}}));
 b.replaceModelCatalog({protocolVersion:2,models:[{id:'gemini-3.9-pro-thinking',name:'3.9 Pro',thinking:true,verification:'verified',mapping_revision:'rev-1'},{id:'gemini-3.10-pro-thinking',name:'3.10 Pro',thinking:true,verification:'verified',mapping_revision:'rev-1'},{id:'gemini-4-flash',name:'4 Flash',thinking:false,verification:'verified',mapping_revision:'rev-1'}]});
 let response = await get();
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 let body = await response.json();
 assert.equal(body.default_recommended,'gemini-3.10-pro-thinking');
 assert.equal(body.default_reasoning_effort,null);
 assert.equal(body.data[0].supports_reasoning_effort,false);
 assert.equal(body.data[0].id,body.default_recommended);
 const oldRevision = body.catalog_revision;
 b.replaceModelCatalog({protocolVersion:2,models:[{id:'gemini-5-pro-thinking',name:'5 Pro',thinking:true,verification:'verified',mapping_revision:'rev-2'}]});
 body = await (await get()).json();
 assert.deepEqual(body.data.map(m=>m.id),['gemini-5-pro-thinking']);
 assert.notEqual(body.catalog_revision,oldRevision);
 b.replaceModelCatalog({protocolVersion:2,models:[]});
 body = await (await get()).json();
 assert.deepEqual(body.data,[]);
 assert.equal(body.default_recommended,null);
});
test('connection reset removes model and thinking state', () => {
 const b = bridge();
 b.replaceModelCatalog({models:[{id:'old',name:'Old',thinking:true}],activeModel:'Old',extendedThinking:true});
 b.resetModelCatalog();
 assert.equal(b.dynamicModels.length,0);
 assert.equal(b.activeBrowserModel,null);
 assert.equal(b.extendedThinkingActive,false);
});
test('default requests use dynamic newest thinking model without hardcoded remapping', async () => {
 const b = bridge();
 let seen;
 b.executeThroughExtension = async (_messages,_callback,model) => {seen=model;return 'hello';};
 const response = await b.fetch(new Request('https://test/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({messages:[{role:'user',content:'hello'}],model:'gemini-3.8-flash-thinking'})}));
 assert.equal(response.status,200);
 assert.equal(seen,'gemini-9-pro-thinking');
 assert.equal((await response.json()).model,seen);
});
test('no thinking candidate means no fabricated default', () => {
 assert.equal(catalog.recommendedModel(catalog.normalizeModels([{id:'gemini-5-pro',name:'5 Pro',thinking:false} ])),null);
});

test('effort values do not change the browser request payload', async () => {
 const payloads = [];
 const b = bridge();
 const origSend = b.activeSocket.send;
 b.activeSocket.send = raw => {
   const msg = JSON.parse(raw);
   if (msg.type === 'EXECUTE_REQUEST') payloads.push(msg.payload);
   origSend(raw);
 };
 for (const reasoning_effort of ['low','high','max']) {
  const response = await b.fetch(new Request('https://test/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({messages:[{role:'user',content:'hello'}],reasoning_effort})}));
  assert.equal(response.status,200);
 }
 assert.deepEqual(payloads[0],payloads[1]);
 assert.deepEqual(payloads[1],payloads[2]);
});
