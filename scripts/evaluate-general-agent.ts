/** Live comparison: a well-prompted general agent, same files/tools and boundary.
 * No deterministic model, answer keys, or catalog executable engine is supplied.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { canonicalHash, validatePackage } from '../server/workflow-validation.js';
import { catalogRecipes, createCatalogPackage, type CatalogKind } from '../catalog/catalog.js';
import { evaluateResult, evaluationMethod, pollEvaluation, summarizeEvaluation, uploadEvaluationFile, type FrozenTruth, type ScenarioEvaluation } from './evaluate-workflows.js';
import type { WorkflowCase, WorkflowPackage } from '../shared/workflow-types.js';
import { appError } from '../server/errors.js';
import { atomicReport } from './workflow-report.js';

const artifactContract:Record<CatalogKind,string>={
  invoice:'review.xlsx: row1 title, row2 fictional disclosure, row3 headers [Business key, Disposition, Quantity, Unit price AZN, Calculated total AZN, Findings], row4 actual evidence-backed values in those columns. On any non-ready finding create correction-letter.docx with the business key, fictional draft disclosure and specific requested corrections.',
  onboarding:'checklist.xlsx: row1 title, row2 fictional disclosure, row3 headers [Document, Provided, Business key, Disposition], rows4-7 respectively application/extract/authority/identification, Provided is a native boolean. application-packet.docx is always required and includes business key, fictional draft disclosure, conditional stamp reasoning and the employee signature check. On any non-ready finding create missing-information.docx and request representative identification specifically when missing.',
  complaints:'reconciliation.xlsx: row1 title, row2 fictional disclosure, row3 headers [Business key, Disposition, Charged AZN, Credit AZN, Recommendation], row4 values in those columns. response.docx includes business key, fictional draft disclosure, recommended credit and the actual distinct duplicate transaction IDs. timeline.json is an array of actual relevant evidence events.',
};
const findingTaxonomy='missing_invoice, missing_invoice_number, missing_supplier_id, missing_po_number, missing_currency, missing_bank, missing_sku, missing_quantity, missing_unit_price, missing_total, conflicting_field, invalid_numeric, unknown_supplier, bank_mismatch, currency_mismatch, unknown_po, supplier_po_mismatch, ambiguous_sku, excess_order_quantity, excess_delivery_quantity, price_mismatch, total_mismatch, duplicate_invoice, missing_application, missing_extract, missing_authority, missing_identification, missing_company_id, missing_company_name, missing_representative, missing_representative_id, missing_registration, missing_signer_role, missing_valid_until, company_conflict, representative_conflict, identification_conflict, insufficient_authority, expired_identification, missing_contract_stamp, registry_missing, registry_conflict, missing_complaint, missing_complaint_id, missing_account_id, missing_billing_period, missing_events, transaction_conflict, missing_usage_evidence, invalid_charge, bill_reconciliation, unknown_account, duplicate_resolution';

export async function generalAgentPackage(kind:CatalogKind):Promise<WorkflowPackage>{
  const pkg=await createCatalogPackage(kind);
  const step=pkg.steps[0]!;
  step.type='ai';delete step.script;
  step.instructions=`You are a careful general office investigation agent. Independently perform the employee's procedure from the supplied actual documents and read-only reference snapshots. You may use the same read, write, edit and bash tools, including Python libraries, as the workflow executor. No executable catalog procedure is provided. Read every relevant source and template. Do not infer missing facts, approve actions or mutate records. Explicitly distinguish safe business readiness from execution completion.\n${pkg.purpose}\nUse Decimal for all monetary checks. Use finding codes from this shared reporting taxonomy when applicable: ${findingTaxonomy}. Include source and location evidence for each finding. Preserve exact source formatting as strings in extracted fields (canonical invoice keys: invoice_number,supplier_id,po_number,currency,bank,sku,quantity,unit_price,total; onboarding extracted groups: application,extract,authority,identification; complaint keys: complaint_id,account_id,billing_period). For invoices add calculatedTotal; for complaints add creditRecommendation and chargedTotal. businessKey is supplier_id:invoice_number, application_id or complaint_id respectively. queueRecord must be the exact structured record recommended for backend employee review, with this shared schema: invoice {supplierId,invoiceNumber,poNumber,currency,amount:number,quantity:number}; onboarding {applicationId,companyId,representative,signatureCheck:'employee_required'}; complaint {complaintId,accountId,creditAmount:number,currency:'AZN',resolution:'credit_duplicate'|'explain_legitimate'}.\nArtifact contract, identical to the workflow evaluator: ${artifactContract[kind]}\nUse readable document formatting and independently reopen generated files before declaring completion. Finish with the required manifest. The evaluation will inspect actual files and structured results, not assistant prose.`;
  pkg.name=`General agent comparison of ${pkg.name}`;pkg.slug=`general-${pkg.slug}`;
  pkg.assets=Object.fromEntries(Object.entries(pkg.assets).filter(([name])=>!name.startsWith('scripts/')&&name!=='settings.json'));
  pkg.assumptions=['Live Azure general-agent comparison. No executable workflow engine asset provided. All company data and queues are synthetic.'];
  return validatePackage(pkg);
}

export async function runGeneralAgentComparison(options:{limit?:number;fixtureDir?:string;validationDir?:string;outputFile?:string}={}){
  if(!config.apiKey||!config.endpoint)throw new Error('Live general-agent evaluation requires configured Azure credentials. No deterministic comparison will be substituted.');
  const fixtureDir=path.resolve(options.fixtureDir??'catalog/fixtures');const validationDir=path.resolve(options.validationDir??'.agent-state/validation/workflows');
  const index=JSON.parse(await readFile(path.join(fixtureDir,'index.json'),'utf8')) as {seed:number;scenarios:{suite:string;id:string;kind:CatalogKind;files:{path:string}[]}[]};
  const scenarios=index.scenarios.filter(s=>s.suite.endsWith('heldout')).slice(0,options.limit??32);
  const temporary=await mkdtemp(path.join(os.tmpdir(),'workflow-live-general-agent-'));
  const cfg={...config,workspaceDir:path.join(temporary,'workspace'),stateDir:path.join(temporary,'state')};
  const {app,workflows,workflowStore}=await createApp(cfg,{skipRecovery:true});const results:ScenarioEvaluation[]=[];const runs:unknown[]=[];
  const setups=new Map<CatalogKind,{package:WorkflowPackage;draftId:string;revisionId:string;versionId?:string;error?:ReturnType<typeof appError>}>();
  let phase='setup';let activeScenario:unknown;let activeCaseId:string|undefined;let stopped=false;
  const output=path.resolve(options.outputFile??'.agent-state/validation/workflows/general-agent-report.json');await mkdir(path.dirname(output),{recursive:true});
  const save=async(status?:string,reason?:string)=>{
    const report=summarizeEvaluation(index.seed,results,`Live Azure model ${config.model}; one well-prompted AI investigation task; same synthetic files, policies, templates, four tools, Docker isolation, independent evaluator and backend approval boundary. No catalog executable Python asset or answer key was mounted.`,workflowStore.queues().length);
    report.baseline={status:status??(results.length===scenarios.length?'completed':'running'),reason:reason??`${results.length}/${scenarios.length} selected held-out scenarios evaluated; failures remain recorded.`};
    report.packages=[...setups.entries()].map(([kind,setup])=>({kind,packageHash:canonicalHash(setup.package),slug:setup.package.slug,draftId:setup.draftId,revisionId:setup.revisionId,workflowVersionId:setup.versionId}));
    report.method={...evaluationMethod(report),comparisonScope:'Same Azure deployment as live authoring, a prescribed general-agent AI task with the same files and reporting contract. Catalog fixture authoring itself is deterministic and must not be described as live generation.',setupFailures:[...setups.entries()].filter(([,setup])=>setup.error).map(([kind,setup])=>({kind,error:setup.error})),approvalCoverage:'Published comparison tasks use the real approval boundary; a failed development setup remains an unpublishable draft, whose held-out tests are graded with queueCorrect:null and cannot commit.',tokenAccounting:'Counts are the runtime-reported usage. A failed stream may have unknown partial usage; zero reported tokens on a failed task does not prove that the provider used no tokens.'};
    await atomicReport(output,{...report,model:config.model,selectedScenarios:scenarios.length,stateDirectory:cfg.stateDir,phase,activeScenario,runs});return report;
  };
  const readCaseArtifact=async(c:WorkflowCase,name:string)=>{const revision=c.revisions.at(-1)!;const artifact=revision.artifacts.find(a=>a.path===name);if(!artifact)throw new Error(`Missing ${name}`);const response=await app.inject({method:'GET',url:artifact.contentUrl});if(response.statusCode!==200)throw new Error(response.body);return response.rawPayload;};
  const onStop=()=>{stopped=true;if(activeCaseId)void workflows.stop(activeCaseId).catch(()=>{});};
  process.once('SIGINT',onStop);process.once('SIGTERM',onStop);
  await save();console.log(JSON.stringify({model:config.model,selectedScenarios:scenarios.length,report:output,stateDirectory:cfg.stateDir}));
  try{
    for(const scenario of scenarios){
      if(stopped)break;
      activeScenario={suite:scenario.suite,id:scenario.id};phase='running';await save();
      const truthData=JSON.parse(await readFile(path.join(validationDir,scenario.suite+'.json'),'utf8')) as {seed:number;truth:FrozenTruth[]};if(truthData.seed!==index.seed)throw new Error('Truth seed differs from fixture seed');const truth=truthData.truth.find(t=>t.id===scenario.id)!;
      const attachments=[];for(const file of scenario.files)attachments.push(await uploadEvaluationFile(app,path.join(fixtureDir,file.path)));
      if(!setups.has(scenario.kind)){
        phase='setup';await save();const pkg=await generalAgentPackage(scenario.kind);
        // Prescribe the well-prompted comparison task; do not give the agent the
        // workflow's executable code. Test it on separate development inputs and
        // pass the same real publish/review boundary before business cases.
        const recipe=catalogRecipes.find(r=>r.kind===scenario.kind)!;
        const sample=index.scenarios.find(s=>s.suite===recipe.sampleSuite&&s.id===recipe.sampleId)!;
        const sampleFiles=[];for(const file of sample.files)sampleFiles.push(await uploadEvaluationFile(app,path.join(fixtureDir,file.path)));
        const sampleTruth=JSON.parse(await readFile(path.join(validationDir,sample.suite+'.json'),'utf8')) as {truth:FrozenTruth[]};const expected=sampleTruth.truth.find(t=>t.id===sample.id)!;
        const draft=await workflows.createDraft(pkg.name);const revisionId=randomUUID();draft.revisions.push({id:revisionId,number:1,package:pkg,packageHash:canonicalHash(pkg),createdAt:new Date().toISOString(),changeSummary:'Application-owned general-agent comparison task; internal evaluation only.',testReports:[]});workflowStore.saveDraft(draft);
        const setup={package:pkg,draftId:draft.id,revisionId} as {package:WorkflowPackage;draftId:string;revisionId:string;versionId?:string;error?:ReturnType<typeof appError>};setups.set(scenario.kind,setup);await save();
        try{
          const tested=await workflows.test(draft.id,revisionId,{},sampleFiles,[{path:'validate.disposition',operator:'eq',value:expected.disposition}]);activeCaseId=tested.caseId;
          await pollEvaluation(()=>workflowStore.getCase(tested.caseId),c=>c.status!=='running',config.maxRunMs+30000);activeCaseId=undefined;
          await pollEvaluation(()=>workflowStore.getDraft(draft.id),d=>d.revisions[0]!.testReports[0]!.executionStatus!=='running');
          const testedCase=workflowStore.getCase(tested.caseId);const testedRevision=testedCase.revisions.at(-1)!;const testedResult=testedRevision.tasks.find(t=>t.stepId==='validate')?.result??{};
          const measuredSetup=await evaluateResult(sample.suite,sample.kind,expected,testedResult,name=>readCaseArtifact(testedCase,name),{executionCompleted:testedRevision.executionStatus==='completed',elapsedMs:testedRevision.elapsedMs,usage:testedRevision.usage});
          runs.push({setup:true,kind:scenario.kind,caseId:tested.caseId,error:testedRevision.error,usage:testedRevision.usage,elapsedMs:testedRevision.elapsedMs,evaluation:measuredSetup});
          if(!measuredSetup.passed)throw new Error(`Development setup failed independent evaluation: ${measuredSetup.failures.join('; ')}`);
          setup.versionId=workflows.publish(draft.id,revisionId,true,'Synthetic comparison employee').id;
        }catch(error){setup.error=appError(error);runs.push({setupFailure:true,kind:scenario.kind,error:setup.error});console.log(`${scenario.kind} development setup failed; grading all held-out inputs as unpublishable draft tests.`);await save();}
      }
      if(stopped)break;
      const setup=setups.get(scenario.kind)!;phase='running';await save();
      const caseId=setup.versionId?(await workflows.startPublished(setup.versionId,{},attachments,`General agent ${scenario.suite} ${scenario.id}`)).id:(await workflows.test(setup.draftId,setup.revisionId,{},attachments,[{path:'validate.disposition',operator:'eq',value:truth.disposition}])).caseId;
      activeCaseId=caseId;
      const completed=await pollEvaluation(()=>workflowStore.getCase(caseId),c=>c.status!=='running',config.maxRunMs+30000);activeCaseId=undefined;const revision=completed.revisions.at(-1)!;const result=revision.tasks.find(t=>t.stepId==='validate')?.result??{};
      phase='grading';await save();
      let queueCorrect:boolean|null=setup.versionId?(truth.disposition!=='ready'?workflowStore.queues().every(queue=>queue.caseId!==completed.id):false):null;
      if(setup.versionId&&truth.disposition==='ready'&&completed.status==='awaiting_review'){
        try{
          const approval=await workflows.approve(completed.id,revision.id,revision.resultHash!,'Synthetic comparison employee');const repeated=await workflows.approve(completed.id,revision.id,revision.resultHash!,'Synthetic comparison employee');
          const db=new DatabaseSync(path.join(cfg.stateDir,'workflows.sqlite'),{readOnly:true});try{const rows=db.prepare('SELECT data FROM queues WHERE destination=? AND business_key=?').all(approval.destination,approval.businessKey) as {data:string}[];queueCorrect=rows.length===1&&JSON.stringify(JSON.parse(rows[0]!.data).record)===JSON.stringify(result.queueRecord)&&approval.queueRecordId===repeated.queueRecordId;}finally{db.close();}
        }catch(error){queueCorrect=false;runs.push({approvalFailure:true,suite:scenario.suite,id:scenario.id,error:appError(error)});}
      }
      const measured=await evaluateResult(scenario.suite,scenario.kind,truth,result,name=>readCaseArtifact(completed,name),{executionCompleted:revision.executionStatus==='completed',elapsedMs:revision.elapsedMs,usage:revision.usage,queueCorrect});results.push(measured);runs.push({suite:scenario.suite,id:scenario.id,caseId:completed.id,revisionId:revision.id,error:revision.error,packageHash:canonicalHash(setup.package),mode:setup.versionId?'published_business_case':'draft_test_setup_failed'});
      await save();console.log(`${scenario.suite}/${scenario.id}: ${measured.passed?'passed':'FAILED'}; ${revision.usage.totalTokens} tokens, ${revision.elapsedMs}ms`);
    }
    phase=stopped?'interrupted':'completed';activeScenario=undefined;const report=await save(stopped?'interrupted':undefined,stopped?'Stopped; completed outputs and grading retained. No mutations are repeated automatically.':undefined);console.log(JSON.stringify({report:output,metrics:report.metrics}));return report;
  }catch(error){phase='failed';await save('failed',(error as Error).message);throw error;}finally{process.removeListener('SIGINT',onStop);process.removeListener('SIGTERM',onStop);await app.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const raw=process.argv.find(arg=>arg.startsWith('--limit='));const limit=raw?Number(raw.split('=')[1]):undefined;
  if(limit!==undefined&&(!Number.isInteger(limit)||limit<1||limit>32))throw new Error('--limit must be an integer from 1 to 32');
  runGeneralAgentComparison({limit}).then(report=>{if(report.metrics.passed!==report.metrics.scenarios)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
}
