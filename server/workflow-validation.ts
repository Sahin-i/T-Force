import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonSchema, WorkflowCondition, WorkflowPackage } from '../shared/workflow-types.js';
import { HarnessError } from './errors.js';

export function assertJsonBudget(value:unknown):void {
  const stack:{value:unknown;depth:number}[]=[{value,depth:0}];let nodes=0;
  while(stack.length){const item=stack.pop()!;if(++nodes>100000||item.depth>32)throw new HarnessError('JSON_LIMIT','Structured workflow data exceeds its nesting or item limit.',413);if(typeof item.value==='number'&&!Number.isFinite(item.value))throw new HarnessError('INVALID_TASK_RESULT','Structured workflow numbers must be finite.',400);if(item.value&&typeof item.value==='object')for(const [key,child] of Object.entries(item.value)){if(['__proto__','prototype','constructor'].includes(key))throw new HarnessError('INVALID_PACKAGE','Reserved object keys are not permitted.',400);stack.push({value:child,depth:item.depth+1});}}
}
export function canonicalHash(value: unknown): string {
  assertJsonBudget(value);
  function ordered(v: unknown): unknown { if(Array.isArray(v))return v.map(ordered);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,ordered(x)]));return v; }
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
/** JSON object key order is irrelevant; array order and explicit null remain significant. */
export function jsonValuesEqual(left:unknown,right:unknown):boolean {
  if(left===undefined||right===undefined)return false;
  if(left===right)return true;
  if(!left||!right||typeof left!=='object'||typeof right!=='object')return false;
  return canonicalHash(left)===canonicalHash(right);
}
export function safeAssetPath(value: string): string {
  if(!value||value.length>512||value.split('/').length>16||value.startsWith('/')||value.includes('\\')||value.includes(':')||value.includes('\0')||value.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||!/^[a-zA-Z0-9_ .\-/]+$/.test(value))throw new HarnessError('UNSAFE_PACKAGE_PATH',`Unsafe package path: ${value}`,400);
  return value;
}
export function getValue(value: unknown, dotted: string): unknown {
  if(!dotted)return value;
  return dotted.split('.').reduce<unknown>((v,key)=>v&&typeof v==='object'&&Object.hasOwn(v,key)&&!['__proto__','prototype','constructor'].includes(key)?(v as Record<string,unknown>)[key]:undefined,value);
}
export function conditionMatches(condition: WorkflowCondition|undefined, results: Record<string,unknown>): boolean {
  if(!condition)return true;
  const actual=getValue(results[condition.stepId],condition.path);
  if(condition.operator==='exists')return actual!==undefined&&actual!==null;
  if(actual===undefined)return false;
  const equal=jsonValuesEqual(actual,condition.value);
  return condition.operator==='eq'?equal:!equal;
}
export function validateJsonSchema(value: unknown,schema: JsonSchema,label='result',depth=0): void {
  if(!depth)assertJsonBudget(value);
  const fail=(detail:string):never=>{throw new HarnessError('INVALID_TASK_RESULT',`${label}: ${detail}`,400);};
  if(schema.enum&&!schema.enum.some(v=>jsonValuesEqual(v,value)))fail('value is outside the allowed enum');
  switch(schema.type){
    case 'object': {
      if(!value||typeof value!=='object'||Array.isArray(value))fail('expected an object');
      const record=value as Record<string,unknown>;
      for(const key of schema.required??[])if(!Object.hasOwn(record,key))fail(`missing ${key}`);
      if(schema.additionalProperties===false)for(const key of Object.keys(record))if(!Object.hasOwn(schema.properties??{},key))fail(`unexpected property ${key}`);
      for(const [key,sub] of Object.entries(schema.properties??{}))if(Object.hasOwn(record,key))validateJsonSchema(record[key],sub,`${label}.${key}`,depth+1);
      break;
    }
    case 'array':if(!Array.isArray(value))fail('expected an array');else if(schema.items)value.forEach((v,i)=>validateJsonSchema(v,schema.items!,`${label}[${i}]`,depth+1));break;
    case 'string':if(typeof value!=='string')fail('expected a string');break;
    case 'number':case 'integer':if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value)))fail(`expected a finite ${schema.type}`);else if(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum)fail('number outside bounds');break;
    case 'boolean':if(typeof value!=='boolean')fail('expected boolean');break;
    case 'null':if(value!==null)fail('expected null');break;
  }
}
const id=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(value=>!['constructor','prototype','__proto__'].includes(value),'Reserved identifiers are not permitted.');
const text=z.string().min(1).max(20000);
const condition=z.object({stepId:id,path:z.string().max(512),operator:z.enum(['eq','ne','exists']),value:z.unknown().optional()}).strict();
const schema: z.ZodType<JsonSchema>=z.lazy(()=>z.object({type:z.enum(['object','array','string','number','integer','boolean','null']).optional(),properties:z.record(z.string(),schema).optional(),required:z.array(z.string()).optional(),additionalProperties:z.boolean().optional(),items:schema.optional(),enum:z.array(z.unknown()).optional(),minimum:z.number().optional(),maximum:z.number().optional()}).strict());
const packageSchema=z.object({
  schemaVersion:z.literal(1),name:text,slug:id,purpose:text,synthetic:z.boolean(),
  inputs:z.array(z.object({key:id,label:text,required:z.boolean(),kind:z.enum(['file','json']),description:z.string().max(10000).optional()}).strict()).max(100),
  references:z.array(z.object({path:text,title:text,sourceUrl:z.url().refine(value=>['https:','http:'].includes(new URL(value).protocol),'Source links must use HTTP or HTTPS.').optional(),fictional:z.boolean()}).strict()).max(100),
  rules:z.array(z.object({id,text,source:text}).strict()).max(200),deliverables:z.array(text).max(100),exceptions:z.array(text).max(100),approval:text,questions:z.array(text).max(100),assumptions:z.array(text).max(100),
  steps:z.array(z.object({id,type:z.enum(['ai','python','review','queue']),title:text,instructions:text,inputs:z.array(z.string()).max(100),outputSchema:schema,artifacts:z.array(z.object({path:text,label:text,required:z.boolean(),when:condition.optional()}).strict()).max(100),condition:condition.optional(),script:text.optional(),destination:id.optional(),businessKeyPath:text.optional(),recordPath:text.optional()}).strict()).min(1).max(50),
  assets:z.record(z.string(),z.string().max(2000000)),
}).strict();
function validateFilePaths(paths:string[]):void {
  const files=new Set(paths);
  for(const file of paths){
    const parts=file.split('/');
    for(let length=1;length<parts.length;length++)if(files.has(parts.slice(0,length).join('/')))throw new HarnessError('INVALID_PACKAGE',`Package files cannot also be directories: ${file}.`,400);
  }
}
export function validatePackage(candidate: unknown): WorkflowPackage {
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw new HarnessError('INVALID_PACKAGE','A workflow package must be a JSON object.',400);
  assertJsonBudget(candidate);
  if(Buffer.byteLength(JSON.stringify(candidate))>8*1024*1024)throw new HarnessError('PACKAGE_LIMIT','Workflow package exceeds 8 MiB.',413);
  const parsed=packageSchema.safeParse(candidate);
  if(!parsed.success)throw new HarnessError('INVALID_PACKAGE',parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '),400);
  const pkg=parsed.data as WorkflowPackage;const previous=new Set<string>();const executable=new Set<string>();let reviewed=false;let queueSeen=false;
  const reviewSteps=pkg.steps.filter(s=>s.type==='review');
  if(reviewSteps.length!==1||pkg.steps.at(-2)?.type!=='review'||pkg.steps.at(-1)?.type!=='queue'||pkg.steps.filter(s=>s.type==='queue').length!==1)throw new HarnessError('INVALID_PACKAGE','This version supports one employee review after all execution tasks, followed by one final queue action.',400);
  if(reviewSteps[0].condition&&!jsonValuesEqual(reviewSteps[0].condition,pkg.steps.at(-1)?.condition))throw new HarnessError('INVALID_PACKAGE','A conditional final review and queue action must use the same verified condition.',400);
  for(const [asset] of Object.entries(pkg.assets))safeAssetPath(asset);
  validateFilePaths(Object.keys(pkg.assets));
  const keys=new Set<string>();for(const input of pkg.inputs){if(keys.has(input.key))throw new HarnessError('INVALID_PACKAGE','Input keys must be unique.',400);keys.add(input.key);}
  const references=new Set<string>();for(const reference of pkg.references){safeAssetPath(reference.path);if(references.has(reference.path))throw new HarnessError('INVALID_PACKAGE','Reference paths must be unique.',400);references.add(reference.path);if(!Object.hasOwn(pkg.assets,reference.path))throw new HarnessError('INVALID_PACKAGE',`Missing reference asset ${reference.path}.`,400);}
  const ruleIds=new Set<string>();for(const rule of pkg.rules){if(ruleIds.has(rule.id))throw new HarnessError('INVALID_PACKAGE','Rule IDs must be unique.',400);ruleIds.add(rule.id);}
  for(const rule of pkg.rules)if(!pkg.references.some(r=>r.path===rule.source))throw new HarnessError('INVALID_PACKAGE',`Rule ${rule.id} must cite a connected reference asset.`,400);
  for(const step of pkg.steps){
    if(previous.has(step.id)||queueSeen)throw new HarnessError('INVALID_PACKAGE','Steps must be unique; queue action must be final.',400);
    if(step.condition&&!previous.has(step.condition.stepId))throw new HarnessError('INVALID_PACKAGE',`Condition ${step.id} must reference a preceding step.`,400);
    if(step.condition&&!executable.has(step.condition.stepId))throw new HarnessError('INVALID_PACKAGE','Conditions must reference verified executable task outputs.',400);
    if(step.condition&&step.condition.operator!=='exists'&&!Object.hasOwn(step.condition,'value'))throw new HarnessError('INVALID_PACKAGE','Equality conditions require an explicit comparison value.',400);
    for(const input of step.inputs)if(!['inputs','references','preceding'].includes(input)&&!keys.has(input)&&!previous.has(input))throw new HarnessError('INVALID_PACKAGE',`Step ${step.id} has unknown input ${input}.`,400);
    if(['ai','python'].includes(step.type)&&step.outputSchema.type!=='object')throw new HarnessError('INVALID_PACKAGE','Task output schemas must specify an object.',400);
    const schemas:JsonSchema[]=[step.outputSchema];while(schemas.length){const s=schemas.pop()!;if(s.minimum!==undefined&&s.maximum!==undefined&&s.minimum>s.maximum)throw new HarnessError('INVALID_PACKAGE','Output schema numeric bounds contradict each other.',400);if(s.additionalProperties===false)for(const key of s.required??[])if(!Object.hasOwn(s.properties??{},key))throw new HarnessError('INVALID_PACKAGE','Closed output schemas must declare their required properties.',400);schemas.push(...Object.values(s.properties??{}));if(s.items)schemas.push(s.items);}
    if(step.type==='python'&&(!step.script||!Object.hasOwn(pkg.assets,safeAssetPath(step.script))))throw new HarnessError('INVALID_PACKAGE',`Step ${step.id} has no Python script asset.`,400);
    const artifacts=new Set<string>();for(const artifact of step.artifacts){safeAssetPath(artifact.path);if(artifact.path==='manifest.json'||artifact.path.startsWith('manifest.json/'))throw new HarnessError('INVALID_PACKAGE','The completion manifest is reserved and cannot be a deliverable.',400);if(artifacts.has(artifact.path))throw new HarnessError('INVALID_PACKAGE','Artifact paths must be unique within a task.',400);artifacts.add(artifact.path);if(artifact.when&&artifact.when.operator!=='exists'&&!Object.hasOwn(artifact.when,'value'))throw new HarnessError('INVALID_PACKAGE','Artifact equality conditions require a comparison value.',400);if(artifact.when&&!previous.has(artifact.when.stepId)&&artifact.when.stepId!==step.id)throw new HarnessError('INVALID_PACKAGE','Artifact conditions must reference this or a preceding task.',400);}
    validateFilePaths([...artifacts]);
    if(['review','queue'].includes(step.type)&&step.artifacts.length)throw new HarnessError('INVALID_PACKAGE','Backend review and queue steps cannot declare task-produced artifacts.',400);
    if(step.type==='review'){if(!executable.size)throw new HarnessError('INVALID_PACKAGE','Review requires completed task outputs.',400);reviewed=true;}
    if(step.type==='queue'){if(!reviewed||!step.destination||!step.businessKeyPath||!step.recordPath)throw new HarnessError('INVALID_PACKAGE','Queue action requires preceding human review, destination, business key and record paths.',400);for(const p of [step.businessKeyPath,step.recordPath])if(!executable.has(p.split('.')[0]))throw new HarnessError('INVALID_PACKAGE','Queue action must read verified preceding task outputs.',400);queueSeen=true;}
    if(['ai','python'].includes(step.type))executable.add(step.id);
    previous.add(step.id);
  }
  if(!reviewed||!queueSeen)throw new HarnessError('INVALID_PACKAGE','A workflow must include human review and a final queue action.',400);
  return pkg;
}
