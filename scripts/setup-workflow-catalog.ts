/** Reproducible live setup: every write uses the employee's actual UI. */
import { chromium, expect, type Page } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { catalogRecipes,createCatalogPackage } from '../catalog/catalog.js';
import type { PublishedWorkflow,WorkflowDraft,WorkflowCase } from '../shared/workflow-types.js';

const baseURL=process.env.CATALOG_APP_URL??'http://127.0.0.1:3001';
const cache=path.join(os.homedir(),'Library/Caches/ms-playwright');
const cached=existsSync(cache)?readdirSync(cache).filter(n=>/^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n=>path.join(cache,n,'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find(existsSync):undefined;
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH??cached});
const page=await browser.newPage({baseURL,viewport:{width:1500,height:1080}});page.setDefaultTimeout(20000);
const output=path.resolve('catalog/published');await mkdir(output,{recursive:true});await mkdir(path.resolve('catalog/setup'),{recursive:true});await mkdir(path.resolve('test-results/catalog-live'),{recursive:true});
const setup:unknown[]=[];
async function readDraft(id:string):Promise<WorkflowDraft>{const response=await page.request.get(`/api/workflow-drafts/${id}`);if(!response.ok())throw new Error(await response.text());return response.json();}
async function waitDraft(id:string,count:number){
  for(let i=0;i<900;i++){const d=await readDraft(id);if(d.status!=='authoring'&&d.revisions.length>=count)return d;if(d.status==='failed')throw new Error(`Live authoring failed: ${d.error?.code}: ${d.error?.message}`);if(i%30===0)console.log(`Waiting for live author ${id}: ${d.status}`);await new Promise(r=>setTimeout(r,1000));}throw new Error('Live authoring exceeded 15 minutes. The saved draft remains available.');
}
async function upload(page:Page,selector:string,files:string[]){await page.locator(selector).setInputFiles(files);await expect(page.locator(selector).locator('..').locator('.wf-file-chip')).toHaveCount(files.length,{timeout:20000}).catch(async()=>{await expect(page.locator('.wf-file-chip')).toHaveCount(files.length,{timeout:20000});});}
try{
  await page.goto('/');const health=await(await page.request.get('/api/health')).json();console.log(`Catalog setup through actual UI; backend model ${health.model}.`);
  for(const recipe of catalogRecipes){
    const existing:PublishedWorkflow[]=(await(await page.request.get('/api/workflows')).json());const prior=existing.find(v=>v.package.slug===recipe.slug);
    if(prior&&!process.argv.includes('--new-versions')){console.log(`Already published ${recipe.name}, version ${prior.version}.`);continue;}
    console.log(`Teaching ${recipe.name}.`);
    const pkg=await createCatalogPackage(recipe.kind);
    if(recipe.kind==='invoice'){
      pkg.assets['settings.json']=JSON.stringify({totalTolerance:'0.02'});
      pkg.questions=['The supplied policy specifies AZN 0.01, while this provisional template uses AZN 0.02. Which total tolerance governs?'];
    }
    const template=path.resolve('catalog/setup',`${recipe.kind}-template.json`);await writeFile(template,JSON.stringify(pkg,null,2));
    const fixtureDir=path.resolve('catalog/fixtures',recipe.sampleSuite,recipe.sampleId);
    const index=JSON.parse(await readFile(path.resolve('catalog/fixtures/index.json'),'utf8')) as {scenarios:{suite:string;id:string;files:{path:string}[]}[]};
    const scenario=index.scenarios.find(s=>s.suite===recipe.sampleSuite&&s.id===recipe.sampleId)!;const samples=scenario.files.map(f=>path.resolve('catalog/fixtures',f.path));
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Create workflow',exact:true}).click();
    await page.getByRole('button',{name:'New workflow',exact:true}).click();
    await upload(page,'.wf-author-composer input[type=file]',[template,...samples]);
    const request=`${recipe.procedure}\nAn employee-supplied executable template is attached as ${recipe.kind}-template.json. Inspect its top-level metadata and relevant document facts without printing the scripts or full package. Use this supplied template as the starting draft: copy it intact to /workspace/output/package.json with Python or bash after inspection. Preserve every executable asset; do not rewrite its Python engine or print large outputs. Keep tool output under 1000 characters. ${recipe.kind==='invoice'?'The provisional template tolerance conflicts with the uploaded policy; retain its explicit clarification question until I answer it.':''}`;
    await page.getByRole('textbox',{name:'Describe or refine a workflow'}).fill(request);
    const start=page.waitForResponse(r=>r.request().method()==='POST'&&/\/workflow-drafts\/[^/]+\/messages$/.test(r.url()));const started=Date.now();await page.getByRole('button',{name:'Generate workflow',exact:true}).click();const response=await start;if(!response.ok())throw new Error(await response.text());
    const draftId=new URL(response.url()).pathname.split('/')[3];let d=await waitDraft(draftId,1);
    const refinement=recipe.kind==='invoice'?'The authoritative tolerance is AZN 0.01. Preserve the entire previous package except set assets["settings.json"] totalTolerance to "0.01" and clear the answered questions. Keep all supplier, quantity, price, currency and bank checks. Use the provided previous package and write the complete updated package.json with a short Python command; do not rewrite or print the engine. Summarize this executable behavior change.':recipe.kind==='onboarding'?'Preserve the executable package. Refine the human review instructions to explicitly require checking original authority and signature authenticity before the employee approves; an unstamped electronic extract remains acceptable when registry data agrees. Write the updated package.json, and summarize the review change. Do not print or rewrite the engine.':'Preserve the executable package. Refine the human review instructions to explicitly require checking distinct transaction IDs and the recommended credit before the employee approves the local resolution entry. Write the updated package.json and summarize the review change. Do not print or rewrite the engine.';
    await page.getByRole('textbox',{name:'Describe or refine a workflow'}).fill(refinement);await page.getByRole('button',{name:'Refine workflow',exact:true}).click();d=await waitDraft(draftId,2);
    await page.getByRole('button',{name:'Run sample test',exact:true}).click();await page.getByRole('dialog').locator('input[type=file]').setInputFiles(samples);await expect(page.getByRole('dialog').locator('.wf-file-chip')).toHaveCount(samples.length);
    const disposition=recipe.kind==='invoice'?'blocked':recipe.kind==='onboarding'?'clarification':'ready';await page.getByRole('dialog').locator('details').filter({has:page.getByRole('textbox',{name:'Test assertions JSON'})}).locator('summary').click();await page.getByRole('textbox',{name:'Test assertions JSON'}).fill(JSON.stringify([{path:'validate.disposition',operator:'eq',value:disposition},{path:'validate.businessKey',operator:'exists'}]));
    const testing=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/workflow-drafts/${draftId}/test`));await page.getByRole('button',{name:'Run sample',exact:true}).click();const test=await(await testing).json();
    for(let i=0;i<120;i++){const c:WorkflowCase=await(await page.request.get(`/api/cases/${test.caseId}`)).json();if(c.status!=='running')break;await new Promise(r=>setTimeout(r,1000));}
    await page.getByRole('button',{name:'Back to draft review',exact:true}).click();await expect(page.getByText('Passed all specified assertions.',{exact:true})).toBeVisible({timeout:20000});
    await page.screenshot({path:path.resolve('test-results/catalog-live',`${recipe.kind}-review.png`),fullPage:true});
    await page.getByRole('checkbox',{name:'I reviewed the workflow and its sample result.',exact:true}).check();const publishing=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/workflow-drafts/${draftId}/publish`));await page.getByRole('button',{name:'Publish workflow',exact:true}).click();const publishedResponse=await publishing;if(!publishedResponse.ok())throw new Error(await publishedResponse.text());const version:PublishedWorkflow=await publishedResponse.json();
    // Export from the backend's immutable, UI-published version, with provenance.
    const exported=await(await page.request.get(`/api/workflows/${version.id}/export`)).json();await writeFile(path.join(output,`${recipe.kind}.json`),JSON.stringify(exported,null,2));
    const runs=d.messages.filter(m=>m.runId&&m.role==='assistant').map(m=>m.runId);const measured=[];for(const id of runs)measured.push(await(await page.request.get(`/api/runs/${id}`)).json());setup.push({kind:recipe.kind,draftId,versionId:version.id,packageHash:version.packageHash,elapsedMs:Date.now()-started,runs:measured,fixture:fixtureDir});await writeFile(path.join(output,'setup-report.json'),JSON.stringify({model:health.model,synthetic:true,authoring:'Actual conversational UI with employee-supplied executable templates and real model inspection/refinement',workflows:setup},null,2));console.log(`Published ${version.name} v${version.version}; ${Date.now()-started}ms.`);
  }
  await page.getByRole('button',{name:'Catalog',exact:true}).click().catch(()=>{});await page.screenshot({path:path.resolve('test-results/catalog-live/catalog.png'),fullPage:true});console.log('Catalog setup finished.');
}finally{await browser.close();}
