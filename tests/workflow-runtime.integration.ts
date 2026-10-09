import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkflowPackage, WorkflowStep } from '../shared/workflow-types.js';
import { AgentHarness } from '../server/agent.js';
import { config } from '../server/config.js';
import { SandboxManager } from '../server/sandbox.js';
import { ConversationStore } from '../server/store.js';
import { WorkflowRuntime } from '../server/workflow-runtime.js';

const python = `import json, os, pathlib, resource, socket, subprocess
root = pathlib.Path('/workspace')
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (26214400, 26214400)
for asset in ['package/check.py','inputs/context.json','references/policy.txt','preceding/verified.json']:
    try:
        with open(root / asset, 'a') as stream: stream.write('tampering')
        raise AssertionError('read-only asset was writable: ' + asset)
    except OSError: pass
sock = socket.socket(); sock.settimeout(1)
try:
    sock.connect(('1.1.1.1', 80))
    raise AssertionError('container had outbound networking')
except OSError: pass
finally: sock.close()
assert not (root / '.agent-state').exists()
context = json.loads(pathlib.Path(os.environ['WORKFLOW_CONTEXT']).read_text())
out = pathlib.Path(os.environ['WORKFLOW_OUTPUTS'])
out.joinpath('review.txt').write_text(context['inputData']['marker'])
out.joinpath('manifest.json').write_text(json.dumps({'stepId':os.environ['WORKFLOW_STEP_ID'],'result':{'ready':True},'artifacts':[{'path':'review.txt'}]}))
subprocess.Popen(['bash','-c','sleep 2; echo late > /workspace/output/background.txt'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
`;

test('real workflow containers enforce readonly mounts, network isolation, per-case files and background cleanup', { skip:process.env.RUN_DOCKER_TESTS!=='1',timeout:60000 }, async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'workflow-live-isolation-'));
  const cfg={...config,workspaceDir:path.join(directory,'workspace'),stateDir:path.join(directory,'state')};
  await mkdir(cfg.workspaceDir,{recursive:true});
  const sandboxes=new SandboxManager({workspaceDir:cfg.workspaceDir,image:cfg.sandboxImage,commandTimeoutMs:cfg.commandTimeoutMs,maxOutputBytes:cfg.maxToolOutputBytes});
  const readiness=await sandboxes.readiness();assert.equal(readiness.ready,true,readiness.error);
  const store=new ConversationStore(cfg.stateDir);await store.init();
  const harness=new AgentHarness(cfg,store,sandboxes,()=>{throw new Error('Python workflow must not call model');});
  const runtime=new WorkflowRuntime(cfg,harness,sandboxes);
  t.after(async()=>{await harness.shutdown();await sandboxes.cleanupStale();await rm(directory,{recursive:true,force:true});});
  const step:WorkflowStep={id:'check',type:'python',title:'Isolation probe',instructions:'Check isolation',inputs:['inputs'],outputSchema:{type:'object',properties:{ready:{type:'boolean'}},required:['ready'],additionalProperties:false},artifacts:[{path:'review.txt',label:'Review',required:true}],script:'check.py'};
  const pkg:WorkflowPackage={schemaVersion:1,name:'Isolation probe',slug:'probe',purpose:'Verify actual Docker isolation',inputs:[],references:[],rules:[],deliverables:['Review'],exceptions:[],approval:'Employee review required',questions:[],assumptions:[],steps:[step],assets:{'check.py':python},synthetic:true};
  const requests=[];
  for(const marker of ['first-case','second-case']){
    const base=path.join(directory,marker);const dirs={packageDir:path.join(base,'package'),inputDir:path.join(base,'inputs'),referenceDir:path.join(base,'references'),precedingDir:path.join(base,'preceding'),outputDir:path.join(base,'output')};
    for(const dir of Object.values(dirs))await mkdir(dir,{recursive:true});
    await writeFile(path.join(dirs.packageDir,'check.py'),python);await writeFile(path.join(dirs.inputDir,'context.json'),JSON.stringify({inputData:{marker},preceding:{}}));await writeFile(path.join(dirs.referenceDir,'policy.txt'),'fictional policy');await writeFile(path.join(dirs.precedingDir,'verified.json'),'{}');
    const request={runId:randomUUID(),caseId:marker,revisionId:randomUUID(),step,package:pkg,...dirs,artifactBaseUrl:'/api/artifacts'};
    requests.push(request);const task=await runtime.executeTask(request);
    assert.equal(task.status,'completed',JSON.stringify(task.error));assert.equal(task.cleanupFinished,true);assert.equal(await readFile(path.join(dirs.outputDir,'review.txt'),'utf8'),marker);
    assert.equal(await readFile(path.join(dirs.referenceDir,'policy.txt'),'utf8'),'fictional policy');
  }
  await new Promise(resolve=>setTimeout(resolve,2200));
  for(const request of requests)await assert.rejects(readFile(path.join(request.outputDir,'background.txt')),{code:'ENOENT'});
});
