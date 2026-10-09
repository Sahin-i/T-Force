/** Regrade retained immutable outputs; no model calls or approval mutations. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { safeFile } from '../server/files.js';
import { evaluateResult, summarizeEvaluation, evaluationMethod, type BusinessEvaluation, type FrozenTruth } from './evaluate-workflows.js';
import type { WorkflowCase } from '../shared/workflow-types.js';
import { canonicalHash } from '../server/workflow-validation.js';
import { atomicReport } from './workflow-report.js';

export async function regradeEvaluation(filename:string,validationDir=path.resolve('.agent-state/validation/workflows')){
  const report=JSON.parse(await readFile(filename,'utf8')) as BusinessEvaluation&{stateDirectory:string;runs?:Record<string,unknown>[];phase?:string;selectedScenarios?:number;model?:string};
  if(!report.stateDirectory)throw new Error('Regrading requires retained evaluation state; originally run with --keep-state');
  if(report.phase&&report.phase!=='completed')throw new Error('Do not regrade a live comparison while its worker is active');
  const db=new DatabaseSync(path.join(report.stateDirectory,'workflows.sqlite'),{readOnly:true});
  try{
    const cases=(db.prepare('SELECT data FROM cases').all() as {data:string}[]).map(row=>JSON.parse(row.data) as WorkflowCase);
    const queues=(db.prepare('SELECT data FROM queues').all() as {data:string}[]).map(row=>JSON.parse(row.data) as {destination:string;businessKey:string;record:Record<string,unknown>});
    const scenarios=[];const details=[];
    for(const prior of report.scenarios){
      const run=report.runs?.find(run=>run.suite===prior.suite&&run.id===prior.id);const c=run?cases.find(c=>c.id===run.caseId):cases.find(c=>c.title===`${prior.suite} ${prior.id}`);if(!c)throw new Error(`Missing retained case ${prior.suite}/${prior.id}`);
      const revision=c.revisions.at(-1)!;if(revision.executionStatus==='running'||revision.executionStatus==='queued')throw new Error('Cannot grade unfinished execution');
      const truthFile=JSON.parse(await readFile(path.join(validationDir,`${prior.suite}.json`),'utf8')) as {seed:number;truth:FrozenTruth[]};if(truthFile.seed!==report.seed)throw new Error('Frozen truth seed differs from retained run');const truth=truthFile.truth.find(t=>t.id===prior.id)!;
      const result=revision.tasks.find(t=>t.stepId==='validate')?.result??{};
      const readArtifact=async(name:string)=>{
        const artifact=revision.artifacts.find(a=>a.path===name);if(!artifact)throw new Error(`Missing protected artifact ${name}`);
        const root=path.join(report.stateDirectory,'workflow-data/cases',c.id,revision.id,'tasks',artifact.stepId);const opened=await safeFile(root,artifact.path);
        try{const bytes=await opened.handle.readFile();if(createHash('sha256').update(bytes).digest('hex')!==artifact.hash)throw new Error('Protected artifact fingerprint changed');return bytes;}finally{await opened.handle.close();}
      };
      let queueCorrect:boolean|null=c.isTest?null:truth.disposition!=='ready'?queues.every(queue=>!c.approvals.some(approval=>approval.destination===queue.destination&&approval.businessKey===queue.businessKey)):false;
      if(!c.isTest&&truth.disposition==='ready'){
        const approval=c.approvals.find(approval=>approval.revisionId===revision.id);const matches=approval?queues.filter(queue=>queue.destination===approval.destination&&queue.businessKey===approval.businessKey):[];queueCorrect=matches.length===1&&canonicalHash(matches[0]!.record)===canonicalHash(result.queueRecord);
      }
      scenarios.push(await evaluateResult(prior.suite,prior.kind,truth,result,readArtifact,{executionCompleted:revision.executionStatus==='completed',elapsedMs:revision.elapsedMs,usage:revision.usage,queueCorrect}));
      details.push({suite:prior.suite,id:prior.id,caseId:c.id,revisionId:revision.id,packageHash:c.packageHash,resultHash:revision.resultHash,sourceSnapshotDigest:canonicalHash(revision.sources.map(source=>({name:source.name,kind:source.kind,hash:source.hash}))),sourceSnapshots:revision.sources.map(source=>({name:source.name,kind:source.kind,hash:source.hash})),artifactHashes:revision.artifacts.map(artifact=>({name:artifact.name,hash:artifact.hash})),mode:c.isTest?'draft_test_setup_failed':'published_business_case'});
    }
    const graded=summarizeEvaluation(report.seed,scenarios,report.provenance,queues.length,report.metrics.duplicatesPrevented);
    const setupRuns=(report.runs??[]).filter(run=>run.setup===true);const setupTokens=setupRuns.reduce((total,run)=>total+Number((run.usage as {totalTokens?:number}|undefined)?.totalTokens??0),0);const setupElapsed=setupRuns.reduce((total,run)=>total+Number(run.elapsedMs??0),0);
    const classificationCorrect=scenarios.filter(s=>!s.failures.some(f=>f.startsWith('Expected disposition'))).length;
    const output={...report,scenarios:graded.scenarios,metrics:graded.metrics,additionalMetrics:{businessClassificationsCorrect:classificationCorrect,readyDecisionsCorrect:scenarios.length-graded.metrics.falseReady-graded.metrics.falseBlocked,strictOptionalFieldAccuracy:scenarios.reduce((sum,s)=>sum+(s.strictFieldsCorrect??0),0)/Math.max(1,scenarios.reduce((sum,s)=>sum+s.fieldsTotal,0)),exceljsCompatibilityFailures:scenarios.filter(s=>s.compatibilityWarnings?.length).length,setupTokens,setupElapsedMs:setupElapsed,totalReportedTokensIncludingSetup:graded.metrics.totalTokens+setupTokens,totalMeasuredTaskElapsedMsIncludingSetup:graded.metrics.elapsedMs+setupElapsed},method:{...report.method,...evaluationMethod({...graded,generatedAt:report.generatedAt}),semanticExtraction:'Facts delivered in structured results are read from extracted/extractedFields/extraction and documented document groups; evidence wrappers are unwrapped and finite decimal values are compared semantically. Missing structured facts are counted as absent, not proof that the model did not read the source. Strict optional paths/formatting are separately retained.',xlsxVerification:'ExcelJS is used first; compatibility failures are checked against independent ZIP/XML worksheet cells. Actual missing/corrupt data remain failures; ExcelJS compatibility warnings are separate.',recordContract:'A 560.01 declared total can be business-ready within tolerance while differing from the evaluator’s calculated-total output-record contract. Such differences are record-contract failures, not false-ready decisions.',regradedAt:new Date().toISOString(),modelCallsRepeated:0,approvalMutationsRepeated:0},retainedEvidence:details};
    await atomicReport(filename,output);return output;
  }finally{db.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const filename=path.resolve(process.argv[2]??'.agent-state/validation/workflows/evaluation-report.json');
  regradeEvaluation(filename).then(report=>console.log(JSON.stringify({report:filename,metrics:report.metrics}))).catch(error=>{console.error(error);process.exitCode=1;});
}
