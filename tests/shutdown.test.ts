import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentHarness } from '../server/agent.js';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { acquireApplicationLock } from '../server/lock.js';
import type { ModelClient } from '../server/model.js';
import type { SandboxManager } from '../server/sandbox.js';
import { closeApplication } from '../server/shutdown.js';
import { ConversationStore } from '../server/store.js';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(fulfill=>{resolve=fulfill;});return {promise,resolve};}

test('shutdown cancels an active SSE run before waiting for connections and retains its lock through container cleanup', {timeout:10000}, async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'shutdown-regression-'));
  const cfg={...config,workspaceDir:path.join(directory,'workspace'),stateDir:path.join(directory,'state'),maxRunMs:600000};
  const release=await acquireApplicationLock(cfg.stateDir);const store=new ConversationStore(cfg.stateDir);
  const modelStarted=deferred();const disposalStarted=deferred();const allowDisposal=deferred();let disposed=0;
  const model:ModelClient={respond:async(_input,_tools,signal,emit)=>{
    await emit({type:'response.output_text.delta',delta:'Waiting for shutdown.',sequence_number:1,item_id:'message',output_index:0,content_index:0,logprobs:[]});modelStarted.resolve();
    return new Promise((_resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  }};
  const sandboxes={readiness:async()=>({ready:true}),cleanupStale:async()=>{},create:async()=>({name:'delayed-cleanup-container',exec:async()=>({stdout:'',stderr:'',exitCode:0,truncated:false}),dispose:async()=>{disposalStarted.resolve();await allowDisposal.promise;disposed++;}})} as unknown as SandboxManager;
  const harness=new AgentHarness(cfg,store,sandboxes,()=>model);const {app,workflowStore}=await createApp(cfg,{store,sandboxes,harness,skipRecovery:true});
  let closing:Promise<void>|undefined;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  t.after(async()=>{allowDisposal.resolve();if(closing)await closing.catch(()=>{});else await closeApplication(app,release).catch(()=>{});await reader?.cancel().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const address=await app.listen({host:'127.0.0.1',port:0});const chat=await store.create();const id=await harness.submit(chat.id,'Stay active until stopped.',[]);await modelStarted.promise;
  const response=await fetch(`${address}/api/runs/${id}/events`);reader=response.body!.getReader();let text='';
  while(!text.includes('Waiting for shutdown.')){const chunk=await reader.read();assert.equal(chunk.done,false);text+=new TextDecoder().decode(chunk.value);}
  let finished=false;closing=closeApplication(app,release).then(()=>{finished=true;});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([disposalStarted.promise,new Promise<void>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('preClose failed to cancel the active SSE run.')),2000);})]);}finally{clearTimeout(timer);}
  assert.equal(finished,false);assert.equal(harness.busy,true);assert.equal(disposed,0);
  await assert.rejects(acquireApplicationLock(cfg.stateDir),{code:'APP_ALREADY_RUNNING'});
  allowDisposal.resolve();await closing;
  for(;;){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}
  assert.match(text,/"status":"stopped"/);assert.equal(store.getRun(id).status,'stopped');assert.equal(disposed,1);assert.equal(harness.busy,false);assert.throws(()=>workflowStore.queues(),/not open|closed/i);
  const second=await acquireApplicationLock(cfg.stateDir);await second();
});

test('startup teardown closes the created application before releasing the lock and preserves its close error',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'shutdown-startup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const release=await acquireApplicationLock(directory);const started=deferred();const allow=deferred();const failure=new Error('Application startup teardown failed.');
  const closing=closeApplication({close:async()=>{started.resolve();await allow.promise;throw failure;}},release);
  await started.promise;await assert.rejects(acquireApplicationLock(directory),{code:'APP_ALREADY_RUNNING'});allow.resolve();await assert.rejects(closing,error=>error===failure);
  const second=await acquireApplicationLock(directory);await second();
});

test('shutdown also awaits submissions admitted before preClose that are still preparing a run', {timeout:10000}, async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'shutdown-preparing-'));const cfg={...config,workspaceDir:path.join(directory,'workspace'),stateDir:path.join(directory,'state'),maxRunMs:600000};
  const release=await acquireApplicationLock(cfg.stateDir);const store=new ConversationStore(cfg.stateDir);const readinessStarted=deferred();const allowReadiness=deferred();let disposed=0,created=0,modelRequests=0;
  const sandboxes={readiness:async()=>{readinessStarted.resolve();await allowReadiness.promise;return {ready:true};},cleanupStale:async()=>{},create:async()=>{created++;return {name:'preparing-container',exec:async()=>({stdout:'',stderr:'',exitCode:0,truncated:false}),dispose:async()=>{disposed++;}};}} as unknown as SandboxManager;
  const model:ModelClient={respond:async(_input,_tools,signal)=>{modelRequests++;return new Promise((_resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}};
  const harness=new AgentHarness(cfg,store,sandboxes,()=>model);const {app}=await createApp(cfg,{store,sandboxes,harness,skipRecovery:true});let closing:Promise<void>|undefined;const preClosed=deferred();app.addHook('preClose',async()=>{preClosed.resolve();});
  t.after(async()=>{allowReadiness.resolve();await harness.shutdown();if(closing)await closing.catch(()=>{});else await closeApplication(app,release).catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const address=await app.listen({host:'127.0.0.1',port:0});const chat=await store.create();
  const sending=fetch(`${address}/api/chats/${chat.id}/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Start the admitted run.',attachments:[]})});
  await readinessStarted.promise;assert.equal(harness.busy,true);assert.equal(harness.activeRun,null);
  closing=closeApplication(app,release);await preClosed.promise;allowReadiness.resolve();const rejected=await sending;assert.equal(rejected.status,503);assert.equal((await rejected.json() as {code:string}).code,'SHUTTING_DOWN');app.server.closeIdleConnections();await closing;
  assert.equal(harness.busy,false,'An admitted request must finish preparation before the application lock is released.');assert.equal(harness.shuttingDown,true);assert.equal(store.allRuns().length,0);assert.equal(created,0);assert.equal(modelRequests,0);assert.equal(disposed,0);
  const second=await acquireApplicationLock(cfg.stateDir);await second();
});
