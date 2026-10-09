import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import { ConversationStore } from './store.js';
import { AgentHarness } from './agent.js';
import { SandboxManager } from './sandbox.js';
import { ensureWorkspace, registerFileRoutes } from './files.js';
import { HarnessError, appError } from './errors.js';
import { databaseStatus } from './database.js';
import { WorkflowStore } from './workflow-store.js';
import { WorkflowService } from './workflow-service.js';
import { registerWorkflowRoutes } from './workflow-routes.js';
import { registerWorkflowExampleRoutes } from './workflow-examples.js';
export async function createApp(config:Config,dependencies?:{store?:ConversationStore;sandboxes?:SandboxManager;harness?:AgentHarness;skipRecovery?:boolean}){
  const app=Fastify({logger:false,bodyLimit:1024*1024});
  const store=dependencies?.store || new ConversationStore(config.stateDir);
  const sandboxes=dependencies?.sandboxes || new SandboxManager({workspaceDir:config.workspaceDir,image:config.sandboxImage,commandTimeoutMs:config.commandTimeoutMs,maxOutputBytes:config.maxToolOutputBytes});
  await ensureWorkspace(config.workspaceDir);
  await store.init();
  if(!dependencies?.skipRecovery)await sandboxes.cleanupStale().catch(error=>console.warn('Docker cleanup unavailable:',appError(error).message));
  const harness=dependencies?.harness || new AgentHarness(config,store,sandboxes);
  const workflowStore=new WorkflowStore(config.stateDir);await workflowStore.init();
  const workflows=new WorkflowService(config,workflowStore,harness);
  app.setErrorHandler((error,request,reply)=>{
    const e=error as Error & {statusCode?:number;code?:string};
    const status=e instanceof z.ZodError?400:e.statusCode||500;
    reply.code(status).send(e instanceof z.ZodError?{code:'INVALID_REQUEST',message:e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')}:appError(error));
  });
  app.addHook('onRequest',async(request,reply)=>{
    const host=request.headers.host?.split(':')[0];
    if(host&&!['localhost','127.0.0.1','['].includes(host)){reply.code(403).send({code:'LOCALHOST_ONLY',message:'Only localhost requests are accepted.'});return;}
    const origin=request.headers.origin;
    if(origin){let trusted=false;try{const url=new URL(origin);trusted=url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)&&[String(config.port),'5173'].includes(url.port);}catch{}
      if(!trusted)reply.code(403).send({code:'INVALID_ORIGIN',message:'Only the local application can access this API.'});
    }
  });
  app.get('/api/health',async()=>({model:config.model,activeRun:harness.activeRun,activeExecution:harness.activeExecution,database:await databaseStatus(config),docker:await sandboxes.readiness(),azure:{configured:!!config.endpoint&&!!config.apiKey,endpoint:config.endpoint},limits:{fileBytes:25*1024*1024,uploadBytes:100*1024*1024}}));
  const authorChatIds=()=>new Set(workflowStore.drafts(true).map(d=>d.chatId));
  const generalChat=(id:string)=>{if(authorChatIds().has(id))throw new HarnessError('WORKFLOW_CHAT','Use the workflow authoring interface for this conversation.',403);return store.get(id);};
  app.get('/api/chats',async()=>store.list().filter(chat=>!authorChatIds().has(chat.id)));
  app.post('/api/chats',async(_request,reply)=>reply.code(201).send(await store.create()));
  app.get<{Params:{id:string}}>('/api/chats/:id',async request=>generalChat(request.params.id).chat);
  const messageSchema=z.object({text:z.string().max(200000),attachments:z.array(z.object({path:z.string().max(4096),name:z.string().max(512),size:z.number().int().nonnegative(),mime:z.string().max(256)})).max(100)}).strict();
  app.post<{Params:{id:string}}>('/api/chats/:id/messages',async(request,reply)=>{
    generalChat(request.params.id);const body=messageSchema.parse(request.body);const runId=await harness.submit(request.params.id,body.text,body.attachments);reply.code(202).send({runId});
  });
  app.get<{Params:{id:string}}>('/api/runs/:id',async request=>store.getRun(request.params.id));
  app.post<{Params:{id:string}}>('/api/runs/:id/abort',async request=>harness.abort(request.params.id));
  app.get<{Params:{id:string};Querystring:{after?:string}}>('/api/runs/:id/events',async(request,reply)=>{
    const run=store.getRun(request.params.id);
    const raw=request.headers['last-event-id'] ?? request.query.after ?? '0';const after=Number(raw);
    if(!Number.isSafeInteger(after)||after<0)throw new HarnessError('INVALID_EVENT_ID','Event replay ID must be a nonnegative integer.',400);
    reply.hijack();const response=reply.raw;
    response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    response.write(': connected\n\n');
    let disposed=false;let lastSent=after;
    const send=(event:ReturnType<ConversationStore['replay']>[number])=>{
      if(disposed)return;
      const terminal=event.type==='status'&&!['queued','running'].includes(String(event.data.status));
      // An event can be visible to replay while its disk flush is still pending.
      // The same event is then delivered to the live listener after that flush.
      if(event.id<=lastSent){if(terminal)response.end();return;}
      if(response.writableLength>1024*1024){response.destroy();return;}
      lastSent=event.id;
      response.write(`id: ${event.id}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`);
      if(terminal)response.end();
    };
    const replay=store.replay(run.id,after);
    const unsubscribe=store.subscribe(run.id,send);
    const heartbeat=setInterval(()=>{if(!disposed)response.write(': heartbeat\n\n');},15000);
    const cleanup=()=>{disposed=true;clearInterval(heartbeat);unsubscribe();};
    response.once('close',cleanup);
    for(const event of replay)send(event);
    if(!['queued','running'].includes(run.status))response.end();
  });
  await registerFileRoutes(app,config.workspaceDir,config.stateDir);
  registerWorkflowExampleRoutes(app);
  registerWorkflowRoutes(app,workflows);
  const frontend=path.resolve('dist/client');
  if(existsSync(path.join(frontend,'index.html'))){
    await app.register(fastifyStatic,{root:frontend,prefix:'/'});
    app.setNotFoundHandler((request,reply)=>{if(request.url.startsWith('/api/'))reply.code(404).send({code:'NOT_FOUND',message:'API endpoint not found.'});else reply.sendFile('index.html');});
  }
  // Cancel runs before server.close waits for their active SSE connections.
  app.addHook('preClose',async()=>{await harness.shutdown();await workflows.shutdown();});
  // Requests admitted before preClose can finish run preparation during HTTP draining.
  // Check the coordinator once more after those requests have returned.
  app.addHook('onClose',async()=>{await harness.shutdown();await workflows.shutdown();workflowStore.close();});
  return {app,store,harness,sandboxes,workflows,workflowStore};
}
