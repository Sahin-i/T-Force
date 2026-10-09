import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonSchema, WorkflowPackage } from '../shared/workflow-types.js';
import { assertJsonBudget, canonicalHash, conditionMatches, getValue, safeAssetPath, validateJsonSchema, validatePackage } from '../server/workflow-validation.js';

function pkg():WorkflowPackage{return {schemaVersion:1,name:'Generic fixture',slug:'generic-fixture',purpose:'Validate package execution contracts.',inputs:[],references:[{path:'policy.txt',title:'Fictional policy',fictional:true}],rules:[{id:'rule',text:'Employee review is required.',source:'policy.txt'}],deliverables:['Review'],exceptions:[],approval:'Employee approval',questions:[],assumptions:[],synthetic:true,assets:{'policy.txt':'Fictional policy','check.py':'# fixture'},steps:[{id:'check',type:'python',title:'Check',instructions:'Validate records',inputs:['inputs'],script:'check.py',outputSchema:{type:'object',properties:{ready:{type:'boolean'},record:{type:'object'},key:{type:'string'}},required:['ready','record','key'],additionalProperties:false},artifacts:[{path:'review.txt',label:'Review',required:true}]},{id:'review',type:'review',title:'Review',instructions:'Review verified records',inputs:['check'],outputSchema:{type:'object'},artifacts:[]},{id:'queue',type:'queue',title:'Queue',instructions:'Commit after review',inputs:['check'],outputSchema:{type:'object'},artifacts:[],destination:'accounting',businessKeyPath:'check.key',recordPath:'check.record'}]};}

test('packages reject execution graphs the interpreter cannot finish before review',()=>{
  const afterReview=pkg();afterReview.steps.splice(2,0,{...structuredClone(afterReview.steps[0]),id:'late-task'});assert.throws(()=>validatePackage(afterReview),{code:'INVALID_PACKAGE'});
  const multiple=pkg();multiple.steps.splice(2,0,{...structuredClone(multiple.steps[1]),id:'second-review'});assert.throws(()=>validatePackage(multiple),{code:'INVALID_PACKAGE'});
  const unmatched=pkg();unmatched.steps[1].condition={stepId:'check',path:'ready',operator:'eq',value:true};assert.throws(()=>validatePackage(unmatched),{code:'INVALID_PACKAGE'});
  const matched=pkg();matched.steps[1].condition={stepId:'check',path:'ready',operator:'eq',value:true};matched.steps[2].condition=structuredClone(matched.steps[1].condition);assert.equal(validatePackage(matched).steps.length,3);
});

test('review and queue steps cannot declare unproduced artifacts or depend on unverified review results',()=>{
  for(const index of [1,2]){const candidate=pkg();candidate.steps[index].artifacts=[{path:'never-produced.txt',label:'Missing backend output',required:true}];assert.throws(()=>validatePackage(candidate),{code:'INVALID_PACKAGE'});}
  const queueFromReview=pkg();queueFromReview.steps[2].recordPath='review.record';assert.throws(()=>validatePackage(queueFromReview),{code:'INVALID_PACKAGE'});
  const conditionFromReview=pkg();conditionFromReview.steps[2].condition={stepId:'review',path:'ready',operator:'eq',value:true};assert.throws(()=>validatePackage(conditionFromReview),{code:'INVALID_PACKAGE'});
});

test('conditions require explicit comparisons and absent results never satisfy a negative business check',()=>{
  const candidate=pkg();candidate.steps[1].condition={stepId:'check',path:'ready',operator:'ne'};candidate.steps[2].condition=structuredClone(candidate.steps[1].condition);assert.throws(()=>validatePackage(candidate),{code:'INVALID_PACKAGE'});
  assert.equal(conditionMatches({stepId:'missing',path:'ready',operator:'ne',value:false},{}),false);
  assert.equal(conditionMatches({stepId:'check',path:'missing',operator:'ne',value:false},{check:{ready:true}}),false);
  assert.equal(conditionMatches({stepId:'check',path:'ready',operator:'eq',value:true},{check:{ready:true}}),true);
  assert.equal(conditionMatches({stepId:'check',path:'ready',operator:'ne',value:false},{check:{ready:true}}),true);
});

test('source references allow web links and reject active or local-file URL schemes',()=>{
  const valid=pkg();valid.references[0].sourceUrl='https://example.com/policy';assert.equal(validatePackage(valid).references[0].sourceUrl,valid.references[0].sourceUrl);
  for(const url of ['javascript:alert(1)','file:///private/records','data:text/html,example']){const candidate=pkg();candidate.references[0].sourceUrl=url;assert.throws(()=>validatePackage(candidate),{code:'INVALID_PACKAGE'});}
});

test('duplicate rules, references, artifacts and reserved identifiers fail before execution',()=>{
  const rules=pkg();rules.rules.push(structuredClone(rules.rules[0]));assert.throws(()=>validatePackage(rules),{code:'INVALID_PACKAGE'});
  const refs=pkg();refs.references.push(structuredClone(refs.references[0]));assert.throws(()=>validatePackage(refs),{code:'INVALID_PACKAGE'});
  const artifacts=pkg();artifacts.steps[0].artifacts.push(structuredClone(artifacts.steps[0].artifacts[0]));assert.throws(()=>validatePackage(artifacts),{code:'INVALID_PACKAGE'});
  const reserved=pkg();reserved.steps[0].id='constructor';reserved.steps[1].inputs=['constructor'];reserved.steps[2].inputs=['constructor'];reserved.steps[2].businessKeyPath='constructor.key';reserved.steps[2].recordPath='constructor.record';assert.throws(()=>validatePackage(reserved),{code:'INVALID_PACKAGE'});
});

test('contradictory output schemas are diagnosed as invalid packages',()=>{
  const undeclared=pkg();undeclared.steps[0].outputSchema.required!.push('undeclared');assert.throws(()=>validatePackage(undeclared),{code:'INVALID_PACKAGE'});
  const bounds=pkg();bounds.steps[0].outputSchema.properties!.count={type:'number',minimum:10,maximum:1};assert.throws(()=>validatePackage(bounds),{code:'INVALID_PACKAGE'});
  assert.throws(()=>validateJsonSchema({toString:'extra'},{type:'object',properties:{},additionalProperties:false}),{code:'INVALID_TASK_RESULT'});
});

test('JSON and path budgets reject excessive nesting and special object keys without stack overflow',()=>{
  let schema:JsonSchema={type:'string'};for(let i=0;i<40;i++)schema={type:'object',properties:{nested:schema}};
  const deep=pkg();deep.steps[0].outputSchema=schema;assert.throws(()=>validatePackage(deep),{code:'JSON_LIMIT'});assert.throws(()=>canonicalHash(deep),{code:'JSON_LIMIT'});
  assert.throws(()=>assertJsonBudget(JSON.parse('{"constructor":true}')),{code:'INVALID_PACKAGE'});
  assert.throws(()=>assertJsonBudget(Array.from({length:100001},()=>0)),{code:'JSON_LIMIT'});
  assert.throws(()=>assertJsonBudget(JSON.parse('{"amount":1e999}')),{code:'INVALID_TASK_RESULT'});
  assert.throws(()=>safeAssetPath(Array.from({length:17},()=> 'nested').join('/')),{code:'UNSAFE_PACKAGE_PATH'});
  assert.equal(canonicalHash({b:2,a:1}),canonicalHash({a:1,b:2}));
});

test('conditions and enums compare JSON objects independently of property insertion order',()=>{
  const actual={currency:'AZN',amount:560};const expected={amount:560,currency:'AZN'};
  assert.equal(conditionMatches({stepId:'check',path:'record',operator:'eq',value:expected},{check:{record:actual}}),true);
  assert.equal(conditionMatches({stepId:'check',path:'record',operator:'ne',value:expected},{check:{record:actual}}),false);
  assert.doesNotThrow(()=>validateJsonSchema(actual,{type:'object',enum:[expected]}));
  assert.equal(conditionMatches({stepId:'check',path:'rows',operator:'eq',value:[1,2]},{check:{rows:[2,1]}}),false);
});

test('only explicit JSON properties count as business evidence',()=>{
  for(const property of ['toString','valueOf','hasOwnProperty']){
    assert.equal(getValue({check:{}},`check.${property}`),undefined);
    assert.equal(conditionMatches({stepId:'check',path:property,operator:'exists'},{check:{}}),false);
  }
  assert.equal(getValue({check:{toString:'actual source value'}},'check.toString'),'actual source value');
});

test('file and directory collisions and the reserved completion manifest fail before execution',()=>{
  for(const reversed of [false,true]){
    const candidate=pkg();candidate.assets=reversed?{'assets/policy.txt':'policy',assets:'file','check.py':'# fixture'}:{assets:'file','assets/policy.txt':'policy','check.py':'# fixture'};
    candidate.references[0].path='assets/policy.txt';candidate.rules[0].source='assets/policy.txt';assert.throws(()=>validatePackage(candidate),{code:'INVALID_PACKAGE'});
  }
  for(const relative of ['manifest.json','manifest.json/report.txt']){
    const candidate=pkg();candidate.steps[0].artifacts[0].path=relative;assert.throws(()=>validatePackage(candidate),{code:'INVALID_PACKAGE'});
  }
  const candidate=pkg();candidate.steps[0].artifacts.push({path:'review.txt/detail.txt',label:'Impossible nested report',required:true});assert.throws(()=>validatePackage(candidate),{code:'INVALID_PACKAGE'});
});
