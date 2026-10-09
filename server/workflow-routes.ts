import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { WorkflowService } from './workflow-service.js';
import { safeFile } from './files.js';
import { HarnessError } from './errors.js';

const id=z.string().uuid();
const attachmentList=z.array(z.object({path:z.string().max(4096),name:z.string().max(512),size:z.number().int().nonnegative(),mime:z.string().max(256)}).strict()).max(100);
const attachments=attachmentList.default([]);
const inputs=z.record(z.string().max(128),z.unknown()).default({});
const sample=z.object({revisionId:id,inputData:inputs,attachments:attachmentList.optional(),assertions:z.array(z.object({path:z.string().min(1).max(512),operator:z.enum(['eq','exists']),value:z.unknown().optional()}).strict()).max(100).default([])}).strict();
const archiveBody=z.object({archived:z.boolean().default(true)}).strict();
const archiveQuery=z.object({includeArchived:z.enum(['true','false']).optional()}).strict();

export function registerWorkflowRoutes(app:FastifyInstance,service:WorkflowService){
  const store=service.store;
  app.get<{Querystring:{includeArchived?:string}}>('/api/workflow-drafts',async request=>store.drafts(archiveQuery.parse(request.query).includeArchived==='true'));
  app.post('/api/workflow-drafts',async(request,reply)=>{const b=z.object({name:z.string().min(1).max(128).optional()}).strict().parse(request.body??{});return reply.code(201).send(await service.createDraft(b.name));});
  app.post('/api/workflow-drafts/import',{bodyLimit:9*1024*1024},async(request,reply)=>{
    const b=z.object({package:z.record(z.string(),z.unknown()),sourceLabel:z.string().trim().min(1).max(512).optional()}).strict().parse(request.body);
    return reply.code(201).send(await service.importPackage(b.package,b.sourceLabel));
  });
  app.get<{Params:{id:string}}>('/api/workflow-drafts/:id',async request=>store.getDraft(id.parse(request.params.id)));
  app.post<{Params:{id:string}}>('/api/workflow-drafts/:id/archive',async request=>service.archiveDraft(id.parse(request.params.id),archiveBody.parse(request.body??{}).archived));
  app.post<{Params:{id:string}}>('/api/workflow-drafts/:id/messages',async(request,reply)=>{const b=z.object({text:z.string().max(200000),attachments}).strict().parse(request.body);return reply.code(202).send(await service.author(id.parse(request.params.id),b.text,b.attachments));});
  app.post<{Params:{id:string}}>('/api/workflow-drafts/:id/test',async(request,reply)=>{const b=sample.parse(request.body);return reply.code(202).send(await service.test(id.parse(request.params.id),b.revisionId,b.inputData,b.attachments,b.assertions));});
  app.post<{Params:{id:string}}>('/api/workflow-drafts/:id/publish',async(request,reply)=>{const b=z.object({revisionId:id,reviewed:z.boolean(),reviewedBy:z.string().min(1).max(128)}).strict().parse(request.body);return reply.code(201).send(service.publish(id.parse(request.params.id),b.revisionId,b.reviewed,b.reviewedBy));});
  app.get<{Querystring:{includeArchived?:string}}>('/api/workflows',async request=>store.versions(archiveQuery.parse(request.query).includeArchived==='true'));
  app.get<{Params:{id:string}}>('/api/workflows/:id',async request=>store.getVersion(id.parse(request.params.id)));
  app.post<{Params:{id:string}}>('/api/workflows/:id/archive',async request=>service.archiveVersion(id.parse(request.params.id),archiveBody.parse(request.body??{}).archived));
  app.post<{Params:{id:string}}>('/api/workflows/:id/clone',async(request,reply)=>reply.code(201).send(await service.clone(id.parse(request.params.id))));
  app.get<{Params:{id:string}}>('/api/workflows/:id/export',async(request,reply)=>{const v=store.getVersion(id.parse(request.params.id));reply.header('Content-Disposition',`attachment; filename="${v.package.slug}-v${v.version}.json"`).header('X-Content-Type-Options','nosniff');return reply.type('application/json').send({package:v.package,packageHash:v.packageHash,version:v.version,provenance:v.provenance,testReport:v.testReport,synthetic:v.package.synthetic});});
  app.get<{Querystring:{includeTests?:string}}>('/api/cases',async request=>store.cases(z.object({includeTests:z.enum(['true','false']).optional()}).strict().parse(request.query).includeTests==='true'));
  app.post('/api/cases',async(request,reply)=>{const b=z.object({workflowVersionId:id,inputData:inputs,attachments,title:z.string().max(200).optional()}).strict().parse(request.body);return reply.code(202).send(await service.startPublished(b.workflowVersionId,b.inputData,b.attachments,b.title));});
  app.get<{Params:{id:string}}>('/api/cases/:id',async request=>store.getCase(id.parse(request.params.id)));
  app.post<{Params:{id:string}}>('/api/cases/:id/corrections',async(request,reply)=>{const b=z.object({revisionId:id,inputData:inputs,attachments,text:z.string().max(20000).optional()}).strict().parse(request.body);return reply.code(202).send(await service.correct(id.parse(request.params.id),b.revisionId,b.inputData,b.attachments,b.text));});
  app.post<{Params:{id:string}}>('/api/cases/:id/approve',async request=>{const b=z.object({revisionId:id,resultHash:z.string().regex(/^[a-f0-9]{64}$/),approvedBy:z.string().min(1).max(128)}).strict().parse(request.body);return service.approve(id.parse(request.params.id),b.revisionId,b.resultHash,b.approvedBy);});
  app.post<{Params:{id:string}}>('/api/cases/:id/reject',async request=>{const b=z.object({revisionId:id,reason:z.string().max(20000).default('Rejected by employee.')}).strict().parse(request.body);return service.reject(id.parse(request.params.id),b.revisionId,b.reason);});
  app.post<{Params:{id:string}}>('/api/cases/:id/stop',async request=>service.stop(id.parse(request.params.id)));
  app.get('/api/queues',async()=>store.queues());
  app.get('/api/workflow-evaluations',async()=>{
    try{
      const directory=path.join(service.config.stateDir,'validation','workflows');const report=JSON.parse(await readFile(path.join(directory,'evaluation-report.json'),'utf8'));
      let baseline=report.baseline;try{const comparison=JSON.parse(await readFile(path.join(directory,'general-agent-report.json'),'utf8'));baseline={...comparison.baseline,model:comparison.model,selectedScenarios:comparison.selectedScenarios,metrics:comparison.metrics,generatedAt:comparison.generatedAt};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      return {provenance:report.provenance,seed:report.seed,generatedAt:report.generatedAt,metrics:report.metrics,baseline};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  });
  app.get<{Params:{id:string};Querystring:{after?:string}}>('/api/cases/:id/events',async(request,reply)=>{
    const c=store.getCase(id.parse(request.params.id));const after=Number(request.headers['last-event-id']??request.query.after??0);if(!Number.isSafeInteger(after)||after<0)throw new HarnessError('INVALID_EVENT_ID','Event ID must be a nonnegative integer.',400);
    reply.hijack();const response=reply.raw;response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});response.write(': connected\n\n');let disposed=false;let last=after;
    let replaying=true;
    const send=(event:ReturnType<typeof store.replay>[number])=>{if(disposed)return;const current=store.getCase(c.id);const terminal=event.type==='status'&&event.data.status!=='running'&&event.revisionId===current.revisions.at(-1)?.id;if(event.id<=last){if(terminal&&!replaying)response.end();return;}last=event.id;if(response.writableLength>1024*1024){response.destroy();return;}response.write(`id: ${event.id}\nevent: case\ndata: ${JSON.stringify(event)}\n\n`);if(terminal&&!replaying)response.end();};
    const unsubscribe=store.subscribe(c.id,send);const timer=setInterval(()=>{if(!disposed)response.write(': heartbeat\n\n');},15000);response.once('close',()=>{disposed=true;clearInterval(timer);unsubscribe();});for(const event of store.replay(c.id,after))send(event);replaying=false;if(store.getCase(c.id).status!=='running')response.end();
  });
  for(const action of ['content','download','preview'] as const){
    app.get<{Params:{id:string;revisionId:string;artifactId:string}}>(`/api/cases/:id/revisions/:revisionId/artifacts/:artifactId/${action}`,async(request,reply)=>{
      const {artifact,root}=service.artifact(id.parse(request.params.id),id.parse(request.params.revisionId),id.parse(request.params.artifactId));const file=await safeFile(root,artifact.path);
      try{
        if(file.size>25*1024*1024)throw new HarnessError('PREVIEW_LIMIT','Artifact exceeds the 25 MiB limit.',413);const bytes=await file.handle.readFile();if(createHash('sha256').update(bytes).digest('hex')!==artifact.hash)throw new HarnessError('ARTIFACT_CHANGED','This artifact no longer matches the verified fingerprint.',409);
        if(action==='preview'){if(artifact.mime.includes('wordprocessingml')||artifact.mime.includes('spreadsheetml'))return {kind:'office',format:artifact.path.endsWith('.docx')?'docx':'xlsx',mime:artifact.mime,url:artifact.contentUrl};if(!/^text\/|application\/json$/.test(artifact.mime))throw new HarnessError('BINARY_PREVIEW','Open the supported document preview or download this artifact.',415);return {kind:'text',text:bytes.subarray(0,65536).toString('utf8'),truncated:bytes.length>65536,mime:artifact.mime};}
        const inline=new Set(['image/png','image/jpeg','image/webp','image/gif','application/pdf']);const office=artifact.mime.includes('wordprocessingml')||artifact.mime.includes('spreadsheetml');if(action==='content'&&!inline.has(artifact.mime)&&!office&& !/^text\/|application\/json$/.test(artifact.mime))throw new HarnessError('UNSUPPORTED_PREVIEW','Download this artifact to inspect it.',415);
        reply.header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").header('Cache-Control','no-store').header('Content-Disposition',`${action==='content'&&inline.has(artifact.mime)?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`);return reply.type(action==='content'?artifact.mime:'application/octet-stream').send(bytes);
      }finally{await file.handle.close();}
    });
  }
}
