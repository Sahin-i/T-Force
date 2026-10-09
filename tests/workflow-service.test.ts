import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Response, ResponseInputItem } from 'openai/resources/responses/responses';
import type { Attachment } from '../shared/types.js';
import type { CaseEvent, PublishedWorkflow, TaskResult, WorkflowPackage } from '../shared/workflow-types.js';
import { AgentHarness } from '../server/agent.js';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { HarnessError, appError } from '../server/errors.js';
import type { ModelClient } from '../server/model.js';
import type { SandboxLayout, SandboxManager } from '../server/sandbox.js';
import { ConversationStore } from '../server/store.js';
import { WorkflowStore } from '../server/workflow-store.js';
import { verifyTaskCompletion, type TaskExecutionRequest } from '../server/workflow-runtime.js';

const response=(output:unknown[]):Response=>({id:randomUUID(),status:'completed',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}} as Response);
const usage=()=>({inputTokens:0,outputTokens:0,totalTokens:0});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(fulfill=>{resolve=fulfill;});return {promise,resolve};}
function packageFixture(threshold=1):WorkflowPackage {
  return {schemaVersion:1,name:'Employee review procedure',slug:'employee-review',purpose:'Validate an uploaded item and require employee approval.',inputs:[{key:'item',label:'Item',kind:'json',required:true}],references:[{path:'references/policy.txt',title:'Synthetic policy',fictional:true}],rules:[{id:'minimum',text:`Quantity must be at least ${threshold}.`,source:'references/policy.txt'}],deliverables:['Review file'],exceptions:['Missing evidence becomes a question'],approval:'Employee approval binds the verified revision.',questions:[],assumptions:[],synthetic:true,assets:{'scripts/check.py':`MINIMUM_QUANTITY = ${threshold}\n# Generated validation procedure\n`,'references/policy.txt':`Fictional demonstration policy: minimum ${threshold}.`},steps:[{id:'check',type:'python',title:'Validate item',instructions:'Read actual inputs and report findings.',inputs:['inputs','references'],script:'scripts/check.py',outputSchema:{type:'object',properties:{businessKey:{type:'string'},disposition:{type:'string',enum:['ready','blocked','clarification','escalated']},findings:{type:'array'},queueRecord:{type:'object'}},required:['businessKey','disposition','findings','queueRecord'],additionalProperties:false},artifacts:[{path:'review.txt',label:'Review',required:true}]},{id:'review',type:'review',title:'Employee review',instructions:'Inspect verified files before approving.',inputs:['check'],outputSchema:{type:'object'},artifacts:[]},{id:'queue',type:'queue',title:'Accounting queue',instructions:'Commit once after explicit review.',inputs:['check'],outputSchema:{type:'object'},artifacts:[],destination:'accounting',businessKeyPath:'check.businessKey',recordPath:'check.queueRecord'}]};
}

async function setup(t:test.TestContext){
  const directory=await mkdtemp(path.join(os.tmpdir(),'workflow-service-'));
  const cfg={...config,workspaceDir:path.join(directory,'workspace'),stateDir:path.join(directory,'state')};
  const chats=new ConversationStore(cfg.stateDir);
  const state={candidate:packageFixture() as unknown,layouts:[] as SandboxLayout[],modelRequests:0,authorInstructions:'',authorResponse:undefined as undefined|((input:ResponseInputItem[],round:number)=>Response),executions:0,onExecute:undefined as undefined|((request:TaskExecutionRequest,signal:AbortSignal)=>Promise<void>),onDispose:undefined as undefined|(()=>Promise<void>),cleanups:0,failAfterWrite:false,disposition:'ready',cleanupFinished:true};
  const sandboxes={readiness:async()=>({ready:true}),cleanupStale:async()=>{},createIsolated:async(_id:string,_signal:AbortSignal,layout:SandboxLayout)=>{
    state.layouts.push(layout);
    return {name:'isolated-author-fixture',exec:async()=>{await writeFile(path.join(layout.outputDir,'package.json'),JSON.stringify(state.candidate));return {stdout:'Created package candidate.',stderr:'',exitCode:0,truncated:false};},dispose:async()=>{state.cleanups++;await state.onDispose?.();}};
  }} as unknown as SandboxManager;
  const harness=new AgentHarness(cfg,chats,sandboxes,()=>{
    let round=0;const model:ModelClient={respond:async(input,_tools,_signal,_onEvent,_onRetry,instructions)=>{
      state.modelRequests++;state.authorInstructions=instructions!;assert.match(instructions!,/workflow/i);round++;
      if(state.authorResponse)return state.authorResponse(input,round);
      if(state.failAfterWrite&&round>1)throw new HarnessError('RATE_LIMIT','The unnecessary final prose request would be rate limited.');
      return round===1?response([{type:'function_call',id:randomUUID(),call_id:randomUUID(),name:'bash',arguments:'{"command":"write authorized fixture candidate","timeoutMs":null}',status:'completed'}]):response([{type:'message',id:randomUUID(),role:'assistant',status:'completed',content:[{type:'output_text',text:'Updated the executable validation rule and its cited policy.',annotations:[]}]}]);
    }};return model;
  });
  const {app,workflows,workflowStore}=await createApp(cfg,{store:chats,sandboxes,harness,skipRecovery:true});
  workflows.runtime.executeTask=async(request,signal):Promise<TaskResult>=>{
    state.executions++;const startedAt=new Date().toISOString();
    try{
      assert.equal(request.slotHeld,true);assert.ok(signal);
      await state.onExecute?.(request,signal!);signal?.throwIfAborted();
      const context=JSON.parse(await readFile(path.join(request.inputDir,'context.json'),'utf8')) as {inputData:Record<string,unknown>};
      const businessKey=String(context.inputData.businessKey??'invoice-one');const amount=Number(context.inputData.amount??560);
      const result={businessKey,disposition:state.disposition,findings:state.disposition==='ready'?[]:[{code:'EXCESS',message:'Submitted quantity exceeds evidence.'}],queueRecord:{businessKey,amount,currency:'AZN'}};
      await mkdir(request.outputDir,{recursive:true});await writeFile(path.join(request.outputDir,'review.txt'),`Verified ${businessKey}: AZN ${amount}, ${state.disposition}.`);
      await writeFile(path.join(request.outputDir,'manifest.json'),JSON.stringify({stepId:request.step.id,result,artifacts:[{path:'review.txt'}]}));
      if(!state.cleanupFinished)return {stepId:request.step.id,status:'uncertain',startedAt,finishedAt:new Date().toISOString(),usage:usage(),artifacts:[],cleanupFinished:false,error:{code:'SANDBOX_CLEANUP_FAILED',message:'Fixture cleanup failed.'}};
      const verified=await verifyTaskCompletion(request);
      return {stepId:request.step.id,status:'completed',startedAt,finishedAt:new Date().toISOString(),usage:usage(),artifacts:verified.artifacts,result:verified.result,cleanupFinished:true};
    }catch(error){return {stepId:request.step.id,status:'failed',startedAt,finishedAt:new Date().toISOString(),usage:usage(),artifacts:[],cleanupFinished:true,error:appError(error)};}
  };
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const upload=async(name:string,data:string):Promise<Attachment>=>{
    const boundary=`test-${randomUUID()}`;const payload=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${data}\r\n--${boundary}--\r\n`);
    const result=await app.inject({method:'POST',url:'/api/files/upload',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload});assert.equal(result.statusCode,200,result.body);return result.json<{files:Attachment[]}>().files[0];
  };
  const waitCase=async(caseId:string)=>{for(let i=0;i<1000;i++){const c=workflowStore.getCase(caseId);if(c.status!=='running'&&!harness.busy)return c;await new Promise(resolve=>setTimeout(resolve,2));}throw new Error('Case fixture did not settle');};
  const author=async(draftId?:string,attachments:Attachment[]=[])=>{
    const draft=draftId?workflowStore.getDraft(draftId):await workflows.createDraft('Employee procedure');
    const accepted=await app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/messages`,payload:{text:draft.revisions.length?'Require two items and update the executable check.':'Check items against the supplied fictional policy.',attachments}});
    assert.equal(accepted.statusCode,202,accepted.body);await harness.waitRun(accepted.json().runId);
    for(let i=0;i<1000;i++){const current=workflowStore.getDraft(draft.id);if(current.status!=='authoring')return current;await new Promise(resolve=>setTimeout(resolve,2));}throw new Error('Authoring fixture did not settle');
  };
  const publish=async():Promise<PublishedWorkflow>=>{
    const draft=await author();assert.equal(draft.status,'idle',JSON.stringify(draft.error));const revision=draft.revisions.at(-1)!;
    const tested=await workflows.test(draft.id,revision.id,{businessKey:'sample',amount:560},[],[{path:'check.disposition',operator:'eq',value:'ready'}]);await waitCase(tested.caseId);
    for(let i=0;i<1000;i++){if(workflowStore.getDraft(draft.id).revisions.at(-1)!.testReports.at(-1)!.executionStatus!=='running')break;await new Promise(resolve=>setTimeout(resolve,2));}
    return workflows.publish(draft.id,revision.id,true,'Test Employee');
  };
  return {app,workflows,workflowStore,harness,state,cfg,upload,waitCase,author,publish};
}

test('conversational authoring, specified assertions, publication, refinement, cloning and reload preserve exact versions',async t=>{
  const f=await setup(t);const version=await f.publish();
  assert.equal(version.provenance.length,2);assert.equal(version.testReport.assertionsPassed,true);assert.equal(version.testReport.packageHash,version.packageHash);
  assert.equal(f.state.layouts[0].mounts[0].readOnly,true);assert.ok(!f.state.layouts[0].mounts.some(m=>m.source===f.cfg.stateDir));
  const exported=await f.app.inject(`/api/workflows/${version.id}/export`);assert.equal(exported.json().packageHash,version.packageHash);assert.equal(exported.json().synthetic,true);
  f.state.candidate=packageFixture(2);const updated=await f.author(version.draftId);
  assert.equal(updated.revisions.length,2);assert.notEqual(updated.revisions[0].packageHash,updated.revisions[1].packageHash);assert.match(updated.revisions[1].package.assets['scripts/check.py'],/= 2/);
  assert.throws(()=>f.workflows.publish(updated.id,updated.revisions[1].id,true,'Employee'),{code:'TEST_REQUIRED'});
  assert.throws(()=>f.workflows.publish(updated.id,updated.revisions[0].id,true,'Employee'),{code:'STALE_REVISION'});
  assert.deepEqual(f.workflowStore.getVersion(version.id),version);
  const cloned=await f.workflows.clone(version.id);assert.equal(cloned.clonedFrom,version.id);assert.deepEqual(cloned.revisions[0].package,version.package);assert.equal(cloned.revisions[0].testReports.length,0);
  const restored=new WorkflowStore(f.cfg.stateDir);await restored.init();t.after(()=>restored.close());assert.deepEqual(restored.getVersion(version.id),version);assert.equal(restored.getDraft(updated.id).revisions.length,2);
});

test('invalid authoring candidates preserve the valid draft and unresolved policy questions prevent publishing',async t=>{
  const f=await setup(t);const draft=await f.author();const hash=draft.revisions[0].packageHash;
  f.state.candidate={...packageFixture(),assets:{'../escape.py':'unsafe'}};
  const rejected=await f.author(draft.id);assert.equal(rejected.status,'failed');assert.equal(rejected.revisions.length,1);assert.equal(rejected.revisions[0].packageHash,hash);assert.ok(rejected.candidateDiagnostics?.length);
  const questioned=packageFixture();questioned.questions=['Which policy supplies the quantity limit?'];f.state.candidate=questioned;
  const updated=await f.author(draft.id);assert.equal(updated.status,'idle');assert.throws(()=>f.workflows.publish(updated.id,updated.revisions.at(-1)!.id,true,'Employee'),{code:'POLICY_QUESTIONS'});
  const malformed=await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/test`,payload:{revisionId:updated.revisions.at(-1)!.id,inputData:{},attachments:[],assertions:[{path:'check.disposition',operator:'invented'}]}});assert.equal(malformed.statusCode,400);
});

test('executed successfully and passed assertions remain separate publication requirements',async t=>{
  const f=await setup(t);const draft=await f.author();const revision=draft.revisions[0];
  const tested=await f.workflows.test(draft.id,revision.id,{},[],[{path:'check.queueRecord.amount',operator:'eq',value:999}]);await f.waitCase(tested.caseId);
  const report=f.workflowStore.getDraft(draft.id).revisions[0].testReports[0];assert.equal(report.executionStatus,'completed');assert.equal(report.assertionsPassed,false);assert.equal(report.assertionResults[0].actual,560);
  assert.throws(()=>f.workflows.publish(draft.id,revision.id,true,'Employee'),{code:'TEST_REQUIRED'});
});

test('premature approval, cleanup failure and rejection cannot create queue entries',async t=>{
  const f=await setup(t);const version=await f.publish();const gate=deferred();const started=deferred();
  f.state.onExecute=async()=>{started.resolve();await gate.promise;};
  const c=await f.workflows.startPublished(version.id,{},[]);await started.promise;
  const premature=await f.app.inject({method:'POST',url:`/api/cases/${c.id}/approve`,payload:{revisionId:c.revisions[0].id,resultHash:'a'.repeat(64),approvedBy:'Employee'}});assert.equal(premature.statusCode,409);assert.equal(f.workflowStore.queues().length,0);
  gate.resolve();const ready=await f.waitCase(c.id);f.workflows.reject(c.id,ready.revisions[0].id,'Need another employee check.');
  await assert.rejects(f.workflows.approve(c.id,ready.revisions[0].id,ready.revisions[0].resultHash!,'Employee'),{code:'APPROVAL_NOT_READY'});assert.equal(f.workflowStore.queues().length,0);
  f.state.onExecute=undefined;f.state.cleanupFinished=false;const failed=await f.workflows.startPublished(version.id,{businessKey:'cleanup-case'},[]);const settled=await f.waitCase(failed.id);assert.equal(settled.status,'failed');assert.equal(settled.revisions[0].cleanupFinished,false);assert.equal(settled.revisions[0].tasks[0].status,'uncertain');
});

test('approval binds source and artifact fingerprints and protected downloads reject tampering',async t=>{
  const f=await setup(t);const version=await f.publish();const source=await f.upload('invoice.txt','invoice content');
  const c=await f.workflows.startPublished(version.id,{},[source]);const ready=await f.waitCase(c.id);const revision=ready.revisions[0];const artifact=revision.artifacts[0];
  const served=await f.app.inject(artifact.downloadUrl);assert.equal(served.statusCode,200);assert.match(served.body,/AZN 560/);assert.equal(served.headers['x-content-type-options'],'nosniff');
  await writeFile(path.join(f.cfg.workspaceDir,source.path),'invoice changed');
  await assert.rejects(f.workflows.approve(c.id,revision.id,revision.resultHash!,'Employee'),{code:'SOURCE_CHANGED'});
  await writeFile(path.join(f.cfg.workspaceDir,source.path),'invoice content');
  const {root}=f.workflows.artifact(c.id,revision.id,artifact.id);await chmod(path.join(root,artifact.path),0o600);await writeFile(path.join(root,artifact.path),'tampered');
  assert.equal((await f.app.inject(artifact.downloadUrl)).statusCode,409);await assert.rejects(f.workflows.approve(c.id,revision.id,revision.resultHash!,'Employee'),{code:'ARTIFACT_CHANGED'});assert.equal(f.workflowStore.queues().length,0);
  assert.equal((await f.app.inject(`/api/cases/${c.id}/revisions/${revision.id}/artifacts/${randomUUID()}/download`)).statusCode,404);
});

test('concurrent and repeated approvals, duplicate submissions and changed committed records enforce one immutable queue row',async t=>{
  const f=await setup(t);const version=await f.publish();const first=await f.workflows.startPublished(version.id,{businessKey:'invoice-001',amount:560},[]);const ready=await f.waitCase(first.id);const r=ready.revisions[0];
  const [one,two]=await Promise.all([f.workflows.approve(first.id,r.id,r.resultHash!,'Employee One'),f.workflows.approve(first.id,r.id,r.resultHash!,'Employee Two')]);assert.equal(one.id,two.id);assert.equal(f.workflowStore.queues().length,1);
  assert.equal((await f.workflows.approve(first.id,r.id,r.resultHash!,'Employee Three')).id,one.id);
  const duplicate=await f.workflows.startPublished(version.id,{businessKey:'invoice-001',amount:560},[]);const again=await f.waitCase(duplicate.id);const second=await f.workflows.approve(again.id,again.revisions[0].id,again.revisions[0].resultHash!,'Employee');assert.equal(second.duplicate,true);assert.equal(second.queueRecordId,one.queueRecordId);assert.equal(f.workflowStore.queues().length,1);
  const changed=await f.workflows.startPublished(version.id,{businessKey:'invoice-001',amount:600},[]);const conflict=await f.waitCase(changed.id);await assert.rejects(f.workflows.approve(changed.id,conflict.revisions[0].id,conflict.revisions[0].resultHash!,'Employee'),{code:'QUEUE_CONFLICT'});
  assert.equal(f.workflowStore.getCase(changed.id).status,'conflict');assert.equal(f.workflowStore.queues()[0].record.amount,560);assert.equal(f.workflowStore.queues().length,1);
});

test('corrections preserve historical findings and artifacts, replace matching input names and invalidate pending approval',async t=>{
  const f=await setup(t);const version=await f.publish();const original=await f.upload('invoice.txt','ten routers');const policy=await f.upload('policy.txt','reference policy');f.state.disposition='blocked';
  const c=await f.workflows.startPublished(version.id,{businessKey:'corrected-invoice',amount:700},[original,policy]);const blocked=await f.waitCase(c.id);const old=structuredClone(blocked.revisions[0]);assert.equal(blocked.status,'blocked');assert.equal(old.findings[0].code,'EXCESS');
  const replacement=await f.upload('invoice.txt','eight routers');f.state.disposition='ready';const corrected=await f.workflows.correct(c.id,old.id,{amount:560},[replacement],'Correct the quantity.');const ready=await f.waitCase(corrected.id);
  assert.equal(ready.revisions.length,2);assert.deepEqual(ready.revisions[0],old);assert.equal(ready.revisions[1].sources.filter(s=>s.kind==='input').length,2);assert.equal(ready.revisions[1].sources.find(s=>s.name==='invoice.txt')!.originalPath,replacement.path);assert.equal(ready.revisions[1].sources.find(s=>s.name==='policy.txt')!.originalPath,policy.path);assert.equal(ready.revisions[1].reviewStatus,'pending');
  await assert.rejects(f.workflows.approve(c.id,old.id,old.resultHash!,'Employee'),{code:'STALE_REVISION'});
  const pending=structuredClone(ready.revisions[1]);await f.workflows.correct(c.id,pending.id,{amount:560},[]);const latest=await f.waitCase(c.id);assert.equal(latest.revisions[1].reviewStatus,'invalidated');assert.equal(latest.revisions[1].artifacts[0].hash,pending.artifacts[0].hash);
  const receipt=await f.workflows.approve(c.id,latest.revisions[2].id,latest.revisions[2].resultHash!,'Employee');assert.equal(receipt.revisionId,latest.revisions[2].id);assert.equal(f.workflowStore.queues().length,1);
});

test('generic multi-task pipelines receive frozen preceding artifacts and fresh readonly context without special workflow code',async t=>{
  const f=await setup(t);const pkg=packageFixture();const second={...structuredClone(pkg.steps[0]),id:'finalize',title:'Inspect prior review',inputs:['check'],script:'scripts/finalize.py'};pkg.assets['scripts/finalize.py']='# second task';pkg.steps.splice(1,0,second);pkg.steps.at(-1)!.businessKeyPath='finalize.businessKey';pkg.steps.at(-1)!.recordPath='finalize.queueRecord';f.state.candidate=pkg;
  let observed=false;f.state.onExecute=async request=>{if(request.step.id==='finalize'){const context=JSON.parse(await readFile(path.join(request.inputDir,'context.json'),'utf8'));assert.equal(context.preceding.check.disposition,'ready');assert.match(await readFile(path.join(request.precedingDir,'check','review.txt'),'utf8'),/AZN 560/);observed=true;}};
  const version=await f.publish();assert.equal(observed,true);assert.equal(version.testReport.executionStatus,'completed');
});

test('restart recovery retains completed artifacts, marks only unfinished tasks uncertain and cannot repeat queue mutations',async t=>{
  const f=await setup(t);const version=await f.publish();const started=await f.workflows.startPublished(version.id,{businessKey:'restart-item'},[]);const ready=await f.waitCase(started.id);const r=ready.revisions[0];await f.workflows.approve(ready.id,r.id,r.resultHash!,'Employee');
  const recovering=structuredClone(f.workflowStore.getCase(ready.id));recovering.id=randomUUID();recovering.status='running';recovering.approvals=[];recovering.revisions[0].id=randomUUID();recovering.revisions[0].executionStatus='running';recovering.revisions[0].tasks.push({stepId:'unfinished',status:'running',startedAt:new Date().toISOString(),artifacts:[],usage:usage(),cleanupFinished:false});f.workflowStore.saveCase(recovering);
  const executions=f.state.executions;const restored=new WorkflowStore(f.cfg.stateDir);await restored.init();const interrupted=restored.getCase(recovering.id);assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.revisions[0].tasks[0].status,'completed');assert.equal(interrupted.revisions[0].tasks[1].status,'uncertain');assert.deepEqual(interrupted.revisions[0].artifacts,r.artifacts);assert.equal(restored.queues().length,1);assert.equal(f.state.executions,executions);
  const eventCount=restored.replay(recovering.id,0).length;restored.close();const again=new WorkflowStore(f.cfg.stateDir);await again.init();t.after(()=>again.close());assert.equal(again.replay(recovering.id,0).length,eventCount);assert.equal(again.queues().length,1);
});

test('case SSE restores missed IDs and closes for a future cursor without rerunning work',async t=>{
  const f=await setup(t);const version=await f.publish();const first=await f.workflows.startPublished(version.id,{},[]);const ready=await f.waitCase(first.id);const executions=f.state.executions;
  const all=f.workflowStore.replay(ready.id,0);const after=all[1].id;const replay=await f.app.inject(`/api/cases/${ready.id}/events?after=${after}`);const events=replay.body.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)) as CaseEvent);assert.ok(events.length);assert.ok(events.every(event=>event.id>after));assert.equal(f.state.executions,executions);
  const gate=deferred();const started=deferred();f.state.onExecute=async()=>{started.resolve();await gate.promise;};const running=await f.workflows.startPublished(version.id,{businessKey:'future-cursor'},[]);await started.promise;
  const subscribed=deferred();const originalSubscribe=f.workflowStore.subscribe.bind(f.workflowStore);f.workflowStore.subscribe=(id,listener)=>{const unsubscribe=originalSubscribe(id,listener);subscribed.resolve();return unsubscribe;};
  const stream=f.app.inject(`/api/cases/${running.id}/events?after=1000`);await subscribed.promise;gate.resolve();const result=await stream;assert.equal(result.body,': connected\n\n');await f.waitCase(running.id);
  assert.equal((await f.app.inject(`/api/cases/${ready.id}/events?after=-1`)).statusCode,400);
});

test('SSE replay from a prior correction does not terminate the active revision stream',async t=>{
  const f=await setup(t);const version=await f.publish();const first=await f.workflows.startPublished(version.id,{},[]);const ready=await f.waitCase(first.id);const priorRevision=ready.revisions[0].id;
  const gate=deferred();const started=deferred();f.state.onExecute=async()=>{started.resolve();await gate.promise;};await f.workflows.correct(ready.id,priorRevision,{amount:560},[]);await started.promise;
  const subscribed=deferred();const originalSubscribe=f.workflowStore.subscribe.bind(f.workflowStore);f.workflowStore.subscribe=(id,listener)=>{const unsubscribe=originalSubscribe(id,listener);subscribed.resolve();return unsubscribe;};
  const stream=f.app.inject(`/api/cases/${ready.id}/events?after=0`);await subscribed.promise;gate.resolve();const result=await stream;const events=result.body.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)) as CaseEvent);const latest=await f.waitCase(ready.id);assert.ok(events.some(event=>event.revisionId===latest.revisions[1].id&&event.type==='status'&&event.data.status==='awaiting_review'));assert.equal(latest.revisions.length,2);
});

test('Stop releases the shared slot after cleanup and never permits approval or starts another task',async t=>{
  const f=await setup(t);const version=await f.publish();const started=deferred();
  f.state.onExecute=async(_request,signal)=>{started.resolve();await new Promise<void>((_resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});};
  const c=await f.workflows.startPublished(version.id,{businessKey:'stopped-case'},[]);await started.promise;const executions=f.state.executions;
  const response=await f.app.inject({method:'POST',url:`/api/cases/${c.id}/stop`});assert.equal(response.statusCode,200);const stopped=await f.waitCase(c.id);
  assert.equal(stopped.status,'stopped');assert.equal(stopped.revisions[0].executionStatus,'stopped');assert.equal(stopped.revisions[0].cleanupFinished,true);assert.equal(stopped.revisions[0].tasks[0].status,'failed');assert.equal(stopped.revisions[0].tasks[0].error?.code,'STOPPED');assert.equal(f.harness.busy,false);assert.equal(f.state.executions,executions);assert.equal(f.workflowStore.queues().length,0);
  assert.equal((await f.app.inject({method:'POST',url:`/api/cases/${c.id}/approve`,payload:{revisionId:stopped.revisions[0].id,resultHash:'a'.repeat(64),approvedBy:'Employee'}})).statusCode,409);
});

test('authoring conversations cannot be listed, read or executed through ordinary chat routes',async t=>{
  const f=await setup(t);const draft=await f.author();const general=await f.harness.store.create();
  const chats=(await f.app.inject('/api/chats')).json<{id:string}[]>();assert.ok(chats.some(chat=>chat.id===general.id));assert.ok(!chats.some(chat=>chat.id===draft.chatId));
  assert.equal((await f.app.inject(`/api/chats/${draft.chatId}`)).statusCode,403);const requests=f.state.modelRequests;
  assert.equal((await f.app.inject({method:'POST',url:`/api/chats/${draft.chatId}/messages`,payload:{text:'Use the general networked workspace.',attachments:[]}})).statusCode,403);assert.equal(f.state.modelRequests,requests);
});

test('approval replays schemas and recomputes reviewed hashes instead of trusting mutable metadata flags',async t=>{
  const f=await setup(t);const version=await f.publish();
  const mutations:[string,(c:ReturnType<typeof f.workflowStore.getCase>)=>void,string][]=[
    ['record',c=>{c.revisions[0].tasks[0].result!.queueRecord={amount:999,businessKey:'record',currency:'AZN'};},'RESULT_CHANGED'],
    ['schema',c=>{delete c.revisions[0].tasks[0].result!.businessKey;},'INVALID_TASK_RESULT'],
    ['uncertain',c=>{c.revisions[0].tasks[0].status='uncertain';},'APPROVAL_NOT_READY'],
    ['cleanup',c=>{c.revisions[0].tasks[0].cleanupFinished=false;},'APPROVAL_NOT_READY'],
    ['input',c=>{c.revisions[0].inputData.amount=999;},'RESULT_CHANGED'],
    ['findings',c=>{c.revisions[0].findings=[{code:'ALTERED',message:'Changed displayed findings.'}];},'RESULT_CHANGED'],
  ];
  for(const [key,mutate,errorCode] of mutations){const started=await f.workflows.startPublished(version.id,{businessKey:key,amount:560},[]);const ready=await f.waitCase(started.id);const hash=ready.revisions[0].resultHash!;const changed=structuredClone(ready);mutate(changed);f.workflowStore.saveCase(changed);await assert.rejects(f.workflows.approve(ready.id,ready.revisions[0].id,hash,'Employee'),{code:errorCode});}
  assert.equal(f.workflowStore.queues().length,0);
});

test('a valid authoring package completes without provider prose and imports only after container cleanup',async t=>{
  const f=await setup(t);f.state.failAfterWrite=true;const disposing=deferred();const release=deferred();f.state.onDispose=async()=>{disposing.resolve();await release.promise;};
  const draft=await f.workflows.createDraft();const accepted=await f.workflows.author(draft.id,'Create the procedure from supplied policy.',[]);await disposing.promise;
  assert.equal(f.state.modelRequests,1);assert.equal(f.workflowStore.getDraft(draft.id).revisions.length,0);assert.equal(f.workflowStore.getDraft(draft.id).status,'authoring');assert.equal(f.harness.busy,true);
  release.resolve();const run=await f.harness.waitRun(accepted.runId);assert.equal(run.status,'completed');
  for(let i=0;i<1000&&f.workflowStore.getDraft(draft.id).status==='authoring';i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(f.workflowStore.getDraft(draft.id).status,'idle');assert.equal(f.workflowStore.getDraft(draft.id).revisions.length,1);assert.equal(f.state.modelRequests,1);assert.equal(f.state.cleanups,1);assert.equal(f.harness.busy,false);
});

test('each revision records immutable policy reference fingerprints and approval rejects changed reference files',async t=>{
  const f=await setup(t);let observed=false;
  f.state.onExecute=async request=>{const context=JSON.parse(await readFile(path.join(request.inputDir,'context.json'),'utf8')) as {sources:{kind:string;path:string}[]};const ref=context.sources.find(s=>s.kind==='reference');assert.equal(ref?.path,'/workspace/references/references/policy.txt');observed=true;};
  const version=await f.publish();const started=await f.workflows.startPublished(version.id,{businessKey:'reference-case'},[]);const ready=await f.waitCase(started.id);const revision=ready.revisions[0];
  const reference=revision.sources.find(source=>source.kind==='reference')!;assert.equal(observed,true);assert.equal(reference.originalPath,'references/policy.txt');assert.equal(reference.hash,createHash('sha256').update(version.package.assets[reference.originalPath]).digest('hex'));assert.equal(reference.size,Buffer.byteLength(version.package.assets[reference.originalPath]));
  const {root}=f.workflows.artifact(ready.id,revision.id,revision.artifacts[0].id);const filename=path.join(path.dirname(path.dirname(root)),'references',reference.originalPath);await chmod(filename,0o600);await writeFile(filename,'Altered policy after execution.');
  await assert.rejects(f.workflows.approve(ready.id,revision.id,revision.resultHash!,'Employee'),{code:'SOURCE_CHANGED'});assert.equal(f.workflowStore.queues().length,0);
  await f.workflows.correct(ready.id,revision.id,{amount:560},[]);const corrected=await f.waitCase(ready.id);assert.equal(corrected.revisions[1].sources.filter(source=>source.kind==='reference').length,1);const receipt=await f.workflows.approve(ready.id,corrected.revisions[1].id,corrected.revisions[1].resultHash!,'Employee');assert.ok(receipt.sourceHashes.includes(reference.hash));assert.equal(f.workflowStore.queues().length,1);
});

test('archive and restore hide workflows by default while preserving immutable versions, private author chats and business history',async t=>{
  const f=await setup(t);const version=await f.publish();const started=await f.workflows.startPublished(version.id,{businessKey:'archive-history'},[]);const ready=await f.waitCase(started.id);
  const archived=await f.app.inject({method:'POST',url:`/api/workflows/${version.id}/archive`,payload:{archived:true}});assert.equal(archived.statusCode,200);assert.ok(archived.json().archivedAt);
  assert.equal((await f.app.inject('/api/workflows')).json().length,0);assert.equal((await f.app.inject('/api/workflows?includeArchived=true')).json().length,1);
  const {archivedAt,...retained}=f.workflowStore.getVersion(version.id);assert.ok(archivedAt);assert.deepEqual(retained,version);assert.deepEqual((await f.app.inject(`/api/workflows/${version.id}/export`)).json().package,version.package);
  assert.equal((await f.app.inject({method:'POST',url:'/api/cases',payload:{workflowVersionId:version.id}})).statusCode,409);
  assert.equal((await f.app.inject(`/api/cases/${ready.id}`)).statusCode,200);assert.equal((await f.app.inject(ready.revisions[0].artifacts[0].downloadUrl)).statusCode,200);assert.equal((await f.app.inject('/api/cases')).json().length,1);assert.ok((await f.app.inject('/api/cases?includeTests=true')).json().length>1);
  const receipt=await f.workflows.approve(ready.id,ready.revisions[0].id,ready.revisions[0].resultHash!,'Employee');assert.ok(receipt.queueRecordId);assert.equal(f.workflowStore.queues().length,1);
  const draftArchive=await f.app.inject({method:'POST',url:`/api/workflow-drafts/${version.draftId}/archive`,payload:{}});assert.equal(draftArchive.statusCode,200);const draft=draftArchive.json();assert.ok(draft.archivedAt);
  assert.equal((await f.app.inject('/api/workflow-drafts')).json().length,0);assert.equal((await f.app.inject('/api/workflow-drafts?includeArchived=true')).json().length,1);assert.equal((await f.app.inject(`/api/chats/${draft.chatId}`)).statusCode,403);assert.equal((await f.app.inject('/api/chats')).json().length,0);
  assert.equal((await f.app.inject({method:'POST',url:`/api/chats/${draft.chatId}/messages`,payload:{text:'Use a general chat.',attachments:[]}})).statusCode,403);
  await assert.rejects(f.workflows.author(draft.id,'Change the procedure.',[]),{code:'ARCHIVED'});await assert.rejects(f.workflows.test(draft.id,version.revisionId),{code:'ARCHIVED'});assert.throws(()=>f.workflows.publish(draft.id,version.revisionId,true,'Employee'),{code:'ARCHIVED'});
  const restored=new WorkflowStore(f.cfg.stateDir);await restored.init();t.after(()=>restored.close());assert.ok(restored.getVersion(version.id).archivedAt);assert.ok(restored.getDraft(draft.id).archivedAt);assert.equal(restored.versions().length,0);assert.equal(restored.drafts().length,0);assert.equal(restored.queues().length,1);assert.equal(restored.getCase(ready.id).status,'completed');
  const draftRestore=await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/archive`,payload:{archived:false}});assert.equal(draftRestore.statusCode,200);assert.equal(draftRestore.json().archivedAt,undefined);
  const next=f.workflows.publish(draft.id,version.revisionId,true,'Employee');assert.equal(next.version,2,'Archived versions must still reserve their version number.');assert.equal(f.workflowStore.versions().length,1);
  const versionRestore=await f.app.inject({method:'POST',url:`/api/workflows/${version.id}/archive`,payload:{archived:false}});assert.equal(versionRestore.statusCode,200);assert.deepEqual(versionRestore.json(),version);assert.equal(f.workflowStore.versions().length,2);assert.equal(f.workflowStore.queues().length,1);
});

test('draft archive is blocked during preparation and container cleanup without changing archive state',async t=>{
  const f=await setup(t);const draft=await f.workflows.createDraft();const preparing=deferred();const allow=deferred();f.harness.sandboxes.readiness=async()=>{preparing.resolve();await allow.promise;return {ready:true};};
  const pending=f.workflows.author(draft.id,'Check invoice and purchase order.',[]);await preparing.promise;
  try{const result=await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/archive`,payload:{archived:true}});assert.equal(result.statusCode,409);assert.equal(result.json().code,'BUSY');assert.equal(f.workflowStore.getDraft(draft.id).archivedAt,undefined);}finally{allow.resolve();}
  const {runId}=await pending;await f.harness.waitRun(runId);for(let i=0;i<1000&&f.workflowStore.getDraft(draft.id).status==='authoring';i++)await new Promise(resolve=>setTimeout(resolve,2));
  const disposal=deferred();const release=deferred();f.state.onDispose=async()=>{disposal.resolve();await release.promise;};const accepted=await f.workflows.author(draft.id,'Keep the same business checks.',[]);await disposal.promise;
  try{assert.equal((await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/archive`,payload:{archived:true}})).statusCode,409);}finally{release.resolve();}
  await f.harness.waitRun(accepted.runId);for(let i=0;i<1000&&f.workflowStore.getDraft(draft.id).status==='authoring';i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal((await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/archive`,payload:{archived:true}})).statusCode,200);
});

test('trying a workflow reuses current sample uploads without JSON assertions and still requires explicit employee review',async t=>{
  const f=await setup(t);const oldInvoice=await f.upload('invoice.txt','Ten routers.');const order=await f.upload('order.txt','Eight routers ordered.');const template=await f.upload('procedure-template.json',JSON.stringify(packageFixture()));const records=await f.upload('records.json','{"supplier":"Demo supplier"}');
  const first=await f.author(undefined,[oldInvoice,order,template,records]);const replacement=await f.upload('invoice.txt','Eight routers.');f.state.candidate=packageFixture(2);const draft=await f.author(first.id,[replacement]);const revision=draft.revisions.at(-1)!;
  assert.match(f.state.authorInstructions,/Never ask the employee to specify scripts, schemas/);assert.match(f.state.authorInstructions,/Never hardcode a sample invoice number/);assert.match(f.state.authorInstructions,/one execution task, one short readable review document/);assert.doesNotMatch(revision.changeSummary,/manifest|schema|scripts\//i);
  const attempted=await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/test`,payload:{revisionId:revision.id}});assert.equal(attempted.statusCode,202,attempted.body);const sample=await f.waitCase(attempted.json().caseId);const sources=sample.revisions[0].sources.filter(source=>source.kind==='input');
  assert.deepEqual(new Set(sources.map(source=>source.name)),new Set(['invoice.txt','order.txt','records.json']));assert.equal(sources.find(source=>source.name==='invoice.txt')!.originalPath,replacement.path);assert.ok(!sources.some(source=>source.originalPath===oldInvoice.path||source.originalPath===template.path));
  const report=f.workflowStore.getDraft(draft.id).revisions.at(-1)!.testReports.at(-1)!;assert.equal(report.executionStatus,'completed');assert.equal(report.assertionsPassed,null);assert.deepEqual(report.assertions,[]);assert.deepEqual(report.assertionResults,[]);
  assert.throws(()=>f.workflows.publish(draft.id,revision.id,false,'Employee'),{code:'REVIEW_REQUIRED'});const published=f.workflows.publish(draft.id,revision.id,true,'Employee');assert.equal(published.packageHash,revision.packageHash);assert.equal(published.testReport.assertionsPassed,null);
  const empty=await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/test`,payload:{revisionId:revision.id,attachments:[]}});const noFiles=await f.waitCase(empty.json().caseId);assert.equal(noFiles.revisions[0].sources.filter(source=>source.kind==='input').length,0);
  const explicit=await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/test`,payload:{revisionId:revision.id,attachments:[oldInvoice]}});const selected=await f.waitCase(explicit.json().caseId);assert.deepEqual(selected.revisions[0].sources.filter(source=>source.kind==='input').map(source=>source.originalPath),[oldInvoice.path]);
});

test('an invalid generated package is repaired privately in the same author turn and imported only after cleanup',async t=>{
  const f=await setup(t);const invalid=structuredClone(packageFixture()) as unknown as {steps:Record<string,unknown>[]};invalid.steps[0].outputSchema={type:'object',properties:{amount:{type:['number','null']}}};delete invalid.steps[1].outputSchema;delete invalid.steps[1].artifacts;delete invalid.steps[2].outputSchema;delete invalid.steps[2].artifacts;
  const tool=()=>response([{type:'function_call',id:randomUUID(),call_id:randomUUID(),name:'bash',arguments:'{"command":"write workflow candidate","timeoutMs":null}',status:'completed'}]);
  f.state.authorResponse=(input,round)=>{if(round===1){f.state.candidate=invalid;return tool();}if(round===2){const feedback=input.filter(item=>'role' in item&&item.role==='developer');assert.equal(feedback.length,1);const text=JSON.stringify(feedback[0]);assert.match(text,/steps\.0\.outputSchema\.properties\.amount\.type/);assert.match(text,/Every step requires outputSchema and artifacts/);f.state.candidate=packageFixture();return tool();}throw new Error('No extra provider prose should be needed.');};
  const invoice=await f.upload('invoice.txt','Invoice heading with a purchase order reference.');const order=await f.upload('order.txt','Purchase order heading.');const draft=await f.workflows.createDraft();const disposing=deferred();const release=deferred();f.state.onDispose=async()=>{disposing.resolve();await release.promise;};
  const accepted=await f.workflows.author(draft.id,'Compare each invoice with its purchase order. Check quantities and prices. Write a short report. After my approval put it on the local payment list.',[invoice,order]);await disposing.promise;
  try{assert.equal(f.workflowStore.getDraft(draft.id).revisions.length,0);assert.equal(f.state.modelRequests,2);const context=JSON.parse(await readFile(path.join(f.state.layouts[0].mounts[0].source,'context.json'),'utf8'));assert.equal(context.sources.length,2);assert.ok(context.sources.every((source:{path:string})=>source.path.startsWith('/workspace/inputs/files/')));}finally{release.resolve();}
  await f.harness.waitRun(accepted.runId);for(let i=0;i<1000&&f.workflowStore.getDraft(draft.id).status==='authoring';i++)await new Promise(resolve=>setTimeout(resolve,2));
  const repaired=f.workflowStore.getDraft(draft.id);assert.equal(repaired.status,'idle');assert.equal(repaired.revisions.length,1);assert.equal(repaired.messages.filter(message=>message.role==='user').length,1);assert.equal(repaired.candidateDiagnostics,undefined);assert.equal(f.state.cleanups,1);
  const conversation=f.harness.store.get(draft.chatId);assert.equal(conversation.chat.messages.filter(message=>message.role==='user').length,1);assert.equal(conversation.input.filter(item=>'role' in item&&item.role==='developer').length,1);assert.equal(conversation.input.filter(item=>item.type==='function_call').length,2);assert.equal(conversation.input.filter(item=>item.type==='function_call_output').length,2);assert.ok(conversation.chat.messages.every(message=>!message.text.includes('Validation diagnostics')));
  assert.match(f.state.authorInstructions,/Review and queue use outputSchema/);assert.match(f.state.authorInstructions,/Identify document roles from their filename and main document heading/);assert.match(f.state.authorInstructions,/Parse complete finite Decimal numbers/);assert.match(f.state.authorInstructions,/honor that destination/);assert.match(f.state.authorInstructions,/dry-run its extraction\/comparison against the actual uploaded sample files/);
});

test('private repairs are bounded to three distinct candidate hashes and preserve the previous valid draft',async t=>{
  const f=await setup(t);const draft=await f.author();const previous=draft.revisions[0].packageHash;const before=f.state.modelRequests;
  f.state.authorResponse=(input,round)=>{const candidate=packageFixture();(candidate as unknown as {name:string;steps:Record<string,unknown>[]}).name=`Invalid candidate ${round}`;delete (candidate.steps[1] as unknown as Record<string,unknown>).outputSchema;f.state.candidate=candidate;assert.equal(input.filter(item=>'role' in item&&item.role==='developer').length,round-1);return response([{type:'function_call',id:randomUUID(),call_id:randomUUID(),name:'bash',arguments:'{"command":"attempt a full candidate repair","timeoutMs":null}',status:'completed'}]);};
  const failed=await f.author(draft.id);assert.equal(failed.status,'failed');assert.equal(failed.error?.code,'AUTHORING_REPAIR_LIMIT');assert.equal(failed.error?.message,'T-force could not finish this draft. Try again or clarify the instructions.');assert.match(failed.error?.details??'',/outputSchema/);assert.equal(failed.revisions.length,1);assert.equal(failed.revisions[0].packageHash,previous);assert.equal(f.state.modelRequests-before,4);assert.equal(f.harness.store.get(draft.chatId).input.filter(item=>'role' in item&&item.role==='developer').length,3);assert.ok(failed.candidateDiagnostics?.some(value=>value.includes('outputSchema')));
});

test('unchanged invalid candidates receive feedback once and final prose cannot accept them',async t=>{
  const f=await setup(t);const invalid=packageFixture();delete (invalid.steps[1] as unknown as Record<string,unknown>).artifacts;f.state.candidate=invalid;
  f.state.authorResponse=(_input,round)=>round===1?response([{type:'function_call',id:randomUUID(),call_id:randomUUID(),name:'bash',arguments:'{"command":"write invalid candidate","timeoutMs":null}',status:'completed'}]):response([{type:'message',id:randomUUID(),role:'assistant',status:'completed',content:[{type:'output_text',text:'The workflow is ready.',annotations:[]}]}]);
  const draft=await f.author();assert.equal(draft.status,'failed');assert.equal(draft.revisions.length,0);assert.equal(draft.error?.code,'AUTHORING_REPAIR_LIMIT');assert.equal(f.state.modelRequests,2);assert.equal(f.harness.store.get(draft.chatId).input.filter(item=>'role' in item&&item.role==='developer').length,1);assert.equal(f.state.cleanups,1);
});

test('simultaneous case starts reject the losing request before persisting a ghost case',async t=>{
  const f=await setup(t);const version=await f.publish();const gate=deferred();const started=deferred();
  f.state.onExecute=async()=>{started.resolve();await gate.promise;};
  const before=f.workflowStore.cases().length;
  const requests=await Promise.allSettled([
    f.workflows.startPublished(version.id,{businessKey:'first'},[]),
    f.workflows.startPublished(version.id,{businessKey:'second'},[]),
  ]);
  await started.promise;
  try {
    assert.equal(requests.filter(result=>result.status==='fulfilled').length,1);
    const rejected=requests.find(result=>result.status==='rejected');assert.ok(rejected&&rejected.status==='rejected');assert.equal(rejected.reason.code,'BUSY');
    assert.equal(f.workflowStore.cases().length,before+1);
  } finally {gate.resolve();}
  const accepted=requests.find(result=>result.status==='fulfilled');assert.ok(accepted&&accepted.status==='fulfilled');assert.equal((await f.waitCase(accepted.value.id)).status,'awaiting_review');
});

test('simultaneous corrections preserve the winning revision and historical review',async t=>{
  const f=await setup(t);const version=await f.publish();const source=await f.upload('invoice.txt','invoice content');
  const original=await f.workflows.startPublished(version.id,{businessKey:'original'},[source]);const ready=await f.waitCase(original.id);const prior=structuredClone(ready.revisions[0]);
  const gate=deferred();const started=deferred();f.state.onExecute=async()=>{started.resolve();await gate.promise;};
  const requests=await Promise.allSettled([
    f.workflows.correct(original.id,prior.id,{amount:600},[]),
    f.workflows.correct(original.id,prior.id,{amount:700},[]),
  ]);
  await started.promise;
  try {
    assert.equal(requests.filter(result=>result.status==='fulfilled').length,1);
    const rejected=requests.find(result=>result.status==='rejected');assert.ok(rejected&&rejected.status==='rejected');assert.equal(rejected.reason.code,'BUSY');
    const current=f.workflowStore.getCase(original.id);assert.equal(current.status,'running');assert.equal(current.revisions.length,2);assert.equal(current.revisions[0].reviewStatus,'invalidated');
    assert.deepEqual({...current.revisions[0],reviewStatus:prior.reviewStatus},prior);
  } finally {gate.resolve();}
  const accepted=requests.find(result=>result.status==='fulfilled');assert.ok(accepted&&accepted.status==='fulfilled');
  const completed=await f.waitCase(original.id);assert.equal(completed.status,'awaiting_review');assert.equal(completed.revisions.length,2);assert.deepEqual(completed.revisions[1].inputData,accepted.value.revisions[1].inputData);
});

test('sample assertions require explicit comparisons and cannot pass on inherited fields',async t=>{
  const f=await setup(t);const draft=await f.author();const revision=draft.revisions[0];
  await assert.rejects(f.workflows.test(draft.id,revision.id,{},[],[{path:'check.missing',operator:'eq'}]),{code:'INVALID_ASSERTION'});
  const malformed=await f.app.inject({method:'POST',url:`/api/workflow-drafts/${draft.id}/test`,payload:{revisionId:revision.id,inputData:{},attachments:[],assertions:[{path:'check.missing',operator:'eq'}]}});assert.equal(malformed.statusCode,400);
  const tested=await f.workflows.test(draft.id,revision.id,{},[],[{path:'check.toString',operator:'exists'},{path:'check.queueRecord',operator:'eq',value:{currency:'AZN',amount:560,businessKey:'invoice-one'}}]);await f.waitCase(tested.caseId);
  const report=f.workflowStore.getDraft(draft.id).revisions[0].testReports[0];assert.deepEqual(report.assertionResults.map(result=>result.passed),[false,true]);assert.equal(report.assertionsPassed,false);
  assert.throws(()=>f.workflows.publish(draft.id,revision.id,true,'Employee'),{code:'TEST_REQUIRED'});
});

test('author refinements snapshot the latest replacement upload while preserving source history',async t=>{
  const f=await setup(t);const first=await f.upload('invoice.txt','old sample invoice');const draft=await f.author(undefined,[first]);const replacement=await f.upload('invoice.txt','corrected sample invoice');
  const refined=await f.author(draft.id,[replacement]);const layout=f.state.layouts.at(-1)!;const inputs=layout.mounts.find(mount=>mount.target==='/workspace/inputs')!.source;
  const context=JSON.parse(await readFile(path.join(inputs,'context.json'),'utf8')) as {sources:{id:string;name:string;originalPath:string}[]};
  assert.equal(context.sources.length,1);assert.equal(context.sources[0].originalPath,replacement.path);
  assert.equal(await readFile(path.join(inputs,'files',context.sources[0].id,context.sources[0].name),'utf8'),'corrected sample invoice');
  assert.equal(refined.messages.filter(message=>message.role==='user')[0].attachments[0].path,first.path);assert.equal(refined.revisions.length,2);
});

test('local package import creates honest provenance and preserves the test and employee review publication gates',async t=>{
  const f=await setup(t);const pkg=packageFixture();const modelRequests=f.state.modelRequests;
  const imported=await f.app.inject({method:'POST',url:'/api/workflow-drafts/import',payload:{package:pkg,sourceLabel:'reviewed-package.json'}});assert.equal(imported.statusCode,201,imported.body);
  const draft=imported.json<Awaited<ReturnType<typeof f.workflows.createDraft>>>();const revision=draft.revisions[0];
  assert.equal(draft.name,pkg.name);assert.equal(draft.revisions.length,1);assert.deepEqual(revision.package,pkg);assert.deepEqual(revision.testReports,[]);assert.equal(draft.importedFrom,'reviewed-package.json');
  assert.equal(f.state.modelRequests,modelRequests);assert.equal(draft.messages.length,1);assert.equal(draft.messages[0].role,'user');assert.match(draft.messages[0].text,/No AI authoring was performed/);assert.equal(revision.runId,undefined);
  assert.throws(()=>f.workflows.publish(draft.id,revision.id,true,'Employee'),{code:'TEST_REQUIRED'});
  const tested=await f.workflows.test(draft.id,revision.id,{businessKey:'imported'},[],[{path:'check.disposition',operator:'eq',value:'ready'}]);await f.waitCase(tested.caseId);
  assert.throws(()=>f.workflows.publish(draft.id,revision.id,false,'Employee'),{code:'REVIEW_REQUIRED'});
  const published=f.workflows.publish(draft.id,revision.id,true,'Employee');assert.equal(published.packageHash,revision.packageHash);assert.equal(published.provenance.length,1);assert.equal(published.provenance[0].role,'user');assert.equal(published.testReport.assertionsPassed,true);
  assert.deepEqual((await f.app.inject('/api/chats')).json(),[]);
});

test('invalid local package imports fail before creating chats or drafts and do not accept export envelopes',async t=>{
  const f=await setup(t);const initialDrafts=f.workflowStore.drafts(true).length;const initialChats=f.harness.store.list().length;
  const invalid=packageFixture();invalid.assets={'../escape.py':'unsafe'};
  for(const payload of [{package:invalid},{package:{package:packageFixture()}},{package:null},{sourceLabel:'missing-package.json'},{package:packageFixture(),extra:true}]){
    const response=await f.app.inject({method:'POST',url:'/api/workflow-drafts/import',payload});assert.equal(response.statusCode,400,response.body);
    assert.equal(f.workflowStore.drafts(true).length,initialDrafts);assert.equal(f.harness.store.list().length,initialChats);
  }
});

test('local package import accepts validated assets larger than the default API body limit',async t=>{
  const f=await setup(t);const pkg=packageFixture();pkg.assets['review-notes.txt']='x'.repeat(1024*1024);
  const imported=await f.app.inject({method:'POST',url:'/api/workflow-drafts/import',payload:{package:pkg}});assert.equal(imported.statusCode,201,imported.body);
  const draft=imported.json<Awaited<ReturnType<typeof f.workflows.createDraft>>>();assert.equal(draft.importedFrom,'JSON package');assert.equal(draft.revisions[0].package.assets['review-notes.txt'].length,1024*1024);assert.deepEqual(draft.revisions[0].testReports,[]);
});
