import { randomUUID } from 'node:crypto';
import type { Response, ResponseInputItem } from 'openai/resources/responses/responses';
import type { ModelClient } from '../server/model.js';
import { createCatalogPackage, type CatalogKind } from './catalog.js';

function promptText(input:ResponseInputItem[]):string{
  return input.filter(item=>'role' in item&&item.role==='user').map(item=>{const content=(item as {content?:unknown}).content;const text=typeof content==='string'?content:Array.isArray(content)?content.map(value=>(value as {text?:string}).text??'').join('\n'):'';return text.startsWith('Workflow authoring, draft ')?text.split('\n').slice(1).join('\n'):text;}).join('\n');
}
function response(output:unknown[]):Response{return {id:`catalog-fixture-${randomUUID()}`,status:'completed',output,usage:{input_tokens:25,output_tokens:15,total_tokens:40}} as unknown as Response;}

/** Honest deterministic model substitute: candidates still use actual write tools. */
export function createCatalogModel():ModelClient{
  let wrote=false;
  let summary='';
  return {async respond(input,_tools,signal){
    signal.throwIfAborted();
    if(!wrote){
      wrote=true;
      const prompt=promptText(input);
      const kind:CatalogKind=/complaint|billing investigation/i.test(prompt)?'complaints':/onboard|subscriber|representative/i.test(prompt)?'onboarding':'invoice';
      const tolerance=prompt.match(/(?:tolerance|within|at most)\s*(?:AZN\s*)?(0\.\d+)/gi)?.at(-1)?.match(/0\.\d+/)?.[0]??'0.01';
      const pkg=await createCatalogPackage(kind,{totalTolerance:tolerance});
      summary=kind==='invoice'?`The executable total tolerance is AZN ${tolerance}; exact agreed unit prices and remaining delivered quantities are checked before review.`:kind==='onboarding'?'The procedure accepts a valid unstamped electronic extract and specifically requests missing representative identification.':'The procedure credits distinct repeated charge transactions for one event and escalates missing usage evidence.';
      return response([{type:'function_call',id:`call-${randomUUID()}`,call_id:`catalog-write-${randomUUID()}`,name:'write',arguments:JSON.stringify({path:'/workspace/output/package.json',content:JSON.stringify(pkg,null,2)}),status:'completed'},
        {type:'message',id:`msg-${randomUUID()}`,role:'assistant',status:'completed',content:[{type:'output_text',text:`Prepared a deterministic test candidate. ${summary} The application will verify the written package before importing this revision.`,annotations:[]}]}]);
    }
    return response([{type:'message',id:`msg-${randomUUID()}`,role:'assistant',status:'completed',content:[{type:'output_text',text:`Deterministic test model wrote the candidate using the application write tool. ${summary} Review the structured procedure and its executable policy before testing and publishing.`,annotations:[]}]}]);
  }};
}
