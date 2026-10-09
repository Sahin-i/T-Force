import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApprovalReceipt, CaseEvent, PublishedWorkflow, QueueRecord, WorkflowCase, WorkflowDraft } from '../shared/workflow-types.js';
import { HarnessError } from './errors.js';

/** Backend-owned metadata: this database and its WAL are never agent mounts. */
export class WorkflowStore {
  private db!: DatabaseSync;
  private listeners=new Map<string,Set<(event:CaseEvent)=>void>>();
  constructor(public readonly stateDir:string){}
  async init(){
    await mkdir(this.stateDir,{recursive:true});
    this.db=new DatabaseSync(path.join(this.stateDir,'workflows.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(workflow_id,version));
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, case_id TEXT NOT NULL, revision_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queues(id TEXT PRIMARY KEY, destination TEXT NOT NULL, business_key TEXT NOT NULL, record_hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(destination,business_key));
      CREATE TABLE IF NOT EXISTS case_events(case_id TEXT NOT NULL, id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(case_id,id));`);
    for(const table of ['drafts','versions'] as const){
      const columns=this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
      if(!columns.some(column=>column.name==='archived_at')){
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN archived_at TEXT`);
        for(const row of this.db.prepare(`SELECT id,data FROM ${table}`).all() as {id:string;data:string}[]){const existing=JSON.parse(row.data) as {archivedAt?:string};if(existing.archivedAt)this.db.prepare(`UPDATE ${table} SET archived_at=? WHERE id=?`).run(existing.archivedAt,row.id);}
      }
    }
    for(const draft of this.drafts(true))if(draft.status==='authoring'){draft.status='failed';draft.error={code:'INTERRUPTED',message:'Authoring was interrupted. The preceding valid revision is preserved. Submit a new instruction to continue.'};this.saveDraft(draft);}
    for(const c of this.cases(true))if(c.status==='running'){
      const r=c.revisions.at(-1)!;r.executionStatus='interrupted';r.cleanupFinished=false;r.reviewStatus='invalidated';r.error={code:'INTERRUPTED',message:'Execution was interrupted; completed outputs are preserved and unfinished tasks are uncertain. Submit a correction to validate again.'};
      for(const task of r.tasks)if(task.status==='running'){task.status='uncertain';task.cleanupFinished=false;}
      c.status='interrupted';this.saveCase(c);this.emit(c.id,r.id,'status',{status:c.status,error:r.error});
    }
  }
  close(){this.db?.close();}
  private decode<T>(row:{data:string;archived_at?:string|null},archive:boolean):T {const value=JSON.parse(row.data) as Record<string,unknown>;if(archive){delete value.archivedAt;if(row.archived_at)value.archivedAt=row.archived_at;}return value as T;}
  private read<T>(table:string,id:string):T {const archive=table==='drafts'||table==='versions';const row=this.db.prepare(`SELECT data${archive?',archived_at':''} FROM ${table} WHERE id=?`).get(id) as {data:string;archived_at?:string|null}|undefined;if(!row)throw new HarnessError('NOT_FOUND',`${table.slice(0,-1)} not found.`,404);return this.decode<T>(row,archive);}
  private list<T>(table:string,includeArchived=true):T[]{const archive=table==='drafts'||table==='versions';return (this.db.prepare(`SELECT data${archive?',archived_at':''} FROM ${table}${archive&&!includeArchived?' WHERE archived_at IS NULL':''} ORDER BY rowid DESC`).all() as {data:string;archived_at?:string|null}[]).map(row=>this.decode<T>(row,archive));}
  getDraft(id:string){return this.read<WorkflowDraft>('drafts',id);}
  drafts(includeArchived=false){return this.list<WorkflowDraft>('drafts',includeArchived);}
  saveDraft(d:WorkflowDraft){const {archivedAt,...data}=d;this.db.prepare('INSERT INTO drafts(id,data,archived_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(d.id,JSON.stringify(data),archivedAt??null);}
  getVersion(id:string){return this.read<PublishedWorkflow>('versions',id);}
  versions(includeArchived=false){return this.list<PublishedWorkflow>('versions',includeArchived);}
  publish(v:PublishedWorkflow){const {archivedAt,...data}=v;this.db.prepare('INSERT INTO versions(id,workflow_id,version,data,archived_at) VALUES(?,?,?,?,?)').run(v.id,v.workflowId,v.version,JSON.stringify(data),archivedAt??null);}
  private archive<T extends WorkflowDraft|PublishedWorkflow>(table:'drafts'|'versions',id:string,archived:boolean):T {const existing=this.read<T>(table,id);const timestamp=archived?(existing.archivedAt??new Date().toISOString()):null;this.db.prepare(`UPDATE ${table} SET archived_at=? WHERE id=?`).run(timestamp,id);return this.read<T>(table,id);}
  archiveDraft(id:string,archived=true){return this.archive<WorkflowDraft>('drafts',id,archived);}
  archiveVersion(id:string,archived=true){return this.archive<PublishedWorkflow>('versions',id,archived);}
  getCase(id:string){return this.read<WorkflowCase>('cases',id);}
  cases(includeTests=false){return this.list<WorkflowCase>('cases').filter(c=>includeTests||!c.isTest);}
  saveCase(c:WorkflowCase){c.updatedAt=new Date().toISOString();this.db.prepare('INSERT INTO cases(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(c.id,JSON.stringify(c));}
  queues(){return this.list<QueueRecord>('queues');}
  emit(caseId:string,revisionId:string,type:CaseEvent['type'],data:Record<string,unknown>):CaseEvent {
    const row=this.db.prepare('SELECT COALESCE(MAX(id),0) AS last FROM case_events WHERE case_id=?').get(caseId) as {last:number};
    const event:CaseEvent={id:row.last+1,caseId,revisionId,type,data,createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO case_events(case_id,id,data) VALUES(?,?,?)').run(caseId,event.id,JSON.stringify(event));
    for(const listener of this.listeners.get(caseId)??[])listener(event);
    return event;
  }
  replay(caseId:string,after=0){this.getCase(caseId);return (this.db.prepare('SELECT data FROM case_events WHERE case_id=? AND id>? ORDER BY id').all(caseId,after) as {data:string}[]).map(row=>JSON.parse(row.data) as CaseEvent);}
  subscribe(caseId:string,listener:(event:CaseEvent)=>void){const set=this.listeners.get(caseId)??new Set();set.add(listener);this.listeners.set(caseId,set);return ()=>{set.delete(listener);if(!set.size)this.listeners.delete(caseId);};}
  /** No asynchronous gap between compare-and-swap, unique insertion and receipt. */
  commitApproval(expected: {caseId:string;revisionId:string;resultHash:string},receipt:Omit<ApprovalReceipt,'queueRecordId'|'duplicate'>,record:Omit<QueueRecord,'id'|'createdAt'>):ApprovalReceipt {
    this.db.exec('BEGIN IMMEDIATE');let transactionOpen=true;
    try{
      const c=this.getCase(expected.caseId);const r=c.revisions.at(-1)!;
      if(r.id!==expected.revisionId||r.resultHash!==expected.resultHash)throw new HarnessError('STALE_REVISION','The case has changed. Review the current revision.',409);
      const existingReceipt=c.approvals.find(a=>a.revisionId===r.id);
      if(existingReceipt){this.db.exec('COMMIT');transactionOpen=false;return existingReceipt;}
      if(c.isTest||c.status!=='awaiting_review'||r.reviewStatus!=='pending'||r.executionStatus!=='completed'||!r.cleanupFinished||r.disposition!=='ready')throw new HarnessError('APPROVAL_NOT_READY','Approval requires the completed, verified current revision and successful container cleanup.',409);
      const existing=this.db.prepare('SELECT data FROM queues WHERE destination=? AND business_key=?').get(record.destination,record.businessKey) as {data:string}|undefined;
      const prior=existing?JSON.parse(existing.data) as QueueRecord:undefined;
      if(prior&&prior.recordHash!==record.recordHash){c.status='conflict';r.reviewStatus='invalidated';this.saveCase(c);this.db.exec('COMMIT');transactionOpen=false;throw new HarnessError('QUEUE_CONFLICT','This business item was already committed with a different record. Employee review is required; the committed record was preserved.',409);}
      const queue:QueueRecord=prior??{...record,id:randomUUID(),createdAt:new Date().toISOString()};
      if(!prior)this.db.prepare('INSERT INTO queues(id,destination,business_key,record_hash,data) VALUES(?,?,?,?,?)').run(queue.id,queue.destination,queue.businessKey,queue.recordHash,JSON.stringify(queue));
      const approved:ApprovalReceipt={...receipt,queueRecordId:queue.id,duplicate:!!prior};
      this.db.prepare('INSERT INTO approvals(id,case_id,revision_id,data) VALUES(?,?,?,?)').run(approved.id,c.id,r.id,JSON.stringify(approved));
      c.approvals.push(approved);r.reviewStatus='approved';c.status='completed';this.saveCase(c);this.db.exec('COMMIT');transactionOpen=false;return approved;
    }catch(error){if(transactionOpen)this.db.exec('ROLLBACK');throw error;}
  }
}
