import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, rm, writeFile, cp, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { catalogRecipes, createCatalogPackage } from '../catalog/catalog.js';
import { createCatalogModel } from '../catalog/test-model.js';
import { validatePackage, canonicalHash } from '../server/workflow-validation.js';
import { evaluateResult, type FrozenTruth } from '../scripts/evaluate-workflows.js';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { extractedFacts, semanticField, factsEqual, calculatedField, readXlsxCells } from '../scripts/workflow-grading.js';

const execute=promisify(execFile);
const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
let python=process.env.WORKFLOW_TEST_PYTHON??bundled;
try{await access(python);}catch{python='python3';}
let libraries=false;
try{await execute(python,['-c','import docx, openpyxl, pypdf, reportlab']);libraries=true;}catch{}

test('catalog candidates declare validated generic pipelines, policy references and exact queue boundaries',async()=>{
  for(const recipe of catalogRecipes){
    const pkg=validatePackage(await createCatalogPackage(recipe.kind));assert.equal(pkg.synthetic,true);assert.equal(pkg.questions.length,0);
    assert.deepEqual(pkg.steps.map(step=>step.type),['python','review','queue']);assert.equal(pkg.rules.every(rule=>pkg.references.some(ref=>ref.path===rule.source)),true);
    assert.match(pkg.approval,/exact case revision/);assert.equal(pkg.assets['scripts/validate.py'].includes('.agent-state'),false);
    assert.equal(pkg.assets['scripts/validate.py'].includes('validation/workflows'),false);
  }
});

test('independent grading measures semantic facts without optional-path or decimal-format bias',()=>{
  const result={extractedFields:{invoice_number:{value:'INV-1',evidence:[]},quantity:{value:8},unit_price:'70',total:'560.00',calculatedTotal:{value:560}}};
  const facts=extractedFacts(result);assert.equal(semanticField(facts,'invoice_number'),'INV-1');assert.equal(factsEqual('quantity','8',semanticField(facts,'quantity')),true);assert.equal(factsEqual('unit_price','70.00',semanticField(facts,'unit_price')),true);assert.equal(factsEqual('unit_price','70.00','70.001'),false);
  assert.equal(factsEqual('total','560.00',NaN),false);assert.equal(factsEqual('total','560.00','Infinity'),false);assert.equal(calculatedField(result,'calculatedTotal'),560);
  assert.equal(semanticField(extractedFacts({invoice:{invoiceNumber:'INV-1'}}),'invoice_number'),'INV-1');assert.equal(factsEqual('representative_id','001',1),false);
});

test('independent OOXML cells agree with supplied workbook facts',async()=>{
  const sheet=readXlsxCells(await readFile('catalog/fixtures/invoice-development/invoice-01/purchase-orders.xlsx'));assert.equal(sheet.getCell('A2').value,'PO-100');assert.equal(sheet.getCell('D2').value,10);assert.equal(sheet.getCell('E2').value,70);assert.equal(sheet.rowCount,3);
});

test('deterministic authoring writes via a real tool request and refinement preserves workflow kind',async()=>{
  const first=await createCatalogModel().respond([{role:'user',content:'Workflow authoring, draft demo. Create the first draft.\nTeach a supplier invoice review; tolerance AZN 0.01.'}],[],new AbortController().signal,async()=>{});
  const tool=first.output[0];assert.equal(tool.type,'function_call');if(tool.type!=='function_call')return;
  const args=JSON.parse(tool.arguments) as {path:string;content:string};assert.equal(tool.name,'write');assert.equal(args.path,'/workspace/output/package.json');const old=validatePackage(JSON.parse(args.content));
  const input:ResponseInputItem[]=[{role:'user',content:'Workflow authoring, draft demo. Create the first draft.\nTeach a supplier invoice review; tolerance AZN 0.01.'},{role:'user',content:`Workflow authoring, draft demo. Previous valid revision: ${JSON.stringify(old)}\nSet the total tolerance AZN 0.00.`}];
  const refined=await createCatalogModel().respond(input,[],new AbortController().signal,async()=>{});const call=refined.output[0];assert.equal(call.type,'function_call');if(call.type!=='function_call')return;
  const next=validatePackage(JSON.parse(JSON.parse(call.arguments).content));assert.equal(next.slug,old.slug);assert.notEqual(canonicalHash(next),canonicalHash(old));assert.equal(JSON.parse(next.assets['settings.json']).totalTolerance,'0.00');assert.equal(JSON.parse(old.assets['settings.json']).totalTolerance,'0.01');
});

test('development business documents independently reconcile structured findings and XLSX/DOCX artifacts',{skip:!libraries,timeout:120000},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'workflow-business-unit-'));
  const inputs=path.join(temporary,'fixtures');const validation=path.join(temporary,'backend-only-validation');
  try{
    await execute(python,['scripts/generate-workflow-fixtures.py','--output-dir',inputs,'--validation-dir',validation]);
    for(const recipe of catalogRecipes){
      const pkg=validatePackage(await createCatalogPackage(recipe.kind));const packageDir=path.join(temporary,'packages',recipe.kind);await mkdir(packageDir,{recursive:true});
      for(const [filename,content] of Object.entries(pkg.assets)){const target=path.join(packageDir,filename);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
      const suite=recipe.kind+'-development';const truth=JSON.parse(await readFile(path.join(validation,suite+'.json'),'utf8')) as {truth:FrozenTruth[]};
      for(const answer of truth.truth){
        const output=path.join(temporary,'outputs',suite,answer.id);await mkdir(output,{recursive:true});const start=Date.now();
        await execute(python,[path.join(packageDir,'scripts/validate.py')],{env:{...process.env,WORKFLOW_INPUTS:path.join(inputs,suite,answer.id),WORKFLOW_REFERENCES:path.join(inputs,suite,answer.id),WORKFLOW_OUTPUTS:output,WORKFLOW_PACKAGE:packageDir},timeout:15000});
        const result=JSON.parse(await readFile(path.join(output,'result.json'),'utf8')) as Record<string,unknown>;
        const evaluated=await evaluateResult(suite,recipe.kind,answer,result,name=>readFile(path.join(output,name)),{elapsedMs:Date.now()-start});
        assert.deepEqual(evaluated.failures,[],`${suite}/${answer.id}: ${evaluated.failures.join('; ')}`);
      }
    }
  }finally{await rm(temporary,{recursive:true,force:true});}
});

test('refining a total tolerance changes executable business behavior on a development control document',{skip:!libraries,timeout:60000},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'workflow-rule-refinement-'));
  try{
    const inputs=path.join(temporary,'inputs');await cp('catalog/fixtures/invoice-development/invoice-01',inputs,{recursive:true});
    const script=`from reportlab.pdfgen import canvas\nc=canvas.Canvas(${JSON.stringify(path.join(inputs,'invoice.pdf'))})\nfields=${JSON.stringify(['Invoice number: INV-DEV-CONTROL','Supplier id: SUP-001','Purchase order: PO-100','Currency: AZN','Bank: AZ21DEMO000000000000001','SKU: RTR-10','Quantity: 8','Unit price: 70.00','Total: 560.01'])}\nfor i,line in enumerate(fields): c.drawString(60,740-i*24,line)\nc.save()\n`;
    await execute(python,['-c',script]);
    for(const tolerance of ['0.01','0.00']){
      const pkg=await createCatalogPackage('invoice',{totalTolerance:tolerance});const packageDir=path.join(temporary,'package-'+tolerance);const output=path.join(temporary,'output-'+tolerance);await mkdir(packageDir,{recursive:true});await mkdir(output,{recursive:true});
      for(const [filename,content] of Object.entries(pkg.assets)){const target=path.join(packageDir,filename);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
      await execute(python,[path.join(packageDir,'scripts/validate.py')],{env:{...process.env,WORKFLOW_INPUTS:inputs,WORKFLOW_REFERENCES:inputs,WORKFLOW_OUTPUTS:output,WORKFLOW_PACKAGE:packageDir}});
      const result=JSON.parse(await readFile(path.join(output,'result.json'),'utf8'));assert.equal(result.disposition,tolerance==='0.01'?'ready':'blocked');if(tolerance==='0.00')assert.equal(result.findings[0].code,'total_mismatch');
    }
  }finally{await rm(temporary,{recursive:true,force:true});}
});

test('invoice comparisons preserve subcent precision and safely clarify non-finite numeric inputs',{skip:!libraries,timeout:60000},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'workflow-money-precision-'));
  try{
    const pkg=await createCatalogPackage('invoice');const packageDir=path.join(temporary,'package');
    for(const [filename,content] of Object.entries(pkg.assets)){const target=path.join(packageDir,filename);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
    const cases=[
      {name:'subcent-price',quantity:'8',price:'70.001',total:'560.008',disposition:'blocked',code:'price_mismatch'},
      {name:'subcent-total',quantity:'8',price:'70.00',total:'560.014',disposition:'blocked',code:'total_mismatch'},
      ...['NaN','Infinity','-Infinity'].flatMap(value=>['quantity','price','total'].map(field=>({name:`${field}-${value}`,quantity:field==='quantity'?value:'8',price:field==='price'?value:'70.00',total:field==='total'?value:'560.00',disposition:'clarification',code:'invalid_numeric'}))),
    ];
    for(const scenario of cases){
      const inputs=path.join(temporary,scenario.name,'inputs');const output=path.join(temporary,scenario.name,'output');await cp('catalog/fixtures/invoice-development/invoice-01',inputs,{recursive:true});await mkdir(output,{recursive:true});
      const fields=['Invoice number: INV-DEV-PRECISION','Supplier id: SUP-001','Purchase order: PO-100','Currency: AZN','Bank: AZ21DEMO000000000000001','SKU: RTR-10',`Quantity: ${scenario.quantity}`,`Unit price: ${scenario.price}`,`Total: ${scenario.total}`];
      await execute(python,['-c',`from reportlab.pdfgen import canvas\nc=canvas.Canvas(${JSON.stringify(path.join(inputs,'invoice.pdf'))})\nfor i,line in enumerate(${JSON.stringify(fields)}): c.drawString(60,740-i*24,line)\nc.save()\n`]);
      await execute(python,[path.join(packageDir,'scripts/validate.py')],{env:{...process.env,WORKFLOW_INPUTS:inputs,WORKFLOW_REFERENCES:inputs,WORKFLOW_OUTPUTS:output,WORKFLOW_PACKAGE:packageDir},timeout:10000});
      const manifest=JSON.parse(await readFile(path.join(output,'manifest.json'),'utf8'));assert.equal(manifest.result.disposition,scenario.disposition,scenario.name);assert.deepEqual(manifest.result.findings.map((finding:{code:string})=>finding.code),[scenario.code],scenario.name);assert.ok(manifest.artifacts.some((artifact:{path:string})=>artifact.path==='correction-letter.docx'));
    }
  }finally{await rm(temporary,{recursive:true,force:true});}
});

test('missing required business snapshots produce specific clarification letters instead of task failures',{skip:!libraries,timeout:60000},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'workflow-missing-reference-'));
  try{
    for(const scenario of [{kind:'invoice' as const,source:'purchase-orders.xlsx',sample:'invoice-development/invoice-01',letter:'correction-letter.docx'},{kind:'invoice' as const,source:'supplier-records.sqlite',sample:'invoice-development/invoice-01',letter:'correction-letter.docx'},{kind:'onboarding' as const,source:'registry.sqlite',sample:'onboarding-development/onboarding-01',letter:'missing-information.docx'},{kind:'complaints' as const,source:'accounts.sqlite',sample:'complaints-development/complaints-01',letter:'response.docx'}]){
      const pkg=await createCatalogPackage(scenario.kind);const base=path.join(temporary,scenario.source);const inputs=path.join(base,'inputs');const output=path.join(base,'output');const packageDir=path.join(base,'package');await cp(path.join('catalog/fixtures',scenario.sample),inputs,{recursive:true});await unlink(path.join(inputs,scenario.source));await mkdir(output,{recursive:true});
      for(const [filename,content] of Object.entries(pkg.assets)){const target=path.join(packageDir,filename);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
      await execute(python,[path.join(packageDir,'scripts/validate.py')],{env:{...process.env,WORKFLOW_INPUTS:inputs,WORKFLOW_REFERENCES:inputs,WORKFLOW_OUTPUTS:output,WORKFLOW_PACKAGE:packageDir},timeout:10000});
      const manifest=JSON.parse(await readFile(path.join(output,'manifest.json'),'utf8'));assert.equal(manifest.result.disposition,'clarification',scenario.source);assert.equal(manifest.result.findings[0].code,'missing_reference');assert.match(manifest.result.findings[0].message,new RegExp(scenario.source.replace('.','\\.')));assert.ok(manifest.artifacts.some((artifact:{path:string})=>artifact.path===scenario.letter));
    }
  }finally{await rm(temporary,{recursive:true,force:true});}
});
