import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Response } from 'openai/resources/responses/responses';
import type { WorkflowPackage, WorkflowStep } from '../shared/workflow-types.js';
import { AgentHarness } from '../server/agent.js';
import { config } from '../server/config.js';
import type { ModelClient } from '../server/model.js';
import { SandboxManager, type CommandResult, type DockerRunner } from '../server/sandbox.js';
import { ConversationStore } from '../server/store.js';
import { verifyTaskCompletion, WorkflowRuntime, type TaskExecutionRequest } from '../server/workflow-runtime.js';

const result = (stdout='',exitCode=0,stderr=''):CommandResult=>({stdout,exitCode,stderr,truncated:false});
const step:WorkflowStep={id:'check',type:'python',title:'Check supplied records',instructions:'Validate records without inventing policy.',inputs:['inputs'],outputSchema:{type:'object',properties:{ready:{type:'boolean'},amount:{type:'number'}},required:['ready','amount'],additionalProperties:false},artifacts:[{path:'review.txt',label:'Review',required:true}],script:'scripts/check.py'};
const pkg:WorkflowPackage={schemaVersion:1,name:'Fixture',slug:'fixture',purpose:'A generic workflow',inputs:[],references:[],rules:[],deliverables:['Review'],exceptions:[],approval:'Employee approval required',questions:[],assumptions:[],steps:[step],assets:{'scripts/check.py':'print("fixture")'},synthetic:true};
const response=(output:unknown[]):Response=>({id:randomUUID(),status:'completed',output,usage:{input_tokens:10,output_tokens:2,total_tokens:12}} as Response);

async function setup(t:test.TestContext,options:{model?:ModelClient;exec?:(request:TaskExecutionRequest)=>Promise<void>;cleanupFail?:boolean;startFail?:boolean;onDispose?:()=>Promise<void>}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'workflow-runtime-'));
  t.after(async()=>{await chmod(path.join(directory,'output','manifest.json'),0o600).catch(()=>{});await chmod(path.join(directory,'output','review.txt'),0o600).catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const cfg={...config,workspaceDir:path.join(directory,'workspace'),stateDir:path.join(directory,'state')};
  const request:TaskExecutionRequest={runId:randomUUID(),caseId:'case',revisionId:'revision',step:structuredClone(step),package:structuredClone(pkg),packageDir:path.join(directory,'package'),inputDir:path.join(directory,'inputs'),referenceDir:path.join(directory,'references'),precedingDir:path.join(directory,'preceding'),outputDir:path.join(directory,'output'),artifactBaseUrl:'/api/cases/case/revisions/revision/artifacts'};
  for(const dir of [cfg.workspaceDir,request.packageDir,request.inputDir,request.referenceDir,request.precedingDir,request.outputDir])await mkdir(dir,{recursive:true});
  await writeFile(path.join(request.inputDir,'context.json'),JSON.stringify({inputData:{},preceding:{},sources:[]}));
  const calls:string[][]=[];
  const runner:DockerRunner=async args=>{calls.push(args);if(args[0]==='exec'){await (options.exec??writeOutputs)(request);return result('generated');}if(args[0]==='run'&&options.startFail)return result('',1,'container failed during start');if(args[0]==='rm'){await options.onDispose?.();if(options.cleanupFail)return result('',1,'daemon disconnected');}return result();};
  const sandboxes=new SandboxManager({workspaceDir:cfg.workspaceDir,image:cfg.sandboxImage,commandTimeoutMs:cfg.commandTimeoutMs,maxOutputBytes:cfg.maxToolOutputBytes},runner);
  const store=new ConversationStore(cfg.stateDir);await store.init();
  const harness=new AgentHarness(cfg,store,sandboxes,()=>options.model??{respond:async()=>response([])});
  const runtime=new WorkflowRuntime(cfg,harness,sandboxes);
  return {request,calls,harness,runtime,store};
}
async function writeOutputs(request:TaskExecutionRequest){await writeFile(path.join(request.outputDir,'review.txt'),'Validated actual inputs.');await writeFile(path.join(request.outputDir,'manifest.json'),JSON.stringify({stepId:request.step.id,result:{ready:true,amount:560},artifacts:[{path:'review.txt'}]}));}

test('generic Python tasks run only inside isolated containers and freeze verified artifacts after cleanup',async t=>{
  const {request,calls,runtime}=await setup(t);
  const task=await runtime.executeTask(request);
  assert.equal(task.status,'completed');assert.equal(task.cleanupFinished,true);assert.deepEqual(task.result,{ready:true,amount:560});
  assert.equal(task.artifacts[0].hash,createHash('sha256').update('Validated actual inputs.').digest('hex'));
  assert.equal((await stat(path.join(request.outputDir,'review.txt'))).mode&0o222,0);
  assert.match(task.artifacts[0].contentUrl,/\/artifacts\/[a-f0-9-]+\/content$/);
  const run=calls.find(args=>args[0]==='run')!;
  assert.equal(run[run.indexOf('--network')+1],'none');assert.ok(run.includes('--read-only'));
  const mounts=run.flatMap((arg,index)=>arg==='--mount'?[run[index+1]]:[]);
  assert.equal(mounts.length,5);
  for(const name of ['package','inputs','references','preceding'])assert.ok(mounts.some(mount=>mount.endsWith(`target=/workspace/${name},readonly`)));
  assert.ok(!mounts.some(mount=>mount.includes('/state')||mount.includes('docker.sock')));
  const command=calls.find(args=>args[0]==='exec')!.at(-1)!;assert.match(command,/python '\/workspace\/package\/scripts\/check.py'/);assert.match(command,/WORKFLOW_CONTEXT=\/workspace\/inputs\/context.json/);
  assert.equal(calls.at(-1)![0],'rm');
});

test('assistant prose cannot complete an AI task without a validated manifest',async t=>{
  let instructions='';
  const {request,runtime}=await setup(t,{model:{respond:async(_input,_tools,_signal,_event,_retry,prompt)=>{instructions=prompt!;return response([{type:'message',id:'m',role:'assistant',status:'completed',content:[{type:'output_text',text:'Completed and approved!',annotations:[]}]}]);}}});
  request.step.type='ai';delete request.step.script;
  const task=await runtime.executeTask(request);
  assert.equal(task.status,'failed');assert.equal(task.error?.code,'MISSING_ARTIFACT');assert.equal(task.cleanupFinished,true);assert.equal(task.artifacts.length,0);assert.equal(task.usage.totalTokens,12);
  assert.match(instructions,/Do not approve business actions/);assert.match(instructions,/manifest.json/);
});

test('AI tasks use the injected model and the same four tools to produce validated files',async t=>{
  let round=0;let prompt='';
  const {request,runtime}=await setup(t,{model:{respond:async(_input,tools,_signal,_event,_retry,instructions)=>{prompt=instructions!;assert.equal(tools.length,4);return response(++round===1?[{type:'function_call',id:'f',call_id:'one',name:'bash',arguments:'{"command":"generate files","timeoutMs":null}',status:'completed'}]:[]);}}});
  request.step.type='ai';delete request.step.script;
  const task=await runtime.executeTask(request);
  assert.equal(task.status,'completed');assert.equal(task.usage.totalTokens,12);assert.equal(round,1);assert.match(prompt,/Check supplied records/);
});

test('cleanup failure makes a task uncertain and prevents manifest import or artifact freezing',async t=>{
  const {request,runtime}=await setup(t,{cleanupFail:true});
  const task=await runtime.executeTask(request);
  assert.equal(task.status,'uncertain');assert.equal(task.cleanupFinished,false);assert.equal(task.error?.code,'SANDBOX_CLEANUP_FAILED');assert.equal(task.result,undefined);assert.equal(task.artifacts.length,0);
  assert.ok((await stat(path.join(request.outputDir,'review.txt'))).mode&0o200);
});

test('failed container creation with failed removal records cleanup as unfinished',async t=>{
  const {request,runtime}=await setup(t,{startFail:true,cleanupFail:true});
  const task=await runtime.executeTask(request);assert.equal(task.status,'uncertain');assert.equal(task.cleanupFinished,false);assert.equal(task.error?.code,'SANDBOX_CLEANUP_FAILED');assert.equal(task.artifacts.length,0);
});

test('repeated workflow model calls cannot rerun mutations and retain all observed token usage',async t=>{
  const call={type:'function_call',id:'fc_once',call_id:'once',name:'bash',arguments:'{"command":"write outputs","timeoutMs":null}',status:'completed'};
  const {request,runtime,calls}=await setup(t,{model:{respond:async()=>response([call])},exec:async request=>{await writeFile(path.join(request.outputDir,'review.txt'),'A partial mutation without a completion manifest.');}});request.step.type='ai';delete request.step.script;
  const task=await runtime.executeTask(request);assert.equal(task.status,'failed');assert.equal(task.error?.code,'DUPLICATE_TOOL_CALL');assert.equal(calls.filter(args=>args[0]==='exec').length,1);assert.equal(task.usage.totalTokens,24);assert.equal(task.cleanupFinished,true);assert.equal(task.artifacts.length,0);
});

test('missing artifacts and invalid structured results reject otherwise successful commands',async t=>{
  const missing=await setup(t,{exec:async request=>{await writeFile(path.join(request.outputDir,'manifest.json'),JSON.stringify({stepId:'check',result:{ready:false,amount:0},artifacts:[]}));}});
  assert.equal((await missing.runtime.executeTask(missing.request)).error?.code,'MISSING_ARTIFACT');
  const invalid=await setup(t,{exec:async request=>{await writeOutputs(request);await writeFile(path.join(request.outputDir,'manifest.json'),JSON.stringify({stepId:'check',result:{ready:'yes',amount:560},artifacts:[{path:'review.txt'}]}));}});
  assert.equal((await invalid.runtime.executeTask(invalid.request)).error?.code,'INVALID_TASK_RESULT');
});

test('symlinks and manifest path traversal are rejected without reading outside task outputs',async t=>{
  const linked=await setup(t,{exec:async request=>{await writeOutputs(request);await rm(path.join(request.outputDir,'review.txt'));await symlink(path.join(request.inputDir,'context.json'),path.join(request.outputDir,'review.txt'));}});
  assert.equal((await linked.runtime.executeTask(linked.request)).error?.code,'UNSAFE_ARTIFACT');
  const traversal=await setup(t,{exec:async request=>{await writeOutputs(request);await writeFile(path.join(request.outputDir,'manifest.json'),JSON.stringify({stepId:'check',result:{ready:true,amount:560},artifacts:[{path:'../inputs/context.json'}]}));}});
  assert.equal((await traversal.runtime.executeTask(traversal.request)).error?.code,'UNSAFE_PACKAGE_PATH');
});

test('conditional required files use validated task and preceding results',async t=>{
  const {request}=await setup(t);request.step.artifacts[0].when={stepId:'check',path:'ready',operator:'eq',value:false};
  await writeFile(path.join(request.outputDir,'manifest.json'),JSON.stringify({stepId:'check',result:{ready:true,amount:560},artifacts:[]}));
  assert.equal((await verifyTaskCompletion(request)).artifacts.length,0);
  await chmod(path.join(request.outputDir,'manifest.json'),0o600);request.step.artifacts[0].when={stepId:'earlier',path:'requiresLetter',operator:'eq',value:true};
  await writeFile(path.join(request.inputDir,'context.json'),JSON.stringify({preceding:{earlier:{requiresLetter:true}}}));
  await assert.rejects(verifyTaskCompletion(request),{code:'MISSING_ARTIFACT'});
});

test('a shared coordinator reserves the slot through cleanup and releases it for employee review',async t=>{
  const {request,harness,runtime,store}=await setup(t);let release!:()=>void;
  const holding=harness.runExclusive('workflow-case','workflow',async signal=>{const task=await runtime.executeTask({...request,slotHeld:true},signal);assert.equal(task.status,'completed');await new Promise<void>(resolve=>{release=resolve;});return task;});
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  const chat=await store.create();assert.equal(harness.busy,true);assert.equal(harness.activeExecution?.id,'workflow-case');
  await assert.rejects(harness.submit(chat.id,'Chat during workflow',[]),{code:'BUSY'});
  await assert.rejects(runtime.executeTask({...request,runId:'another'}),{code:'BUSY'});
  release();await holding;assert.equal(harness.busy,false);assert.equal(harness.activeExecution,null);
});

test('stopping a shared workflow waits for cleanup and preserves completed files without accepting them',async t=>{
  let started!:()=>void;const executing=new Promise<void>(resolve=>{started=resolve;});
  const {request,harness,runtime}=await setup(t,{exec:async request=>{await writeOutputs(request);started();await new Promise(resolve=>setTimeout(resolve,20));}});
  const pending=runtime.executeTask(request);await executing;await harness.abortExclusive(request.runId);
  const task=await pending;assert.equal(task.error?.code,'STOPPED');assert.equal(task.cleanupFinished,true);assert.equal(task.artifacts.length,0);assert.equal(harness.busy,false);assert.ok(await readFile(path.join(request.outputDir,'review.txt')));
});

test('isolated mounts reject writable references and reuse of nonempty task output directories',async t=>{
  const {request,runtime,harness}=await setup(t);await writeOutputs(request);
  assert.equal((await runtime.executeTask(request)).error?.code,'OUTPUT_CONFLICT');
  await assert.rejects(harness.sandboxes.createIsolated('unsafe',new AbortController().signal,{mounts:[{source:request.referenceDir,target:'/workspace/references',readOnly:false}],outputDir:request.outputDir}),{code:'INVALID_MOUNT'});
});

test('output verification rejects excessive empty directories and nesting before importing results',async t=>{
  const nested=await setup(t,{exec:async request=>{await writeOutputs(request);await mkdir(path.join(request.outputDir,...Array.from({length:17},()=> 'nested')),{recursive:true});}});
  assert.equal((await nested.runtime.executeTask(nested.request)).error?.code,'ARTIFACT_LIMIT');
  const numerous=await setup(t,{exec:async request=>{await writeOutputs(request);await Promise.all(Array.from({length:513},(_,index)=>mkdir(path.join(request.outputDir,`directory-${index}`))));}});
  assert.equal((await numerous.runtime.executeTask(numerous.request)).error?.code,'ARTIFACT_LIMIT');
});

test('a valid AI manifest avoids final provider prose and cannot freeze or return results before cleanup',async t=>{
  let requests=0,startDisposal!:()=>void,releaseDisposal!:()=>void;
  const disposing=new Promise<void>(resolve=>{startDisposal=resolve;});const gate=new Promise<void>(resolve=>{releaseDisposal=resolve;});
  const {request,runtime,harness}=await setup(t,{model:{respond:async()=>{if(++requests>1)throw new Error('Final provider prose would exceed quota.');return response([{type:'function_call',id:'fc',call_id:'write-files',name:'bash',arguments:'{"command":"produce declared files","timeoutMs":null}',status:'completed'}]);}},onDispose:async()=>{startDisposal();await gate;}});
  request.step.type='ai';delete request.step.script;let returned=false;
  const pending=runtime.executeTask(request).then(task=>{returned=true;return task;});await disposing;
  assert.equal(returned,false);assert.equal(harness.busy,true);assert.equal(requests,1);assert.ok((await stat(path.join(request.outputDir,'review.txt'))).mode&0o200);assert.ok((await stat(path.join(request.outputDir,'manifest.json'))).mode&0o200);
  releaseDisposal();const task=await pending;assert.equal(task.status,'completed');assert.equal(task.cleanupFinished,true);assert.equal(task.artifacts.length,1);assert.equal(task.usage.totalTokens,12);assert.equal((await stat(path.join(request.outputDir,'review.txt'))).mode&0o222,0);assert.equal(harness.busy,false);
});

test('preliminary AI completion is revalidated after cleanup and cannot accept changed invalid results',async t=>{
  let requests=0;let request!:TaskExecutionRequest;
  const fixture=await setup(t,{model:{respond:async()=>{requests++;return response([{type:'function_call',id:'fc',call_id:'one',name:'bash',arguments:'{"command":"write outputs","timeoutMs":null}',status:'completed'}]);}},onDispose:async()=>{await writeFile(path.join(request.outputDir,'manifest.json'),JSON.stringify({stepId:'check',result:{ready:'changed and invalid',amount:560},artifacts:[{path:'review.txt'}]}));}});
  request=fixture.request;request.step.type='ai';delete request.step.script;
  const task=await fixture.runtime.executeTask(request);assert.equal(requests,1);assert.equal(task.status,'failed');assert.equal(task.error?.code,'INVALID_TASK_RESULT');assert.equal(task.cleanupFinished,true);assert.equal(task.result,undefined);assert.equal(task.artifacts.length,0);assert.ok((await stat(path.join(request.outputDir,'review.txt'))).mode&0o200);
});
