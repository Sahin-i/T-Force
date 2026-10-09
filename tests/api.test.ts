import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { ConversationStore } from '../server/store.js';
import { AgentHarness } from '../server/agent.js';
import type { SandboxManager } from '../server/sandbox.js';
import type { Response } from 'openai/resources/responses/responses';
import type { RunEvent } from '../shared/types.js';
async function setup(t:test.TestContext){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'office-api-'));const cfg={...config,workspaceDir:path.join(dir,'workspace'),stateDir:path.join(dir,'state')};
  const store=new ConversationStore(cfg.stateDir);
  const sandbox={name:'test-container',dispose:async()=>{},exec:async()=>({stdout:'ok',stderr:'',exitCode:0,truncated:false})};
  const sandboxes={readiness:async()=>({ready:true}),create:async()=>sandbox,cleanupStale:async()=>{}} as unknown as SandboxManager;
  const harness=new AgentHarness(cfg,store,sandboxes,()=>({respond:async(_input,_tools,signal,emit)=>{await emit({type:'response.output_text.delta',delta:'Hello',sequence_number:1,item_id:'msg',output_index:0,content_index:0,logprobs:[]});await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,80);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});return {id:'res',status:'completed',output:[{type:'message',id:'msg',role:'assistant',status:'completed',content:[{type:'output_text',text:'Hello',annotations:[]}]}],usage:{input_tokens:2,output_tokens:1,total_tokens:3}} as unknown as Response;}}));
  const {app}=await createApp(cfg,{store,sandboxes,harness,skipRecovery:true});t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
  return {app,store,harness,cfg};
}
test('API supports persistent chats, validated submission, restoration, and safe origins',async t=>{
  const {app,store,harness}=await setup(t);
  assert.equal((await app.inject({method:'POST',url:'/api/chats',headers:{origin:'https://evil.example'}})).statusCode,403);
  assert.equal((await app.inject({method:'GET',url:'/api/chats',headers:{host:'evil.example'}})).statusCode,403);
  const chat=(await app.inject({method:'POST',url:'/api/chats',payload:{}})).json();
  assert.equal((await app.inject('/api/chats')).json().length,1);
  assert.equal((await app.inject({method:'POST',url:`/api/chats/${chat.id}/messages`,payload:{text:'Hello',attachments:[{path:'uploads/incomplete/file.csv',name:'file.csv',size:1,mime:'text/csv'}]}})).statusCode,400);
  const accepted=await app.inject({method:'POST',url:`/api/chats/${chat.id}/messages`,payload:{text:'Hello',attachments:[]}});assert.equal(accepted.statusCode,202);
  const id=accepted.json().runId;assert.equal((await app.inject({method:'POST',url:`/api/chats/${chat.id}/messages`,payload:{text:'again',attachments:[]}})).statusCode,409);
  for(let i=0;i<100&&harness.activeRun;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(store.getRun(id).status,'completed');assert.equal((await app.inject(`/api/chats/${chat.id}`)).json().messages.at(-1).text,'Hello');
  const replay=await app.inject(`/api/runs/${id}/events?after=0`);assert.match(replay.headers['content-type'] as string,/text\/event-stream/);assert.match(replay.body,/id: 1/);assert.match(replay.body,/"delta":"Hello"/);
  const after=store.replay(id,0).at(-2)!.id;const missed=await app.inject(`/api/runs/${id}/events?after=${after}`);assert.equal((missed.body.match(/event: run/g)||[]).length,1);assert.match(missed.body,/completed/);
  assert.equal((await app.inject(`/api/runs/${id}/events?after=-1`)).statusCode,400);
});
test('SSE reconnect replays missed IDs without submitting another run',async t=>{
  const {app,store,harness,cfg}=await setup(t);const address=await app.listen({host:'127.0.0.1',port:0});
  const chat=await store.create();const id=await harness.submit(chat.id,'stream',[]);
  const first=await fetch(`${address}/api/runs/${id}/events`);const reader=first.body!.getReader();let partial='';
  for(let i=0;i<10&&!partial.includes('"delta":"Hello"');i++){const chunk=await reader.read();partial+=new TextDecoder().decode(chunk.value);}
  await reader.cancel();const ids=[...partial.matchAll(/id: (\d+)/g)].map(match=>Number(match[1]));const last=ids.at(-1)||0;
  for(let i=0;i<100&&harness.activeRun;i++)await new Promise(r=>setTimeout(r,10));
  const restored=await fetch(`${address}/api/runs/${id}/events`,{headers:{'Last-Event-ID':String(last)}});const replay=await restored.text();
  const events=replay.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)) as RunEvent);
  assert.ok(events.length>0);assert.ok(events.every(event=>event.id>last));assert.equal(events.at(-1)!.data.status,'completed');assert.equal(store.allRuns().length,1);
  const reopened=new ConversationStore(cfg.stateDir);await reopened.init();assert.equal(reopened.get(chat.id).chat.messages.at(-1)?.text,'Hello');
});
