import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../server/config.js';
import { initializeDatabase, databaseStatus } from '../server/database.js';
import { SandboxManager } from '../server/sandbox.js';

test('one persistent SQLite database holds unrelated tables across Docker runs without creating per-file databases',{skip:process.env.RUN_DOCKER_TESTS!=='1',timeout:60000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'shared-database-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cfg={...config,workspaceDir:path.join(root,'workspace'),stateDir:path.join(root,'state'),databasePath:'data/office.sqlite'};
 const manager=new SandboxManager({workspaceDir:cfg.workspaceDir,image:cfg.sandboxImage,commandTimeoutMs:10000,maxOutputBytes:8192});
 assert.equal((await manager.readiness()).ready,true);
 assert.equal((await initializeDatabase(cfg,manager)).created,true);assert.equal((await databaseStatus(cfg)).exists,true);
 const first=await manager.create('database-first-chat',new AbortController().signal);
 try{
  const result=await first.exec(`python - <<'PY'
import sqlite3
from pathlib import Path
p=Path('/workspace/data/office.sqlite')
with sqlite3.connect(p.as_uri()+'?mode=rw',uri=True) as db:
 db.execute('PRAGMA foreign_keys=ON')
 db.execute('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
 db.execute('CREATE TABLE projects (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
 db.execute('INSERT INTO people VALUES (?,?)',(1,'Test person'))
 db.execute('INSERT INTO projects VALUES (?,?)',(1,'Test project'))
print('committed')
PY`);assert.equal(result.exitCode,0,result.stderr);
 }finally{await first.dispose();}
 assert.equal((await initializeDatabase(cfg,manager)).created,false);
 const second=await manager.create('database-second-chat',new AbortController().signal);
 try{
  const result=await second.exec(`python - <<'PY'
import sqlite3
from pathlib import Path
p=Path('/workspace/data/office.sqlite')
with sqlite3.connect(p.as_uri()+'?mode=ro',uri=True) as db:
 assert db.execute('SELECT name FROM people WHERE id=1').fetchone()[0]=='Test person'
 assert db.execute('SELECT title FROM projects WHERE id=1').fetchone()[0]=='Test project'
 assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
try: sqlite3.connect(Path('/workspace/data/missing.sqlite').as_uri()+'?mode=rw',uri=True)
except sqlite3.OperationalError: pass
else: raise RuntimeError('Missing database was silently created')
assert not Path('/workspace/data/missing.sqlite').exists()
print('Two tables preserved across runs')
PY`);assert.equal(result.exitCode,0,result.stderr);assert.match(result.stdout,/Two tables preserved/);
 }finally{await second.dispose();}
 assert.deepEqual(await fs.readdir(path.join(cfg.workspaceDir,'data')),['office.sqlite']);
 await fs.rename(path.join(cfg.workspaceDir,'data/office.sqlite'),path.join(cfg.workspaceDir,'data/saved.sqlite'));
 await assert.rejects(initializeDatabase(cfg,manager),{code:'DATABASE_UNAVAILABLE'});assert.equal((await databaseStatus(cfg)).exists,false);
 await fs.rename(path.join(cfg.workspaceDir,'data/saved.sqlite'),path.join(cfg.workspaceDir,'data/office.sqlite'));
 assert.equal((await initializeDatabase(cfg,manager)).created,false);
});
