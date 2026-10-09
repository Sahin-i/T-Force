import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { catalogRecipes, createCatalogPackage, type CatalogKind } from '../catalog/catalog.js';
import { createCatalogModel } from '../catalog/test-model.js';
import { validatePackage, canonicalHash } from '../server/workflow-validation.js';
import { config } from '../server/config.js';
import { ConversationStore } from '../server/store.js';
import { AgentHarness } from '../server/agent.js';
import { SandboxManager } from '../server/sandbox.js';
import { createApp } from '../server/app.js';
import type { Attachment } from '../shared/types.js';
import { extractedFacts, semanticField, factsEqual, calculatedField, readXlsxCells } from './workflow-grading.js';
import { atomicReport } from './workflow-report.js';

export interface FrozenTruth {id:string;disposition:string;findingCodes:string[];extracted:Record<string,unknown>;renderedFields?:Record<string,unknown>;queueRecord?:Record<string,unknown>;referenceValues?:Record<string,number>;amount:number|null;letter:boolean}
export interface ScenarioEvaluation {suite:string;id:string;kind:CatalogKind;passed:boolean;executionCompleted:boolean;falseReady:boolean;falseBlocked:boolean;fieldsCorrect:number;fieldsTotal:number;strictFieldsCorrect?:number;strictOutputContractFailures?:string[];compatibilityWarnings?:string[];exceptionsCorrect:boolean;artifactsCorrect:boolean;queueCorrect:boolean|null;elapsedMs:number;usage:{inputTokens:number;outputTokens:number;totalTokens:number};failures:string[]}
export interface EvaluationPackage {kind:CatalogKind;packageHash:string;slug:string;workflowVersionId?:string;draftId?:string;revisionId:string}
export interface BusinessEvaluation {provenance:string;seed:number;scenarios:ScenarioEvaluation[];metrics:{scenarios:number;passed:number;falseReady:number;falseBlocked:number;extractionAccuracy:number;detectedExceptions:number;artifactCorrectness:number;queueRecords:number;duplicateRecords:number;duplicatesPrevented:number;elapsedMs:number;inputTokens:number;outputTokens:number;totalTokens:number};baseline:{status:string;reason:string};generatedAt:string;packages?:EvaluationPackage[];method?:Record<string,unknown>}
interface InputIndex {seed:number;scenarios:{suite:string;id:string;kind:CatalogKind;files:{path:string;sha256:string}[]}[]}

function entries(value:unknown,prefix=''):Map<string,unknown>{
  if(value&&typeof value==='object'&&!Array.isArray(value))return new Map(Object.entries(value).flatMap(([key,v])=>[...entries(v,prefix?`${prefix}.${key}`:key)]));
  return new Map([[prefix,value]]);
}
function xmlText(xml:string):string{return xml.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/\s+/g,' ');}

/** Uses ExcelJS/OOXML independently of the Python generators. */
export async function inspectBusinessArtifacts(kind:CatalogKind,truth:FrozenTruth,result:Record<string,unknown>,read:(filename:string)=>Promise<Buffer>,compatibilityWarnings:string[]=[]):Promise<string[]>{
  const failures:string[]=[];
  const workbookName=kind==='invoice'?'review.xlsx':kind==='onboarding'?'checklist.xlsx':'reconciliation.xlsx';
  try{
    const bytes=await read(workbookName);let sheet:ReturnType<typeof readXlsxCells>;
    try{const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);const original=workbook.worksheets[0]!;sheet={rowCount:original?.rowCount,getCell:address=>({value:original.getCell(address).value}),getRows:(start,count)=>(original.getRows(start,count)??[]).map(row=>({getCell:column=>({value:row.getCell(column).value})}))};}catch(error){sheet=readXlsxCells(bytes);compatibilityWarnings.push(`${workbookName}: ExcelJS compatibility failure (${(error as Error).message}); independent OOXML cells were read successfully.`);}
    if(!sheet||sheet.rowCount<4)throw new Error('Empty workbook');
    if(kind==='invoice'){
      if(sheet.getCell('A4').value!==result.businessKey||!new RegExp(`^${truth.disposition}(?:$|\\s|[—:;,.(-])`,'i').test(String(sheet.getCell('B4').value).trim()))throw new Error('Review row does not match business evidence');
      if(truth.amount!==null&&!factsEqual('amount',truth.amount,sheet.getCell('E4').value))throw new Error('Review amount does not match independent truth');
    }else if(kind==='onboarding'){
      const rows=sheet.getRows(4,4)!;
      for(const name of ['application','extract','authority','identification']){
        const row=rows.find(row=>String(row.getCell(1).value).trim().toLowerCase()===name);
        if(!row||row.getCell(2).value!==Object.hasOwn(truth.extracted,name)||row.getCell(3).value!==result.businessKey)throw new Error(`The ${name} checklist presence or business reference is wrong`);
      }
    }else if(sheet.getCell('A4').value!==result.businessKey||!factsEqual('amount',truth.amount,sheet.getCell('D4').value))throw new Error('Reconciliation credit differs from independent truth');
  }catch(error){failures.push(`Workbook: ${(error as Error).message}`);}
  const letters=kind==='invoice'?(truth.letter?['correction-letter.docx']:[]):kind==='onboarding'?['application-packet.docx',...(truth.letter?['missing-information.docx']:[])]:['response.docx'];
  for(const filename of letters)try{
    const zipped=unzipSync(await read(filename));const xml=zipped['word/document.xml'];if(!xml)throw new Error('Missing Word document body');
    const text=xmlText(strFromU8(xml));if(!text.includes(String(result.businessKey))||!text.toLowerCase().includes('fictional'))throw new Error('Missing business reference or synthetic disclosure');
    if(filename==='missing-information.docx'&&truth.findingCodes.includes('missing_identification')&&(!/representative|nümayəndə/i.test(text)||!/identification|identity|\bID\s+(?:card|document)|şəxsiyyət/i.test(text)))throw new Error('Letter did not specifically request representative identification');
    if(kind==='complaints'&&truth.amount===12.5&&(!/\b12[.,]50?\b/.test(text)||!text.includes('CHARGE-2')))throw new Error('Response omits the credit or duplicate transaction evidence');
    if(kind==='invoice'&&truth.findingCodes.includes('excess_delivery_quantity')){
      const quantity=String(truth.extracted.quantity??'');const remaining=String(truth.referenceValues?.remainingDeliveryQuantity??'');
      const containsNumber=(value:string)=>new RegExp(`(?<![\\d.])${value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?!\\d|[.,]\\d)`).test(text);
      if(!/deliver|receiv|receipt|çatdır|təslim/i.test(text)||!containsNumber(quantity)||remaining&&!containsNumber(remaining))throw new Error('Correction request omitted the invoiced quantity or remaining delivery discrepancy');
    }
  }catch(error){failures.push(`${filename}: ${(error as Error).message}`);}
  if(kind==='complaints')try{const timeline=JSON.parse((await read('timeline.json')).toString());if(!Array.isArray(timeline))throw new Error('Timeline must be structured evidence');}catch(error){failures.push(`Timeline: ${(error as Error).message}`);}
  return failures;
}

export async function evaluateResult(suite:string,kind:CatalogKind,truth:FrozenTruth,result:Record<string,unknown>,read:(filename:string)=>Promise<Buffer>,options:{executionCompleted?:boolean;elapsedMs?:number;usage?:ScenarioEvaluation['usage'];queueCorrect?:boolean|null}={}):Promise<ScenarioEvaluation>{
  const failures:string[]=[];
  const disposition=result.disposition;
  if(disposition!==truth.disposition)failures.push(`Expected disposition ${truth.disposition}, received ${String(disposition)}`);
  const application=(truth.extracted.application??{}) as Record<string,unknown>;
  const expectedKey=kind==='invoice'&&truth.extracted.supplier_id&&truth.extracted.invoice_number?`${truth.extracted.supplier_id}:${truth.extracted.invoice_number}`:kind==='onboarding'?application.application_id:kind==='complaints'?truth.extracted.complaint_id:undefined;
  if(expectedKey!==undefined&&result.businessKey!==expectedKey)failures.push('Business key differs from independent document truth');
  const codes=(Array.isArray(result.findings)?result.findings:[]).map(f=>(f as {code:string}).code).sort();
  const exceptionsCorrect=JSON.stringify(codes)===JSON.stringify(truth.findingCodes);
  if(!exceptionsCorrect)failures.push(`Expected exceptions ${truth.findingCodes.join(',')}, received ${codes.join(',')}`);
  const expectedOutput=entries(truth.extracted),wanted=entries(truth.renderedFields??truth.extracted),strictActual=entries(result.extracted),facts=extractedFacts(result);let fieldsCorrect=0,strictFieldsCorrect=0;const strictOutputContractFailures:string[]=[];
  for(const [key,value] of wanted){if(factsEqual(key,value,semanticField(facts,key)))fieldsCorrect++;if(JSON.stringify(value)===JSON.stringify(strictActual.get(key)))strictFieldsCorrect++;}
  for(const [key,value] of expectedOutput){if(!factsEqual(key,value,semanticField(facts,key)))failures.push(`Extracted fact ${key} differs from independent document truth`);if(JSON.stringify(value)!==JSON.stringify(strictActual.get(key)))strictOutputContractFailures.push(`Optional canonical path extracted.${key} or source formatting differs`);}
  if(truth.amount!==null){const key=kind==='invoice'?'calculatedTotal':'creditRecommendation';const amount=calculatedField(result,key);if(!factsEqual('amount',truth.amount,amount))failures.push(`Expected amount ${truth.amount}, received ${String(amount)}`);if(!factsEqual('amount',truth.amount,result[key]))strictOutputContractFailures.push(`Optional top-level ${key} path differs`);}
  if(truth.queueRecord&&(result.queueRecord===undefined||canonicalHash(result.queueRecord)!==canonicalHash(truth.queueRecord)))failures.push('Recommended queue record differs from the specified output-record contract; business readiness is evaluated separately');
  const compatibilityWarnings:string[]=[];const artifactFailures=await inspectBusinessArtifacts(kind,truth,result,read,compatibilityWarnings);failures.push(...artifactFailures);
  const executionCompleted=options.executionCompleted??true;if(!executionCompleted)failures.push('Task execution did not complete');
  if(options.queueCorrect===false)failures.push('Authoritative queue record differs from the approved result or duplicate prevention failed');
  return {suite,id:truth.id,kind,passed:!failures.length,executionCompleted,falseReady:disposition==='ready'&&truth.disposition!=='ready',falseBlocked:disposition!=='ready'&&truth.disposition==='ready',fieldsCorrect,fieldsTotal:wanted.size,strictFieldsCorrect,strictOutputContractFailures,compatibilityWarnings,exceptionsCorrect,artifactsCorrect:!artifactFailures.length,queueCorrect:options.queueCorrect??null,elapsedMs:options.elapsedMs??0,usage:options.usage??{inputTokens:0,outputTokens:0,totalTokens:0},failures};
}

export function summarizeEvaluation(seed:number,scenarios:ScenarioEvaluation[],provenance:string,queueRecords=0,duplicateRecords=0):BusinessEvaluation{
  const sum=(f:(s:ScenarioEvaluation)=>number)=>scenarios.reduce((a,s)=>a+f(s),0);
  return {provenance,seed,scenarios,metrics:{scenarios:scenarios.length,passed:sum(s=>Number(s.passed)),falseReady:sum(s=>Number(s.falseReady)),falseBlocked:sum(s=>Number(s.falseBlocked)),extractionAccuracy:sum(s=>s.fieldsCorrect)/Math.max(1,sum(s=>s.fieldsTotal)),detectedExceptions:sum(s=>Number(s.exceptionsCorrect)),artifactCorrectness:sum(s=>Number(s.artifactsCorrect))/Math.max(1,scenarios.length),queueRecords,duplicateRecords:0,duplicatesPrevented:duplicateRecords,elapsedMs:sum(s=>s.elapsedMs),inputTokens:sum(s=>s.usage.inputTokens),outputTokens:sum(s=>s.usage.outputTokens),totalTokens:sum(s=>s.usage.totalTokens)},baseline:{status:'not_run',reason:'A same-model general-agent comparison requires a separately executed live Azure run using the same inputs, policy, templates and approval boundary. Deterministic fixture execution is not a model-quality comparison.'},generatedAt:new Date().toISOString()};
}

export async function pollEvaluation<T>(read:()=>T,done:(value:T)=>boolean,timeoutMs=120000):Promise<T>{const start=Date.now();for(;;){const value=read();if(done(value))return value;if(Date.now()-start>timeoutMs)throw new Error('Workflow evaluation timed out');await new Promise(resolve=>setTimeout(resolve,100));}}
export async function uploadEvaluationFile(app:Awaited<ReturnType<typeof createApp>>['app'],file:string):Promise<Attachment>{
  const bytes=await readFile(file);const boundary='workflow-evaluation-upload';const mime=file.endsWith('.pdf')?'application/pdf':file.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':file.endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':file.endsWith('.sqlite')?'application/vnd.sqlite3':'text/csv';
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${path.basename(file)}"\r\nContent-Type: ${mime}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const response=await app.inject({method:'POST',url:'/api/files/upload',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:body});if(response.statusCode!==200)throw new Error(`Upload failed: ${response.body}`);return response.json<{files:Attachment[]}>().files[0]!;
}

/** Actual backend API, shared harness, isolated Docker interpreter and SQLite queues. */
export async function runBusinessEvaluation(options:{fixtureDir?:string;validationDir?:string;outputFile?:string;keepState?:boolean}={}):Promise<BusinessEvaluation>{
  const fixtureDir=path.resolve(options.fixtureDir??'catalog/fixtures');
  const localTruth=path.resolve('.agent-state/validation/workflows');
  const validationDir=path.resolve(options.validationDir??(existsSync(path.join(localTruth,'invoice-development.json'))?localTruth:'deliverables/evidence/truth'));
  const index=JSON.parse(await readFile(path.join(fixtureDir,'index.json'),'utf8')) as InputIndex;
  const temporary=await mkdtemp(path.join(os.tmpdir(),'workflow-business-evaluation-'));
  const cfg={...config,workspaceDir:path.join(temporary,'workspace'),stateDir:path.join(temporary,'state'),endpoint:'https://example.invalid',apiKey:'deterministic-fixture',model:'Deterministic catalog fixture model'};
  const store=new ConversationStore(cfg.stateDir);const manager=new SandboxManager({workspaceDir:cfg.workspaceDir,image:cfg.sandboxImage,commandTimeoutMs:cfg.commandTimeoutMs,maxOutputBytes:cfg.maxToolOutputBytes});const harness=new AgentHarness(cfg,store,manager,createCatalogModel);
  const instance=await createApp(cfg,{store,harness,sandboxes:manager,skipRecovery:true});const {app,workflows,workflowStore}=instance;
  const results:ScenarioEvaluation[]=[];const packages:EvaluationPackage[]=[];let duplicateRecords=0;
  const attachments=new Map<string,Attachment[]>();
  const uploaded=async(suite:string,id:string)=>{
    const key=`${suite}/${id}`;if(attachments.has(key))return attachments.get(key)!;
    const record=index.scenarios.find(s=>s.suite===suite&&s.id===id)!;const list:Attachment[]=[];for(const file of record.files)list.push(await uploadEvaluationFile(app,path.join(fixtureDir,file.path)));attachments.set(key,list);return list;
  };
  try{
    for(const recipe of catalogRecipes){
      validatePackage(await createCatalogPackage(recipe.kind));
      const sample=await uploaded(recipe.sampleSuite,recipe.sampleId);const draft=await workflows.createDraft(recipe.name);
      await workflows.author(draft.id,recipe.procedure,sample);
      const authored=await pollEvaluation(()=>workflowStore.getDraft(draft.id),d=>d.status!=='authoring');if(authored.status==='failed'||!authored.revisions.length)throw new Error(`Authoring failed: ${JSON.stringify(authored.error??authored.candidateDiagnostics)}`);
      const revision=authored.revisions.at(-1)!;
      const expectedSample=JSON.parse(await readFile(path.join(validationDir,recipe.sampleSuite+'.json'),'utf8')) as {truth:FrozenTruth[]};const expected=expectedSample.truth.find(t=>t.id===recipe.sampleId)!;
      const tested=await workflows.test(draft.id,revision.id,{},sample,[{path:'validate.disposition',operator:'eq',value:expected.disposition}]);await pollEvaluation(()=>workflowStore.getCase(tested.caseId),c=>c.status!=='running');
      await pollEvaluation(()=>workflowStore.getDraft(draft.id),d=>d.revisions.at(-1)!.testReports.at(-1)!.executionStatus!=='running');
      const version=workflows.publish(draft.id,revision.id,true,'Synthetic evaluation employee');
      packages.push({kind:recipe.kind,packageHash:version.packageHash,slug:version.package.slug,workflowVersionId:version.id,draftId:version.draftId,revisionId:version.revisionId});
      const scenarios=index.scenarios.filter(s=>s.kind===recipe.kind);
      for(const scenario of scenarios){
        const truthSuite=JSON.parse(await readFile(path.join(validationDir,scenario.suite+'.json'),'utf8')) as {seed:number;truth:FrozenTruth[]};if(truthSuite.seed!==index.seed)throw new Error('Truth seed does not match input generation');const truth=truthSuite.truth.find(t=>t.id===scenario.id)!;
        const files=await uploaded(scenario.suite,scenario.id);const started=await workflows.startPublished(version.id,{},files,`${scenario.suite} ${scenario.id}`);const completed=await pollEvaluation(()=>workflowStore.getCase(started.id),c=>c.status!=='running');const current=completed.revisions.at(-1)!;const result=current.tasks.find(t=>t.stepId==='validate')?.result??{};
        let queueCorrect=truth.disposition!=='ready'?workflowStore.queues().every(q=>q.caseId!==completed.id):false;
        if(truth.disposition==='ready'&&completed.status==='awaiting_review'){
          const approval=await workflows.approve(completed.id,current.id,current.resultHash!,'Synthetic evaluation employee');const repeated=await workflows.approve(completed.id,current.id,current.resultHash!,'Synthetic evaluation employee');
          // Independently query authoritative SQLite rather than accepting prose/API claims.
          const db=new DatabaseSync(path.join(cfg.stateDir,'workflows.sqlite'),{readOnly:true});try{const rows=db.prepare('SELECT data FROM queues WHERE destination=? AND business_key=?').all(approval.destination,approval.businessKey) as {data:string}[];queueCorrect=rows.length===1&&JSON.stringify(JSON.parse(rows[0]!.data).record)===JSON.stringify(result.queueRecord)&&repeated.queueRecordId===approval.queueRecordId;}finally{db.close();}
          if(approval.duplicate)duplicateRecords++;
          // A fresh case with the same source must also return the original queue record.
          const replay=await workflows.startPublished(version.id,{},files,'Duplicate submission verification');const readyReplay=await pollEvaluation(()=>workflowStore.getCase(replay.id),c=>c.status!=='running');const replayRevision=readyReplay.revisions.at(-1)!;const replayApproval=await workflows.approve(replay.id,replayRevision.id,replayRevision.resultHash!,'Synthetic evaluation employee');queueCorrect=queueCorrect&&replayApproval.duplicate&&replayApproval.queueRecordId===approval.queueRecordId;duplicateRecords+=Number(replayApproval.duplicate);
        }
        const readArtifact=async(name:string)=>{const artifact=current.artifacts.find(a=>a.path===name);if(!artifact)throw new Error(`Missing ${name}`);const response=await app.inject({method:'GET',url:artifact.contentUrl});if(response.statusCode!==200)throw new Error(response.body);return response.rawPayload;};
        results.push(await evaluateResult(scenario.suite,scenario.kind,truth,result,readArtifact,{executionCompleted:current.executionStatus==='completed',elapsedMs:current.elapsedMs,usage:current.usage,queueCorrect}));
        console.log(`${scenario.suite}/${scenario.id}: ${results.at(-1)!.passed?'passed':'FAILED'} ${String(result.disposition)}`);
      }
    }
    const report=summarizeEvaluation(index.seed,results,'Deterministic model authored through real write tools and backend author/test/publish APIs; actual isolated Docker Python tasks, independent ExcelJS/DOCX parsing and authoritative SQLite queue queries. Browser authoring is separately covered by Playwright.',workflowStore.queues().length,duplicateRecords);
    report.packages=packages;
    report.method=evaluationMethod(report);
    const output=path.resolve(options.outputFile??'.agent-state/validation/workflows/evaluation-report.json');await mkdir(path.dirname(output),{recursive:true});await atomicReport(output,{...report,stateDirectory:options.keepState?cfg.stateDir:undefined});console.log(JSON.stringify({report:output,metrics:report.metrics}));return report;
  }finally{await app.close();if(!options.keepState)await rm(temporary,{recursive:true,force:true});}
}

export function evaluationMethod(report:BusinessEvaluation):Record<string,unknown>{
  const heldout=report.scenarios.filter(s=>s.suite.endsWith('heldout'));const development=report.scenarios.filter(s=>s.suite.endsWith('development'));
  const accuracy=(list:ScenarioEvaluation[])=>list.reduce((sum,s)=>sum+s.fieldsCorrect,0)/Math.max(1,list.reduce((sum,s)=>sum+s.fieldsTotal,0));
  return {evaluationDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baku'}).format(new Date(report.generatedAt)),timezone:'Asia/Baku',developmentScenarios:development.length,heldoutScenarios:heldout.length,heldoutComposition:{invoice:heldout.filter(s=>s.kind==='invoice').length,onboarding:heldout.filter(s=>s.kind==='onboarding').length,complaints:heldout.filter(s=>s.kind==='complaints').length},developmentExtractionAccuracy:accuracy(development),heldoutExtractionAccuracy:accuracy(heldout),scanPolicy:'Business truth is independent of document representation: the scanned invoice is valid and expected ready. The deterministic text parser cannot extract its nine facts, requests clarification, and is scored as false-blocked; those facts remain in extraction accuracy.',truthIsolation:'Structured truth is generated before rendering and is kept in the backend validation directory outside every agent mount.',verification:'Task manifests, independent ExcelJS/Word OOXML artifact parsing, protected artifact endpoint fingerprints and authoritative backend SQLite queue queries.',modelComparison:'Deterministic authoring fixture results are not live model-quality results; compare the separately executed general-agent report only for its actual selected scenarios.'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runBusinessEvaluation({keepState:process.argv.includes('--keep-state')}).then(report=>{if(report.metrics.passed!==report.metrics.scenarios)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
}
