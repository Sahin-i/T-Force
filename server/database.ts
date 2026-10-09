import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { SandboxManager } from './sandbox.js';
import { HarnessError } from './errors.js';

export function databaseRelativePath(value: string): string {
  const relative=value.startsWith('/workspace/')?value.slice('/workspace/'.length):value;
  const parts=relative.split('/');
  if(!relative||path.posix.isAbsolute(relative)||path.win32.isAbsolute(relative)||relative.includes('\\')||relative.includes('\0')||parts.some(part=>!part||part==='.'||part==='..'||['.git','.agent-state','.env','.codex','.agents','.aws'].includes(part)||part.startsWith('.env.'))) {
    throw new HarnessError('DATABASE_CONFIG','DEFAULT_SQLITE_DATABASE must be a relative file path inside the shared workspace.');
  }
  return relative;
}
export function databaseContainerPath(value: string): string {return `/workspace/${databaseRelativePath(value)}`;}

export async function databaseStatus(config: Pick<Config,'workspaceDir'|'databasePath'>): Promise<{path:string;exists:boolean;error?:string}> {
  const relative=databaseRelativePath(config.databasePath);const containerPath=databaseContainerPath(relative);
  try{
    let current=path.resolve(config.workspaceDir);
    for(const component of relative.split('/')){current=path.join(current,component);if((await fs.lstat(current)).isSymbolicLink())throw new Error('The shared database path contains a symbolic link.');}
    const info=await fs.stat(current);if(!info.isFile())throw new Error('The shared database path is not a regular file.');
    const handle=await fs.open(current,'r');
    try{const header=Buffer.alloc(16);await handle.read(header,0,16,0);if(!header.equals(Buffer.from('SQLite format 3\0')))throw new Error('The shared database is not a valid SQLite file.');}finally{await handle.close();}
    return {path:containerPath,exists:true};
  }catch(error){return {path:containerPath,exists:false,error:(error as NodeJS.ErrnoException).code==='ENOENT'?'Shared database is missing. Initialize it with npm run db:init.':error instanceof Error?error.message:String(error)};}
}

// Application initialization is explicit and separate from agent-run tools. A
// marker prevents a deleted database from being silently replaced on restart.
export async function initializeDatabase(config: Pick<Config,'workspaceDir'|'stateDir'|'databasePath'>,manager:SandboxManager):Promise<{path:string;created:boolean}> {
  const relative=databaseRelativePath(config.databasePath);const containerPath=databaseContainerPath(relative);
  const markerPath=path.join(config.stateDir,'database.json');
  let marker:{path:string}|undefined;
  try{marker=JSON.parse(await fs.readFile(markerPath,'utf8')) as {path:string};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const mayCreate=marker?.path!==containerPath;
  const readiness=await manager.readiness();
  if(!readiness.ready)throw new HarnessError('DOCKER_UNAVAILABLE',readiness.error||'Docker is required to initialize the shared database.');
  const controller=new AbortController();const sandbox=await manager.create('database-initialization',controller.signal);
  try{
    const result=await sandbox.exec(`python - <<'PY'
import json, sqlite3
from pathlib import Path
settings=json.loads(${JSON.stringify(JSON.stringify({path:containerPath,mayCreate}))})
root=Path('/workspace').resolve();target=Path(settings['path'])
if not target.resolve().is_relative_to(root): raise RuntimeError('Database path resolves outside /workspace')
current=root
for part in target.relative_to(root).parts:
 current=current/part
 if current.is_symlink(): raise RuntimeError('Database path must not contain symbolic links')
existed=target.exists()
if not existed and not settings['mayCreate']: raise RuntimeError('Shared database was previously initialized but is now missing. Restore it; do not create an empty replacement.')
if existed and not target.is_file(): raise RuntimeError('Database path is not a regular file')
if not existed: target.parent.mkdir(parents=True,exist_ok=True)
mode='rw' if existed else 'rwc'
with sqlite3.connect(target.as_uri()+'?mode='+mode,uri=True,timeout=10) as db:
 db.execute('PRAGMA foreign_keys=ON')
 if not existed: db.execute('PRAGMA user_version=1')
 check=db.execute('PRAGMA quick_check').fetchone()[0]
 if check!='ok': raise RuntimeError('SQLite integrity check failed: '+str(check))
print(json.dumps({'path':str(target),'created':not existed}))
PY`,{signal:controller.signal});
    if(result.exitCode!==0)throw new HarnessError('DATABASE_UNAVAILABLE','Unable to initialize the shared SQLite database.',503,result.stderr||result.stdout);
    const initialized=JSON.parse(result.stdout) as {path:string;created:boolean};
    await fs.mkdir(config.stateDir,{recursive:true,mode:0o700});
    const temporary=`${markerPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary,JSON.stringify({path:containerPath,initializedAt:new Date().toISOString()}),{mode:0o600});await fs.rename(temporary,markerPath);
    return initialized;
  }finally{await sandbox.dispose();}
}
