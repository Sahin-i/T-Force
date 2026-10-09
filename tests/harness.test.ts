import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response, ResponseInputItem } from 'openai/resources/responses/responses';
import { ConversationStore } from '../server/store.js';
import { AgentHarness } from '../server/agent.js';
import { config } from '../server/config.js';
import type { ModelClient } from '../server/model.js';
import type { SandboxManager } from '../server/sandbox.js';
import { HarnessError, appError } from '../server/errors.js';
import type { Run } from '../shared/types.js';
const response=(output:unknown[],status='completed')=>({id:randomUUID(),object:'response',status,output,usage:{input_tokens:10,output_tokens:5,total_tokens:15},incomplete_details:status==='incomplete'?{reason:'max_output_tokens'}:null}) as Response;
const call=(id='call_1',args='{"command":"increment"}')=>({type:'function_call',id:'fc_1',call_id:id,name:'bash',arguments:args,status:'completed'});
const reasoning={type:'reasoning',id:'rs_1',summary:[],encrypted_content:'opaque-encrypted-state'};
async function setup(t:test.TestContext,model:ModelClient,overrides:Partial<typeof config>={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const cfg={...config,workspaceDir:path.join(dir,'workspace'),stateDir:path.join(dir,'state'),...overrides};await fs.mkdir(path.join(cfg.workspaceDir,'outputs'),{recursive:true});
  const store=new ConversationStore(cfg.stateDir);await store.init();const chat=await store.create();let executions=0,disposed=0;
  const sandbox={name:'mock-container',exec:async()=>{executions++;return {stdout:'done',stderr:'',exitCode:0,truncated:false};},dispose:async()=>{disposed++;}};
  const sandboxes={readiness:async()=>({ready:true}),create:async()=>sandbox,cleanupStale:async()=>{}} as unknown as SandboxManager;
  const harness=new AgentHarness(cfg,store,sandboxes,()=>model);
  return {store,chat,harness,cfg,counts:()=>({executions,disposed})};
}
async function settled(harness:AgentHarness,store:ConversationStore,id:string){for(let i=0;i<1000;i++){const run=store.getRun(id);if(!harness.activeRun&&!['running','queued'].includes(run.status))return run;await new Promise(r=>setTimeout(r,5));}throw new Error('Run did not settle');}
test('retains encrypted provider items and call IDs across multiple rounds and disk restoration',async t=>{
  const seen:ResponseInputItem[][]=[];let n=0;
  const model:ModelClient={respond:async input=>{seen.push(structuredClone(input));n++;return n===1?response([reasoning,call()]):n===2?response([call('call_2')]):response([{type:'message',id:'msg',role:'assistant',status:'completed',content:[{type:'output_text',text:'Done',annotations:[]}]}]);}};
  const {harness,store,chat,cfg,counts}=await setup(t,model);
  const id=await harness.submit(chat.id,'do it',[]);const run=await settled(harness,store,id);
  assert.equal(run.status,'completed');assert.equal(counts().executions,2);assert.equal(counts().disposed,1);
  assert.deepEqual(seen[1][1],reasoning);assert.equal((seen[1][3] as {call_id:string}).call_id,'call_1');
  const restored=new ConversationStore(cfg.stateDir);await restored.init();assert.deepEqual(restored.get(chat.id).input,store.get(chat.id).input);assert.equal(restored.get(chat.id).chat.messages.at(-1)?.text,'Done');
  const events=restored.replay(id,0);assert.ok(events.length>4);assert.deepEqual(events.map(e=>e.id),events.map((_,i)=>i+1));assert.equal(restored.replay(id,events.at(-2)!.id).length,1);
});
test('a model failure after a completed mutation does not repeat the action',async t=>{
  let n=0;const model:ModelClient={respond:async()=>{if(++n===1)return response([call()]);throw new HarnessError('RATE_LIMIT','Rate limited');}};
  const {harness,store,chat,counts}=await setup(t,model);const id=await harness.submit(chat.id,'modify once',[]);const run=await settled(harness,store,id);
  assert.equal(run.status,'failed');assert.equal(counts().executions,1);assert.equal(run.tools[0].status,'completed');assert.equal(store.get(chat.id).input.filter(i=>i.type==='function_call_output').length,1);
});
test('incomplete model responses never execute pending tool actions',async t=>{
  const {harness,store,chat,counts}=await setup(t,{respond:async()=>response([call()],'incomplete')});const id=await harness.submit(chat.id,'do it',[]);const run=await settled(harness,store,id);
  assert.equal(run.error?.code,'MODEL_INCOMPLETE');assert.equal(counts().executions,0);assert.equal(run.tools[0].status,'interrupted');
});
test('malformed arguments become structured tool failures, allowing model recovery',async t=>{
  let n=0;let captured:ResponseInputItem[]=[];const model:ModelClient={respond:async input=>{captured=structuredClone(input);return ++n===1?response([call('bad','{"command":')]):response([]);}};
  const {harness,store,chat,counts}=await setup(t,model);const id=await harness.submit(chat.id,'do it',[]);const run=await settled(harness,store,id);
  assert.equal(run.status,'completed');assert.equal(run.tools[0].status,'failed');assert.equal(counts().executions,0);assert.match(JSON.stringify(captured),/INVALID_ARGUMENTS/);
});
test('one shared active run, stop, context limit and iteration limit are explicit',async t=>{
  const model:ModelClient={respond:async(_input,_tools,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
  const {harness,store,chat}=await setup(t,model);const id=await harness.submit(chat.id,'wait',[]);
  await assert.rejects(harness.submit(chat.id,'second',[]),{code:'BUSY'});await harness.abort(id);assert.equal(store.getRun(id).status,'stopped');
  const small=await setup(t,{respond:async()=>response([])},{maxContextBytes:100});await assert.rejects(small.harness.submit(small.chat.id,'x'.repeat(200),[]),{code:'CONTEXT_LIMIT'});assert.equal(small.store.get(small.chat.id).chat.messages.length,0);
  const limited=await setup(t,{respond:async()=>response([call()])},{maxIterations:1});const limitId=await limited.harness.submit(limited.chat.id,'loop',[]);assert.equal((await settled(limited.harness,limited.store,limitId)).error?.code,'ITERATION_LIMIT');
});
test('restart marks unfinished tools uncertain and does not execute them',async t=>{
  const {store,chat,cfg}=await setup(t,{respond:async()=>response([])});const conversation=store.get(chat.id);conversation.input.push({role:'user',content:'do it'},call() as ResponseInputItem);
  const id=randomUUID();const messageId=randomUUID();conversation.chat.messages.push({id:messageId,role:'assistant',text:'',attachments:[],tools:[],createdAt:new Date().toISOString(),runId:id,status:'running'});await store.save(conversation);
  const run:Run={id,chatId:chat.id,messageId,model:'gpt-6-luna',startedAt:new Date().toISOString(),status:'running',tools:[{id:'call_1',name:'bash',arguments:'{}',status:'running'}],usage:{inputTokens:0,outputTokens:0,totalTokens:0}};await store.addRun(run);
  const restored=new ConversationStore(cfg.stateDir);await restored.init();assert.equal(restored.getRun(id).status,'interrupted');assert.equal(restored.getRun(id).tools[0].status,'uncertain');assert.match(JSON.stringify(restored.get(chat.id).input.at(-1)),/INTERRUPTED/);
});
test('provider authentication, deployment, rate and context errors are actionable',()=>{
  assert.equal(appError({status:401}).code,'AZURE_AUTH');assert.equal(appError({status:404}).code,'MISSING_DEPLOYMENT');assert.equal(appError({status:429}).code,'RATE_LIMIT');assert.equal(appError({message:'maximum context length exceeded'}).code,'CONTEXT_LIMIT');
});

test('incomplete call status in completed responses is rejected and pending activities become interrupted',async t=>{
 const {harness,store,chat,counts}=await setup(t,{respond:async()=>response([{...call(),status:'in_progress'}])});
 const id=await harness.submit(chat.id,'unsafe partial call',[]);const run=await settled(harness,store,id);
 assert.equal(run.error?.code,'INCOMPLETE_TOOL_CALL');assert.equal(counts().executions,0);assert.equal(run.tools[0].status,'interrupted');
});
test('failed stale cleanup blocks a new run before shared workspace actions',async t=>{
 const {harness,chat}=await setup(t,{respond:async()=>response([])});
 harness.sandboxes.cleanupStale=async()=>{throw new HarnessError('SANDBOX_CLEANUP_FAILED','Cannot remove stale writer');};
 await assert.rejects(harness.submit(chat.id,'new run',[]),{code:'SANDBOX_CLEANUP_FAILED'});assert.equal(harness.activeRun,null);
});

test('run duration cancels the model, persists a clear limit and cleans its container',async t=>{
 const model:ModelClient={respond:async(_input,_tools,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
 const {harness,store,chat,counts}=await setup(t,model,{maxRunMs:25});
 const id=await harness.submit(chat.id,'wait too long',[]);const run=await settled(harness,store,id);
 assert.equal(run.error?.code,'RUN_DURATION_LIMIT');assert.equal(counts().disposed,1);assert.equal(store.get(chat.id).chat.messages.at(-1)?.status,'failed');
});
test('Docker-unavailable errors preserve the unsent message without any host action',async t=>{
 const {harness,store,chat,counts}=await setup(t,{respond:async()=>response([])});harness.sandboxes.readiness=async()=>({ready:false,error:'Docker daemon is stopped'});
 await assert.rejects(harness.submit(chat.id,'do it',[]),{code:'DOCKER_UNAVAILABLE'});assert.equal(counts().executions,0);assert.equal(store.get(chat.id).chat.messages.length,0);
});

test('application-owned completion ends after persisted successful tools and still waits for cleanup',async t=>{
 let requests=0,checks=0;const {harness,store,chat,counts}=await setup(t,{respond:async()=>{if(++requests>1)throw new HarnessError('RATE_LIMIT','A final prose request would fail.');return response([call()]);}});
 const id=await harness.submit(chat.id,'Generate a validated candidate',[],{instructions:'Application-owned authoring instructions.',completion:async()=>{checks++;const output=store.get(chat.id).input.at(-1);assert.equal(output?.type,'function_call_output');assert.equal(store.getRun(id).tools[0].status,'completed');return true;}});
 const run=await harness.waitRun(id);assert.equal(run.status,'completed');assert.equal(requests,1);assert.equal(checks,1);assert.equal(counts().executions,1);assert.equal(counts().disposed,1);assert.equal(harness.busy,false);
});

test('failed or incomplete tool batches cannot satisfy an application completion predicate',async t=>{
 let requests=0,checks=0;const failed=await setup(t,{respond:async()=>{if(++requests>1)throw new HarnessError('RATE_LIMIT','Provider failure after a failed tool.');return response([call('invalid','{"command":')]);}});
 const failedId=await failed.harness.submit(failed.chat.id,'Do not accept a partial write',[],{completion:async()=>{checks++;return true;}});const run=await failed.harness.waitRun(failedId);assert.equal(run.status,'failed');assert.equal(checks,0);assert.equal(failed.counts().executions,0);
 const incomplete=await setup(t,{respond:async()=>response([call()],'incomplete')});const incompleteId=await incomplete.harness.submit(incomplete.chat.id,'Reject incomplete batches',[],{completion:async()=>{checks++;return true;}});assert.equal((await incomplete.harness.waitRun(incompleteId)).error?.code,'MODEL_INCOMPLETE');assert.equal(checks,0);
});

test('Stop during application completion cannot import a candidate as successful',async t=>{
 let started!:()=>void,release!:()=>void;const checking=new Promise<void>(resolve=>{started=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
 const {harness,store,chat,counts}=await setup(t,{respond:async()=>response([call()])});const id=await harness.submit(chat.id,'Generate a candidate',[],{completion:async()=>{started();await gate;return true;}});
 await checking;const stopped=harness.abort(id);release();await stopped;assert.equal(store.getRun(id).status,'stopped');assert.equal(store.getRun(id).error?.code,'STOPPED');assert.equal(counts().disposed,1);assert.equal(harness.busy,false);
});

test('a repaired successful tool batch can complete after a recoverable read error without provider prose',async t=>{
 let requests=0,checks=0;const model:ModelClient={respond:async()=>{
   requests++;if(requests===1)return response([{...call('read-missing'),name:'read',arguments:'{"path":"/workspace/missing.txt","offset":null,"limit":null}'}]);
   if(requests===2)return response([call('write-candidate')]);throw new HarnessError('RATE_LIMIT','No prose request should follow the repaired candidate.');
 }};
 const {harness,store,chat,counts}=await setup(t,model);const create=harness.sandboxes.create.bind(harness.sandboxes);
 harness.sandboxes.create=async(id,signal)=>{const sandbox=await create(id,signal);const exec=sandbox.exec.bind(sandbox);sandbox.exec=async(command,options)=>command.includes('tool-helper.py read')?{stdout:JSON.stringify({ok:false,output:'',error:{code:'FILE_NOT_FOUND',message:'The optional sample was not uploaded.'}}),stderr:'',exitCode:0,truncated:false}:exec(command,options);return sandbox;};
 const id=await harness.submit(chat.id,'Recover from the missing optional sample',[],{completion:async()=>{checks++;return true;}});const run=await harness.waitRun(id);
 assert.equal(run.status,'completed');assert.equal(requests,2);assert.equal(checks,1);assert.equal(run.tools[0].status,'failed');assert.equal(run.tools[0].error?.code,'FILE_NOT_FOUND');assert.equal(run.tools[1].status,'completed');assert.equal(counts().executions,1);assert.equal(counts().disposed,1);assert.equal(store.get(chat.id).input.filter(item=>item.type==='function_call_output').length,2);
});

test('shutdown rejects new chat and exclusive work while ordinary Stop still allows a next message',async t=>{
 let requests=0,start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;});
 const live=await setup(t,{respond:async(_input,_tools,signal)=>{if(++requests===1){start();return new Promise((_resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}return response([]);}});
 const id=await live.harness.submit(live.chat.id,'Stop only this run',[]);await started;await live.harness.abort(id);assert.equal(live.harness.shuttingDown,false);
 const next=await live.harness.submit(live.chat.id,'Continue normally',[]);assert.equal((await live.harness.waitRun(next)).status,'completed');assert.equal(requests,2);
 await live.harness.shutdown();assert.equal(live.harness.shuttingDown,true);
 await assert.rejects(live.harness.submit(live.chat.id,'Do not restart while closing',[]),{code:'SHUTTING_DOWN',statusCode:503});let executed=false;
 await assert.rejects(live.harness.runExclusive('late-work','python',async()=>{executed=true;}),{code:'SHUTTING_DOWN',statusCode:503});assert.equal(executed,false);assert.equal(requests,2);
});

test('shutdown after queued persistence stops the recorded run without starting a model request or container',async t=>{
 let persisted!:()=>void,resume!:()=>void,requests=0;const saved=new Promise<void>(resolve=>{persisted=resolve;});const gate=new Promise<void>(resolve=>{resume=resolve;});
 const {harness,store,chat,counts}=await setup(t,{respond:async()=>{requests++;return response([]);}});const original=store.addRun.bind(store);
 store.addRun=async run=>{await original(run);persisted();await gate;};const pending=harness.submit(chat.id,'Preserve this queued message',[]);await saved;
 assert.equal(harness.busy,true);assert.equal(harness.activeRun,null);await harness.shutdown();resume();const id=await pending;const run=await harness.waitRun(id);
 assert.equal(run.status,'stopped');assert.equal(run.error?.code,'STOPPED');assert.equal(run.tools.length,0);assert.equal(requests,0);assert.equal(counts().executions,0);assert.equal(counts().disposed,0);assert.equal(harness.busy,false);assert.equal(store.get(chat.id).chat.messages[0].text,'Preserve this queued message');
});

test('private completion feedback repairs a no-tool response using real developer input without fabricated calls',async t=>{
 let round=0,checks=0;const seen:ResponseInputItem[][]=[];
 const {harness,store,chat,counts}=await setup(t,{respond:async input=>{seen.push(structuredClone(input));if(++round===1)return response([{type:'message',id:'first',role:'assistant',status:'completed',content:[{type:'output_text',text:'I prepared the draft.',annotations:[]}]}]);return response([call('actual-repair')]);}});
 const id=await harness.submit(chat.id,'Create the workflow',[],{completion:async()=>++checks===1?{complete:false,feedback:'Private application correction: the saved candidate requires the complete supported shape.'}:true});const run=await harness.waitRun(id);
 assert.equal(run.status,'completed');assert.equal(round,2);assert.equal(seen[1].filter(item=>'role' in item&&item.role==='developer').length,1);assert.equal(seen[1].filter(item=>item.type==='function_call_output').length,0);assert.equal(store.get(chat.id).chat.messages.filter(message=>message.role==='user').length,1);assert.equal(run.tools.length,1);assert.equal(run.tools[0].id,'actual-repair');assert.equal(counts().disposed,1);
});

test('a final-iteration no-tool repair fails explicitly and structured incomplete decisions cannot accept prose',async t=>{
 const message={type:'message',id:'done',role:'assistant',status:'completed',content:[{type:'output_text',text:'Done.',annotations:[]}]};
 const limited=await setup(t,{respond:async()=>response([message])},{maxIterations:1});const id=await limited.harness.submit(limited.chat.id,'Produce a candidate',[],{completion:async()=>({complete:false,feedback:'Private repair required.'})});const run=await limited.harness.waitRun(id);assert.equal(run.status,'failed');assert.equal(run.error?.code,'ITERATION_LIMIT');assert.equal(limited.counts().disposed,1);assert.equal(limited.harness.busy,false);
 const pending=await setup(t,{respond:async()=>response([message])});const pendingId=await pending.harness.submit(pending.chat.id,'Do not accept an incomplete candidate',[],{completion:async()=>({complete:false})});assert.equal((await pending.harness.waitRun(pendingId)).status,'failed');assert.equal(pending.harness.busy,false);
});
