import { config } from '../server/config.js';
import { AzureModelClient } from '../server/model.js';
import type { ResponseInputItem,FunctionTool } from 'openai/resources/responses/responses';
const client=new AzureModelClient({...config,maxOutputTokens:1024});
const tools:FunctionTool[]=[{type:'function',name:'read',description:'Read the requested verification value.',strict:true,parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}];
const input:ResponseInputItem[]=[{role:'user',content:'Call read for first.txt, then read for second.txt in a later response after receiving the first result, then report their sum. Do not invent the contents.'}];
const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),360000);
let rounds=0,delta=false,encrypted=false;const paths=new Set<string>();
try{
  for(let i=0;i<6;i++){
    const response=await client.respond(input,tools,controller.signal,async event=>{if(event.type==='response.output_text.delta'){delta=true;process.stdout.write(event.delta);}},async delay=>{console.log(`\nAzure retry in ${Math.ceil(delay/1000)}s`);});
    console.log(`\nAzure response ${i+1}: ${response.status}; ${response.output.map(item=>item.type).join(', ')}`);
    if(response.status!=='completed')throw new Error(`Azure response ${response.status}: ${JSON.stringify(response.error||response.incomplete_details)}`);
    encrypted ||=response.output.some(item=>item.type==='reasoning'&&!!item.encrypted_content);
    input.push(...response.output as ResponseInputItem[]);
    const calls=response.output.filter(item=>item.type==='function_call');
    if(!calls.length){if(rounds<2||paths.size<2||!delta)throw new Error('Verification did not complete two tool-calling rounds with streaming.');console.log(`\nPASS: ${config.model}, ${rounds} tool rounds, stateless continuation, streamed text; encrypted reasoning returned: ${encrypted}.`);break;}
    rounds++;
    for(const call of calls){const {path}=JSON.parse(call.arguments) as {path:string};paths.add(path);input.push({type:'function_call_output',call_id:call.call_id,output:path.includes('first')?'17':'25'});}
    if(i===5)throw new Error('Verification iteration limit.');
  }
}catch(error){console.error('\nAzure verification failed:',error instanceof Error?error.message:error);process.exitCode=1;}finally{clearTimeout(timer);}
