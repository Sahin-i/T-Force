import OpenAI from 'openai';
import type { Response, ResponseInputItem, FunctionTool, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { Config } from './config.js';
import { HarnessError, appError } from './errors.js';
import { agentSystemPrompt } from './prompt.js';
export interface ModelClient { respond(input:ResponseInputItem[],tools:FunctionTool[],signal:AbortSignal,onEvent:(event:ResponseStreamEvent)=>Promise<void>,onRetry?:(delayMs:number)=>Promise<void>,instructions?:string):Promise<Response> }
export function azureBaseUrl(endpoint:string):string{
  if(!endpoint)throw new HarnessError('AZURE_CONFIG','Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in the backend .env.',503);
  const url=new URL(endpoint);
  if(url.protocol!=='https:')throw new HarnessError('AZURE_CONFIG','Azure endpoint must use HTTPS.',503);
  return `${url.origin}/openai/v1/`;
}
function streamError(code:string|null,message:string,headers?:Headers):Error {
  const status=/rate.?limit|429/i.test(`${code} ${message}`)?429:/request_timeout|timed out|408/i.test(`${code} ${message}`)?408:/server_error|temporarily|500|503/i.test(`${code} ${message}`)?503:undefined;
  return Object.assign(new Error(message),{code:code||'MODEL_STREAM_ERROR',status,headers});
}
export function retryDelay(error:unknown,attempt:number):number{
  const e=error as {headers?:Headers;status?:number};const headers=e.headers;
  const milliseconds=Number(headers?.get('retry-after-ms'));
  const rawAfter=headers?.get('retry-after');
  const seconds=rawAfter?(Number.isFinite(Number(rawAfter))?Number(rawAfter):Math.max(0,(Date.parse(rawAfter)-Date.now())/1000)):0;
  const reset=e.status===429?Number(headers?.get('x-ratelimit-reset-requests')):0;
  const hasProviderDelay=milliseconds>0||seconds>0||reset>0;
  // Azure may send HTTP 200 followed by a streaming rate-limit error; its reset header still applies.
  return Math.ceil(Math.max(1000*2**attempt,Number.isFinite(milliseconds)?milliseconds+250:0,Number.isFinite(seconds)?seconds*1000+250:0,Number.isFinite(reset)?reset*1000+250:0,!hasProviderDelay&&e.status===429?60250:0));
}
async function waitForQuota(delay:number,signal:AbortSignal,onRetry?: (delayMs:number)=>Promise<void>){
  await onRetry?.(delay);signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const onAbort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},delay);
    signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
  });
}
const nextRequestAt=new Map<string,number>();
export class AzureModelClient implements ModelClient {
  private client:OpenAI;
  constructor(private config:Config){
    if(!config.apiKey)throw new HarnessError('AZURE_CONFIG','Set AZURE_OPENAI_API_KEY in the backend .env.',503);
    this.client=new OpenAI({baseURL:azureBaseUrl(config.endpoint),apiKey:config.apiKey,defaultHeaders:{'api-key':config.apiKey},maxRetries:0,timeout:config.maxRunMs});
  }
  async respond(input:ResponseInputItem[],tools:FunctionTool[],signal:AbortSignal,onEvent:(event:ResponseStreamEvent)=>Promise<void>,onRetry?:(delayMs:number)=>Promise<void>,instructions?:string):Promise<Response>{
    const key=`${this.config.endpoint}:${this.config.model}`;
    const cooldown=Math.max(0,(nextRequestAt.get(key)||0)-Date.now());
    if(cooldown)await waitForQuota(cooldown,signal,onRetry);
    for(let attempt=0;;attempt++){
      signal.throwIfAborted();let observedOutput=false;let headers:Headers|undefined;
      try{
        const request=this.client.responses.create({model:this.config.model,instructions:instructions??agentSystemPrompt(this.config.databasePath),input,tools,reasoning:{effort:'medium'},store:false,include:['reasoning.encrypted_content'],stream:true,parallel_tool_calls:false,max_output_tokens:this.config.maxOutputTokens,truncation:'disabled'},{signal});
        const result=await request.withResponse();const stream=result.data;headers=result.response.headers;
        let terminal:Response|undefined;
        for await(const event of stream){
          signal.throwIfAborted();
          if(event.type==='response.output_text.delta'||event.type==='response.output_item.added')observedOutput=true;
          await onEvent(event);
          if(event.type==='response.completed'||event.type==='response.incomplete'||event.type==='response.failed')terminal=event.response;
          if(event.type==='error')throw streamError(event.code,event.message,headers);
        }
        if(!terminal)throw new HarnessError('MODEL_STREAM_INTERRUPTED','The model stream ended without a final response. No pending tool actions were executed.');
        const remaining=Number(headers.get('x-ratelimit-remaining-requests'));
        const reset=Number(headers.get('x-ratelimit-reset-requests'));
        if(headers.has('x-ratelimit-remaining-requests')&&remaining<=0&&Number.isFinite(reset)&&reset>0)nextRequestAt.set(key,Date.now()+reset*1000+250);
        return terminal;
      }catch(error){
        if(signal.aborted)throw signal.reason;
        const e=error as {status?:number;name?:string;code?:string;message?:string;headers?:Headers};
        // The official SDK may throw Azure's in-stream error without an HTTP status.
        if(e.status===undefined&&/rate.?limit|429/i.test(`${e.code} ${e.message}`))e.status=429;
        if(!e.headers&&headers)e.headers=headers;
        const transient=error instanceof OpenAI.APIConnectionError||e.status===408||e.status===429||(e.status!==undefined&&e.status>=500)||e.name==='APIConnectionError'||e.name==='APIConnectionTimeoutError';
        if(!transient||observedOutput||attempt>=this.config.modelRetries){const friendly=appError(error);throw new HarnessError(friendly.code,friendly.message,502);}
        const delay=retryDelay(error,attempt);
        if(delay>this.config.maxRunMs)throw new HarnessError('RATE_LIMIT','Azure requires a retry delay longer than the configured run duration. Wait before starting another run.',502);
        await waitForQuota(delay,signal,onRetry);
      }
    }
  }
}
