import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { PublishedWorkflow, WorkflowDraft, WorkflowPackage } from '../shared/workflow-types.js';
import { WorkflowStore } from '../server/workflow-store.js';

function legacyRecords(){
  const timestamp='2026-01-01T00:00:00.000Z';const draft:WorkflowDraft={id:randomUUID(),chatId:randomUUID(),name:'Existing employee workflow',createdAt:timestamp,updatedAt:timestamp,status:'idle',messages:[],revisions:[]};
  const pkg:WorkflowPackage={schemaVersion:1,name:draft.name,slug:'existing-workflow',purpose:'Preserve historical procedures',inputs:[],references:[],rules:[],deliverables:[],exceptions:[],approval:'Employee review',questions:[],assumptions:[],steps:[],assets:{},synthetic:true};
  const revisionId=randomUUID();const report={id:randomUUID(),revisionId,packageHash:'a'.repeat(64),caseId:randomUUID(),createdAt:timestamp,executionStatus:'completed' as const,assertions:[],assertionResults:[],assertionsPassed:null};
  const version:PublishedWorkflow={id:randomUUID(),workflowId:draft.id,version:7,name:draft.name,packageHash:'a'.repeat(64),package:pkg,publishedAt:timestamp,draftId:draft.id,revisionId,provenance:[],testReport:report,reviewedBy:'Employee',archivedAt:timestamp};
  return {draft,version};
}

test('legacy SQLite metadata migrates idempotently and archiving never rewrites published payloads',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'archive-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(directory,{recursive:true});
  const filename=path.join(directory,'workflows.sqlite');const legacy=new DatabaseSync(filename);const {draft,version}=legacyRecords();
  legacy.exec('CREATE TABLE drafts(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE versions(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(workflow_id,version));');
  const payload=JSON.stringify(version);legacy.prepare('INSERT INTO drafts VALUES(?,?)').run(draft.id,JSON.stringify(draft));legacy.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(version.id,version.workflowId,version.version,payload);legacy.close();
  const store=new WorkflowStore(directory);await store.init();assert.equal(store.drafts().length,1);assert.equal(store.versions().length,0);assert.equal(store.versions(true).length,1);assert.equal(store.getVersion(version.id).archivedAt,version.archivedAt);
  const restored=store.archiveVersion(version.id,false);assert.equal(restored.archivedAt,undefined);assert.equal(restored.version,7);assert.deepEqual(restored.package,version.package);
  const archived=store.archiveVersion(version.id);assert.ok(archived.archivedAt);assert.equal(store.archiveVersion(version.id).archivedAt,archived.archivedAt,'Repeated archive calls preserve the first archive timestamp.');
  store.close();const inspection=new DatabaseSync(filename,{readOnly:true});assert.equal((inspection.prepare('SELECT data FROM versions WHERE id=?').get(version.id) as {data:string}).data,payload);for(const table of ['drafts','versions'])assert.ok((inspection.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).some(column=>column.name==='archived_at'));inspection.close();
  const reloaded=new WorkflowStore(directory);await reloaded.init();t.after(()=>reloaded.close());assert.equal(reloaded.getVersion(version.id).archivedAt,archived.archivedAt);assert.equal(reloaded.versions().length,0);assert.equal(reloaded.versions(true)[0].version,7);
});

test('in-flight draft saves preserve archive metadata and cannot restore or archive accidentally',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'archive-save-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=new WorkflowStore(directory);await store.init();t.after(()=>store.close());
  const {draft}=legacyRecords();store.saveDraft(draft);const stale=store.getDraft(draft.id);const archived=store.archiveDraft(draft.id);stale.name='Updated test report';store.saveDraft(stale);
  assert.equal(store.getDraft(draft.id).archivedAt,archived.archivedAt);assert.equal(store.drafts().length,0);assert.equal(store.getDraft(draft.id).name,'Updated test report');
  store.archiveDraft(draft.id,false);store.saveDraft(archived);assert.equal(store.getDraft(draft.id).archivedAt,undefined);assert.equal(store.drafts().length,1);
});
