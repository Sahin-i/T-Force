import { randomUUID } from 'node:crypto';
import type { ResponseInputItem, ResponseFunctionToolCall } from 'openai/resources/responses/responses';
import type { Attachment, Message, Run, ToolActivity, Usage } from '../shared/types.js';
import type { Config } from './config.js';
import { HarnessError, appError } from './errors.js';
import { ConversationStore, type Conversation } from './store.js';
import { AzureModelClient, type ModelClient } from './model.js';
import { SandboxManager, type Sandbox, type SandboxLayout } from './sandbox.js';
import { executeTool, toolDefinitions } from './tools.js';
import { listWorkspaceFiles, validateAttachments } from './files.js';
const zeroUsage=():Usage=>({inputTokens:0,outputTokens:0,totalTokens:0});
export type AgentCompletionDecision=boolean|{complete:boolean;feedback?:string};
export interface AgentSubmitOptions { instructions?: string; context?: string; isolated?: SandboxLayout; workspaceDir?: string; completion?:()=>Promise<AgentCompletionDecision> }
export interface TaskModelResult { text: string; usage: Usage; tools: ToolActivity[] }
export type ExecutionKind = 'chat'|'authoring'|'python'|'ai'|'workflow';
function isolatedTools(){return toolDefinitions.map(tool=>({...tool,description:tool.name==='bash'?'Execute a bounded command in the isolated Docker container. Network access is disabled. Package, inputs, references and preceding results are read-only; write deliverables to /workspace/output and temporary files to /workspace/scratch or /tmp. Cancellation removes the entire container.':tool.name==='write'?'Write a UTF-8 file in /workspace/output or scratch. Input and package directories are read-only.':tool.description}));}
export class AgentHarness {
  private locked=false;
  private shutdownStarted=false;
  private active?:{run:Run;controller:AbortController;done:Promise<void>;kind:ExecutionKind};
  private exclusive?:{id:string;kind:ExecutionKind;controller:AbortController;done:Promise<unknown>};
  constructor(private config:Config,public store:ConversationStore,public sandboxes:SandboxManager,private makeModel:()=>ModelClient=()=>new AzureModelClient(config)){}
  get activeRun():Run|null{return this.active?.run || null;}
  get busy():boolean{return this.locked;}
  get shuttingDown():boolean{return this.shutdownStarted;}
  private assertAcceptingWork():void{if(this.shutdownStarted)throw new HarnessError('SHUTTING_DOWN','The backend is shutting down. Wait for it to restart before starting work.',503);}
  get activeExecution():{id:string;kind:ExecutionKind}|null{return this.exclusive?{id:this.exclusive.id,kind:this.exclusive.kind}:this.active?{id:this.active.run.id,kind:this.active.kind}:null;}
  async runExclusive<T>(id:string,kind:ExecutionKind,work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    this.assertAcceptingWork();
    if(this.locked)throw new HarnessError('BUSY','Another run is active. Stop it or wait before starting a task.',409);
    this.locked=true;
    const controller=new AbortController();
    const abort=()=>controller.abort(signal?.reason);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort(new HarnessError('RUN_DURATION_LIMIT','The configured task duration limit was reached.')),this.config.maxRunMs);
    const done=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);}).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(this.exclusive?.id===id)this.exclusive=undefined;this.locked=false;});
    this.exclusive={id,kind,controller,done};
    return done;
  }
  async abortExclusive(id:string):Promise<void>{
    if(this.exclusive?.id===id){const active=this.exclusive;active.controller.abort(new HarnessError('STOPPED','Stopped by you.'));await active.done.catch(()=>{});}
    else if(this.active?.run.id===id)await this.abort(id);
  }
  async submit(chatId:string,text:string,attachments:Attachment[],options:AgentSubmitOptions={}):Promise<string>{
    this.assertAcceptingWork();
    if(this.locked)throw new HarnessError('BUSY','Another run is active. Stop it or wait before sending a message.',409);
    this.locked=true;
    try{
      const conversation=this.store.get(chatId);
      if(!text.trim()&&!attachments.length)throw new HarnessError('EMPTY_MESSAGE','Enter a message or attach a file.',400);
      const checked=await validateAttachments(this.config.workspaceDir,attachments,this.config.stateDir);
      this.assertAcceptingWork();
      const model=this.makeModel();
      const readiness=await this.sandboxes.readiness();
      this.assertAcceptingWork();
      if(!readiness.ready)throw new HarnessError('DOCKER_UNAVAILABLE',readiness.error||'Docker is unavailable. Start Docker and build the sandbox image.',503);
      // No surviving background process may overlap a new shared-workspace run.
      await this.sandboxes.cleanupStale();
      this.assertAcceptingWork();
      const content=[options.context,text.trim(),...checked.map(a=>`Attached file: /workspace/${a.path} (${a.name}, ${a.size} bytes). Inspect the actual file with tools.`)].filter(Boolean).join('\n');
      const input:ResponseInputItem={role:'user',content:[{type:'input_text',text:content}]};
      this.checkContext([...conversation.input,input]);
      const now=new Date().toISOString();const runId=randomUUID();
      const user:Message={id:randomUUID(),role:'user',text:text.trim(),attachments:checked,tools:[],createdAt:now};
      const assistant:Message={id:randomUUID(),role:'assistant',text:'',attachments:[],tools:[],createdAt:now,runId,status:'queued'};
      const run:Run={id:runId,chatId,messageId:assistant.id,status:'queued',startedAt:now,model:this.config.model,usage:zeroUsage(),tools:[]};
      conversation.input.push(input);conversation.chat.messages.push(user,assistant);conversation.chat.updatedAt=now;
      if(conversation.chat.title==='New chat')conversation.chat.title=(text.trim()||checked[0]?.name||'New chat').slice(0,64);
      await this.store.save(conversation);await this.store.addRun(run);
      const controller=new AbortController();
      if(this.shutdownStarted)controller.abort(new HarnessError('STOPPED','The backend shut down before this run started. No tool actions were executed.'));
      const done=Promise.resolve().then(()=>this.execute(conversation,assistant,run,model,controller,options)).finally(()=>{if(this.active?.run.id===run.id)this.active=undefined;this.locked=false;});
      this.active={run,controller,done,kind:options.isolated?'authoring':'chat'};
      // All errors in execute are converted to persisted run failures.
      void done.catch(error=>console.error('Unable to persist run completion:',appError(error)));
      return runId;
    }catch(error){this.locked=false;throw error;}
  }
  private checkContext(input:ResponseInputItem[]){
    if(Buffer.byteLength(JSON.stringify(input))>this.config.maxContextBytes)throw new HarnessError('CONTEXT_LIMIT','This chat exceeds the configured context size. Your chat is preserved; start a new chat to continue.',413);
  }
  async abort(runId:string){
    const run=this.store.getRun(runId);
    if(this.active?.run.id===runId){this.active.controller.abort(new HarnessError('STOPPED','Stopped by you. Shared files may contain partial changes.'));await this.active.done;}
    return run;
  }
  async waitRun(runId:string):Promise<Run>{if(this.active?.run.id===runId)await this.active.done;return this.store.getRun(runId);}
  async shutdown(){this.shutdownStarted=true;if(this.active)await this.abort(this.active.run.id);if(this.exclusive)await this.abortExclusive(this.exclusive.id);}
  /** Caller owns the exclusive slot and awaits container disposal before importing any results. */
  async runTaskInSandbox(sandbox:Sandbox,instructions:string,context:string,signal:AbortSignal,onProgress?:(type:string,data:Record<string,unknown>)=>Promise<void>,completion?:()=>Promise<boolean>):Promise<TaskModelResult>{
    const model=this.makeModel();const input:ResponseInputItem[]=[{role:'user',content:context}];
    const usage=zeroUsage();const tools:ToolActivity[]=[];let text='';
    try{for(let iteration=0;iteration<this.config.maxIterations;iteration++){
      signal.throwIfAborted();this.checkContext(input);
      const response=await model.respond(input,isolatedTools(),signal,async event=>{if(event.type==='response.output_text.delta')await onProgress?.('text',{delta:event.delta});},async delayMs=>{await onProgress?.('retry',{delayMs});},instructions);
      if(response.usage){usage.inputTokens+=response.usage.input_tokens;usage.outputTokens+=response.usage.output_tokens;usage.totalTokens+=response.usage.total_tokens;}
      signal.throwIfAborted();
      const calls=response.output.filter((item):item is ResponseFunctionToolCall=>item.type==='function_call');
      const known=new Set(input.flatMap(item=>item.type==='function_call'||item.type==='function_call_output'?[item.call_id]:[]));
      for(const call of calls){
        if(typeof call.call_id!=='string'||!call.call_id.trim())throw new HarnessError('MODEL_INVALID_TOOL_CALL','The model returned a tool call without a valid call ID.');
        if(known.has(call.call_id))throw new HarnessError('DUPLICATE_TOOL_CALL','The model repeated a tool call ID. Completed actions will not be repeated.');
        known.add(call.call_id);
      }
      if(response.status!=='completed')throw new HarnessError(response.status==='incomplete'?'MODEL_INCOMPLETE':'MODEL_FAILED','The model did not complete its response. Pending tool actions were not executed.');
      if(calls.some(call=>call.status!==undefined&&call.status!=='completed'))throw new HarnessError('INCOMPLETE_TOOL_CALL','The provider returned an incomplete tool call.');
      input.push(...response.output as ResponseInputItem[]);
      text+=response.output.flatMap(item=>item.type==='message'?item.content.filter(content=>content.type==='output_text').map(content=>content.text):[]).join('\n');
      if(!calls.length)return {text,usage,tools};
      for(const call of calls){
        signal.throwIfAborted();
        const activity:ToolActivity={id:call.call_id,name:call.name,arguments:call.arguments,status:'running',startedAt:new Date().toISOString()};tools.push(activity);await onProgress?.('tool',{tool:activity});
        const result=await executeTool(sandbox,call.name,call.arguments,{signal,maxOutputBytes:this.config.maxToolOutputBytes});
        signal.throwIfAborted();activity.status=result.ok?'completed':'failed';activity.output=result.output;activity.error=result.error;activity.finishedAt=new Date().toISOString();
        const output=JSON.stringify({ok:result.ok,output:result.output,...(result.error?{error:result.error}:{})});
        input.push({type:'function_call_output',call_id:call.call_id,output:result.images?.length?[{type:'input_text',text:output},...result.images.map(image=>({type:'input_image' as const,image_url:`data:${image.mime};base64,${image.data}`,detail:'auto' as const}))]:output});
        await onProgress?.('tool',{tool:activity});
        if(result.error&&['COMMAND_TIMEOUT','COMMAND_ABORTED','SANDBOX_STOPPED','SANDBOX_CLEANUP_FAILED','DOCKER_UNAVAILABLE'].includes(result.error.code))throw new HarnessError(result.error.code,result.error.message);
      }
      if(completion&&calls.every(call=>tools.find(tool=>tool.id===call.call_id)?.status==='completed')){const complete=await completion();signal.throwIfAborted();if(complete)return {text,usage,tools};}
    }
    throw new HarnessError('ITERATION_LIMIT','The configured model iteration limit was reached.');
    }catch(error){if(error&&typeof error==='object')try{Object.assign(error,{usage:{...usage},tools});}catch{/* Preserve the original failure if a provider freezes its error. */}throw error;}
  }
  private async unresolved(conversation:Conversation,run:Run){
    const outputs=new Set(conversation.input.filter(i=>i.type==='function_call_output').map(i=>(i as {call_id:string}).call_id));
    const calls=conversation.input.filter((i):i is ResponseFunctionToolCall=>i.type==='function_call');
    for(const call of calls)if(!outputs.has(call.call_id)){
      const activity=run.tools.find(t=>t.id===call.call_id);
      if(activity&&(activity.status==='running'||activity.status==='pending'))activity.status=activity.status==='running'?'uncertain':'interrupted';
      conversation.input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify({ok:false,error:{code:'INTERRUPTED',message:'This tool was interrupted or never started. Files may have changed. Inspect before further actions; do not repeat automatically.'}})});
    }
  }
  private async execute(conversation:Conversation,message:Message,run:Run,model:ModelClient,controller:AbortController,options:AgentSubmitOptions){
    let sandbox:Sandbox|undefined;
    let baseline=new Map<string,string>();
    let pendingRepair=false;let lastFeedback:string|undefined;const sentFeedback=new Set<string>();
    const completion=async():Promise<'complete'|'repair'|'pending'>=>{
      const decision=await options.completion!();controller.signal.throwIfAborted();
      if(typeof decision==='boolean'?decision:decision.complete){pendingRepair=false;return 'complete';}
      if(typeof decision==='object')pendingRepair=true;
      const feedback=typeof decision==='object'?decision.feedback?.trim():undefined;
      if(feedback&&!sentFeedback.has(feedback)){
        sentFeedback.add(feedback);pendingRepair=true;lastFeedback=feedback;
        // This is a real application instruction, never a fabricated provider tool result.
        conversation.input.push({role:'developer',content:[{type:'input_text',text:feedback}]});this.checkContext(conversation.input);
        await this.store.save(conversation);await this.store.emit(run.id,'status',{status:run.status,detail:'Checking and improving the workflow draft.'});
        return 'repair';
      }
      return 'pending';
    };
    const timer=setTimeout(()=>controller.abort(new HarnessError('RUN_DURATION_LIMIT','The configured run duration limit was reached. Shared files are preserved.')),this.config.maxRunMs);
    try{
      controller.signal.throwIfAborted();
      baseline=new Map((await listWorkspaceFiles(options.workspaceDir??this.config.workspaceDir)).map(file=>[file.path,`${file.size}:${file.modifiedAt}`]));
      controller.signal.throwIfAborted();
      sandbox=options.isolated?await this.sandboxes.createIsolated(run.id,controller.signal,options.isolated):await this.sandboxes.create(run.id,controller.signal);run.containerName=sandbox.name;
      run.status='running';message.status=run.status;await this.store.saveRun(run);await this.store.emit(run.id,'status',{status:run.status});
      for(let iteration=0;iteration<this.config.maxIterations;iteration++){
        controller.signal.throwIfAborted();this.checkContext(conversation.input);
        const prefix=message.text;let deltaText='';
        const response=await model.respond(conversation.input,options.isolated?isolatedTools():toolDefinitions,controller.signal,async event=>{
          if(event.type==='response.output_text.delta'){
            deltaText+=event.delta;message.text=prefix+deltaText;
            await this.store.emit(run.id,'text',{delta:event.delta});
          }
        },async delayMs=>{await this.store.emit(run.id,'status',{status:run.status,detail:`Azure is rate limited or temporarily unavailable; retrying in ${Math.ceil(delayMs/1000)} seconds.`});},options.instructions);
        // Keep every original provider item, including opaque reasoning content.
        conversation.responses.push(response);
        const calls=response.output.filter((item):item is ResponseFunctionToolCall=>item.type==='function_call');
        const knownCallIds=new Set(conversation.input.flatMap(item=>item.type==='function_call'||item.type==='function_call_output'?[item.call_id]:[]));
        for(const call of calls){
          if(typeof call.call_id!=='string'||!call.call_id.trim())throw new HarnessError('MODEL_INVALID_TOOL_CALL','The model returned a tool call without a valid call ID. No actions from this response were executed.');
          if(knownCallIds.has(call.call_id))throw new HarnessError('DUPLICATE_TOOL_CALL','The model returned a tool call ID already used in this chat. No actions from this response were executed; completed actions are preserved.');
          knownCallIds.add(call.call_id);
        }
        if(response.status==='completed')conversation.input.push(...response.output as ResponseInputItem[]);
        const responseText=response.output.flatMap(item=>item.type==='message'?item.content.filter(c=>c.type==='output_text').map(c=>c.text):[]).join('\n');
        message.text=prefix+responseText;
        if(response.usage){run.usage.inputTokens+=response.usage.input_tokens;run.usage.outputTokens+=response.usage.output_tokens;run.usage.totalTokens+=response.usage.total_tokens;message.usage={...run.usage};await this.store.emit(run.id,'usage',{usage:run.usage});}
        for(const call of calls){const activity:ToolActivity={id:call.call_id,name:call.name,arguments:call.arguments,status:'pending'};run.tools.push(activity);message.tools=run.tools;}
        await this.store.save(conversation);await this.store.saveRun(run);
        if(calls.some(call=>call.status!==undefined&&call.status!=='completed'))throw new HarnessError('INCOMPLETE_TOOL_CALL','The provider returned a tool call that was not completed. Its arguments were not executed.');
        if(response.status!=='completed')throw new HarnessError(response.status==='incomplete'?'MODEL_INCOMPLETE':'MODEL_FAILED',response.status==='incomplete'?`The model response was incomplete (${response.incomplete_details?.reason||'unknown reason'}). Pending tools were not executed.`:`The model failed: ${response.error?.message||response.status}. Pending tools were not executed.`);
        if(!calls.length){
          if(options.completion){const decision=await completion();if(decision==='repair'){if(iteration===this.config.maxIterations-1)throw new HarnessError('ITERATION_LIMIT','T-force could not finish this draft. Try again or clarify the instructions.',500,lastFeedback);continue;}if(decision!=='complete'&&pendingRepair)throw new HarnessError('AUTHORING_REPAIR_LIMIT','T-force could not finish this draft. Try again or clarify the instructions.',500,lastFeedback);}
          run.status='completed';break;
        }
        for(const call of calls){
          controller.signal.throwIfAborted();
          const activity=run.tools.find(t=>t.id===call.call_id)!;
          activity.status='running';activity.startedAt=new Date().toISOString();
          await this.store.saveRun(run);await this.store.save(conversation);await this.store.emit(run.id,'tool',{tool:activity});
          let outputQueue=Promise.resolve();
          const result=await executeTool(sandbox,call.name,call.arguments,{signal:controller.signal,maxOutputBytes:this.config.maxToolOutputBytes,onOutput:delta=>{outputQueue=outputQueue.then(()=>this.store.emit(run.id,'tool_output',{callId:call.call_id,delta})).then(()=>{});}});
          await outputQueue;controller.signal.throwIfAborted();
          activity.status=result.ok?'completed':'failed';activity.output=result.output;activity.error=result.error;activity.finishedAt=new Date().toISOString();
          const text=JSON.stringify({ok:result.ok,output:result.output,...(result.error?{error:result.error}:{})});
          const toolOutput:ResponseInputItem={type:'function_call_output',call_id:call.call_id,output:result.images?.length?[{type:'input_text',text},...result.images.map(img=>({type:'input_image' as const,image_url:`data:${img.mime};base64,${img.data}`,detail:'auto' as const}))]:text};
          conversation.input.push(toolOutput);
          // Persist result before requesting the model again; completed actions cannot be retried.
          await this.store.save(conversation);await this.store.saveRun(run);await this.store.emit(run.id,'tool',{tool:activity});
          if(result.error && ['COMMAND_TIMEOUT','SANDBOX_STOPPED','SANDBOX_CLEANUP_FAILED','DOCKER_UNAVAILABLE'].includes(result.error.code))throw new HarnessError(result.error.code,result.error.message);
          const files=await listWorkspaceFiles(options.workspaceDir??this.config.workspaceDir);await this.store.emit(run.id,'files',{files});
        }
        // Application-owned file contracts may finish authoring without an additional prose request.
        // A failed current batch keeps recovery open; earlier recoverable errors may be repaired.
        if(options.completion&&calls.every(call=>run.tools.find(tool=>tool.id===call.call_id)?.status==='completed')){if(await completion()==='complete'){run.status='completed';break;}}
        if(iteration===this.config.maxIterations-1)throw new HarnessError('ITERATION_LIMIT','The configured model iteration limit was reached. Completed actions and shared files are preserved.');
      }
      message.artifacts=(await listWorkspaceFiles(options.workspaceDir??this.config.workspaceDir)).filter(file=>file.path.startsWith('outputs/')&&baseline.get(file.path)!==`${file.size}:${file.modifiedAt}`);
    }catch(error){
      const reason=controller.signal.aborted?controller.signal.reason:error;
      const friendly=appError(reason);run.status=friendly.code==='STOPPED'?'stopped':'failed';run.error=friendly;message.error=friendly;
      for(const tool of run.tools)if(tool.status==='pending'||tool.status==='running')tool.status=tool.status==='running'?'uncertain':'interrupted';
      await this.unresolved(conversation,run);await this.store.emit(run.id,'error',{error:friendly});
    }finally{
      clearTimeout(timer);
      try{await sandbox?.dispose();}catch(error){run.status='failed';run.error={code:'SANDBOX_CLEANUP_FAILED',message:'Unable to remove the tool container. Check Docker and remove the run container before continuing.',details:appError(error).message};message.error=run.error;await this.store.emit(run.id,'error',{error:run.error});}
      run.finishedAt=new Date().toISOString();message.elapsedMs=Date.parse(run.finishedAt)-Date.parse(run.startedAt);message.status=run.status;message.tools=run.tools;message.usage={...run.usage};conversation.chat.updatedAt=run.finishedAt;
      await this.store.save(conversation);await this.store.saveRun(run);await this.store.emit(run.id,'status',{status:run.status});
    }
  }
}
