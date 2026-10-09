import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../server/config.js';
import { SandboxManager } from '../server/sandbox.js';
import type { Chat, Run, Health, WorkspaceFile } from '../shared/types.js';
const base=`http://127.0.0.1:${config.port}/api`;
async function api<T>(endpoint:string,options?:RequestInit):Promise<T>{const r=await fetch(base+endpoint,options);const body=await r.json();if(!r.ok)throw new Error(JSON.stringify(body));return body as T;}
const health=await api<Health>('/health');if(health.activeRun)throw new Error('An agent run is active; wait before verifying the shared database.');if(!health.database?.exists)throw new Error('Shared database is unavailable.');
const databaseFilesBefore=(await api<WorkspaceFile[]>('/files')).filter(file=>/\.(sqlite|sqlite3|db)$/i.test(file.path)).map(file=>file.path).sort();
const suffix=randomUUID().replaceAll('-','');const first=`verification_people_${suffix}`;const second=`verification_notes_${suffix}`;
const oldDatabase=path.join(config.workspaceDir,'outputs/customers.sqlite');let before:string|undefined;
try{before=createHash('sha256').update(await fs.readFile(oldDatabase)).digest('hex');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
async function run(text:string):Promise<Run>{
 const chat=await api<Chat>('/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 const {runId}=await api<{runId:string}>(`/chats/${chat.id}/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,attachments:[]})});
 console.log('Verification chat',chat.id,'run',runId);
 const response=await fetch(`${base}/runs/${runId}/events`);const reader=response.body!.getReader();const decoder=new TextDecoder();let buffer='';
 while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;
  while((index=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,index);buffer=buffer.slice(index+2);const line=event.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;const e=JSON.parse(line.slice(6));if(e.type==='text')process.stdout.write(e.data.delta);else if(e.type==='status'||e.type==='error')console.log('\n',e.type,e.data);else if(e.type==='tool')console.log('\nTool',e.data.tool.name,e.data.tool.status);}
 }
 const result=await api<Run>(`/runs/${runId}`);if(result.status!=='completed')throw new Error(`Database verification ${result.status}: ${JSON.stringify(result.error)}`);return result;
}
await run(`Test our shared database: inspect its schema, create two new independent verification tables named ${first} with columns id INTEGER PRIMARY KEY and name TEXT, and ${second} with columns id INTEGER PRIMARY KEY and note TEXT. Insert id=1,name='Shared database check' in the first and id=1,note='Another independent table' in the second. Commit and query both tables to verify. Use our configured DB, preserve existing data, and do not create a new SQLite file. Respond concisely.`);
await run(`In this fresh chat, query our database for the existing tables ${first} and ${second}. Report their row counts and stored text values. This is a read-only check: do not create or modify anything.`);
const databaseFilesAfter=(await api<WorkspaceFile[]>('/files')).filter(file=>/\.(sqlite|sqlite3|db)$/i.test(file.path)).map(file=>file.path).sort();
if(JSON.stringify(databaseFilesAfter)!==JSON.stringify(databaseFilesBefore))throw new Error('The agent created or removed a database file during the shared DB test.');
const manager=new SandboxManager({workspaceDir:config.workspaceDir,image:config.sandboxImage,commandTimeoutMs:config.commandTimeoutMs,maxOutputBytes:config.maxToolOutputBytes});
const sandbox=await manager.create('verify-shared-database',new AbortController().signal);
try{
 const result=await sandbox.exec(`python - <<'PY'
import sqlite3
from pathlib import Path
p=Path('/workspace/${config.databasePath}')
with sqlite3.connect(p.as_uri()+'?mode=rw',uri=True) as db:
 assert db.execute('SELECT name FROM "${first}" WHERE id=1').fetchone()[0]=='Shared database check'
 assert db.execute('SELECT note FROM "${second}" WHERE id=1').fetchone()[0]=='Another independent table'
 assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
 # Remove only the two uniquely named verification tables created by this test.
 db.execute('DROP TABLE "${first}"');db.execute('DROP TABLE "${second}"')
print('Both unrelated tables verified in one shared database across two independent chats; verification tables cleaned up.')
PY`);if(result.exitCode!==0)throw new Error(result.stderr);console.log(result.stdout);
}finally{await sandbox.dispose();}
if(before&&createHash('sha256').update(await fs.readFile(oldDatabase)).digest('hex')!==before)throw new Error('The existing customer database was changed.');
console.log('PASS: actual agent writes and reads across chats target the configured shared database; existing customer database unchanged.');
