import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResponseInputItem, Response } from 'openai/resources/responses/responses';
import type { Chat, ChatSummary, Run, RunEvent } from '../shared/types.js';
import { HarnessError } from './errors.js';
export interface Conversation { chat:Chat; input:ResponseInputItem[]; responses:Response[] }
const validId=(id:string)=>/^[0-9a-f-]{36}$/.test(id);
export class ConversationStore {
  private chats=new Map<string,Conversation>();
  private runs=new Map<string,Run>();
  private events=new Map<string,RunEvent[]>();
  private queues=new Map<string,Promise<void>>();
  private listeners=new Map<string,Set<(event:RunEvent)=>void>>();
  constructor(public stateDir:string){}
  private async atomic(file:string,data:unknown){
    const temporary=`${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary,JSON.stringify(data),{mode:0o600});
    await fs.rename(temporary,file);
  }
  private enqueue(key:string,fn:()=>Promise<void>):Promise<void>{
    const next=(this.queues.get(key)||Promise.resolve()).catch(()=>{}).then(fn);
    this.queues.set(key,next);return next;
  }
  async init(){
    await fs.mkdir(path.join(this.stateDir,'chats'),{recursive:true,mode:0o700});
    await fs.mkdir(path.join(this.stateDir,'runs'),{recursive:true,mode:0o700});
    for(const filename of await fs.readdir(path.join(this.stateDir,'chats'))){
      if(!filename.endsWith('.json'))continue;
      const conversation=JSON.parse(await fs.readFile(path.join(this.stateDir,'chats',filename),'utf8')) as Conversation;
      this.chats.set(conversation.chat.id,conversation);
    }
    for(const filename of await fs.readdir(path.join(this.stateDir,'runs'))){
      if(!filename.endsWith('.json'))continue;
      const {run,events}=JSON.parse(await fs.readFile(path.join(this.stateDir,'runs',filename),'utf8')) as {run:Run;events:RunEvent[]};
      this.runs.set(run.id,run);this.events.set(run.id,events);
      if(run.status==='running'||run.status==='queued'){
        run.status='interrupted';run.finishedAt=new Date().toISOString();
        run.error={code:'BACKEND_RESTART',message:'The backend restarted during this run. Actions will not be repeated automatically. Inspect shared files before continuing.'};
        for(const tool of run.tools)if(tool.status==='running'||tool.status==='pending')tool.status=tool.status==='running'?'uncertain':'interrupted';
        const conversation=this.chats.get(run.chatId);
        const message=conversation?.chat.messages.find(m=>m.id===run.messageId);
        if(message){message.status=run.status;message.error=run.error;message.tools=run.tools;message.elapsedMs=Date.parse(run.finishedAt)-Date.parse(run.startedAt);await this.save(conversation!);}
        // Complete unresolved call IDs with explicit uncertainty, never rerun them.
        if(conversation){
          const results=new Set(conversation.input.filter(i=>i.type==='function_call_output').map(i=>(i as {call_id:string}).call_id));
          for(const item of conversation.input)if(item.type==='function_call'&&!results.has(item.call_id)){
            conversation.input.push({type:'function_call_output',call_id:item.call_id,output:JSON.stringify({ok:false,error:{code:'INTERRUPTED',message:'Backend restarted. Tool may have partially modified files; inspect them. Do not repeat automatically.'}})});
          }
          await this.save(conversation);
        }
        await this.emit(run.id,'error',{error:run.error});await this.emit(run.id,'status',{status:run.status});
      }
    }
  }
  list():ChatSummary[]{return [...this.chats.values()].map(({chat:{id,title,createdAt,updatedAt}})=>({id,title,createdAt,updatedAt})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  get(id:string):Conversation { if(!validId(id)||!this.chats.has(id))throw new HarnessError('CHAT_NOT_FOUND','Chat not found.',404);return this.chats.get(id)!; }
  async create():Promise<Chat>{const now=new Date().toISOString();const chat:Chat={id:randomUUID(),title:'New chat',createdAt:now,updatedAt:now,messages:[]};const conversation:Conversation={chat,input:[],responses:[]};this.chats.set(chat.id,conversation);await this.save(conversation);return chat;}
  save(conversation:Conversation){const data=structuredClone(conversation);return this.enqueue(`chat:${data.chat.id}`,()=>this.atomic(path.join(this.stateDir,'chats',`${data.chat.id}.json`),data));}
  getRun(id:string):Run{const run=this.runs.get(id);if(!validId(id)||!run)throw new HarnessError('RUN_NOT_FOUND','Run not found.',404);return run;}
  allRuns():Run[]{return [...this.runs.values()];}
  async addRun(run:Run){this.runs.set(run.id,run);this.events.set(run.id,[]);await this.saveRun(run);}
  saveRun(run:Run){const data=structuredClone({run,events:this.events.get(run.id)||[]});return this.enqueue(`run:${run.id}`,()=>this.atomic(path.join(this.stateDir,'runs',`${run.id}.json`),data));}
  replay(id:string,after:number){this.getRun(id);return (this.events.get(id)||[]).filter(event=>event.id>after);}
  subscribe(id:string,listener:(event:RunEvent)=>void){const set=this.listeners.get(id)||new Set();set.add(listener);this.listeners.set(id,set);return ()=>{set.delete(listener);if(set.size===0)this.listeners.delete(id);};}
  async emit(id:string,type:RunEvent['type'],data:RunEvent['data']){
    const events=this.events.get(id)!;
    const event:RunEvent={id:(events.at(-1)?.id||0)+1,runId:id,type,data:structuredClone(data),createdAt:new Date().toISOString()};
    events.push(event);await this.saveRun(this.getRun(id));
    for(const listener of this.listeners.get(id)||[])listener(event);
    return event;
  }
}
