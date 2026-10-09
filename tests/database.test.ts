import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { databaseRelativePath, databaseContainerPath, databaseStatus } from '../server/database.js';
import { agentSystemPrompt } from '../server/prompt.js';

test('shared database paths remain inside the workspace and reject private storage',()=>{
  assert.equal(databaseRelativePath('data/office.sqlite'),'data/office.sqlite');
  assert.equal(databaseContainerPath('/workspace/data/shared.sqlite'),'/workspace/data/shared.sqlite');
  for(const value of ['','../outside.sqlite','/etc/private.sqlite','C:\\secret.sqlite','data/../private.sqlite','data//a.sqlite','.agent-state/db.sqlite','data/.env','data/.env.secret','data/db\0.sqlite'])assert.throws(()=>databaseRelativePath(value),{code:'DATABASE_CONFIG'});
});
test('every model request receives an explicit shared database target with no implicit creation',()=>{
  const prompt=agentSystemPrompt('data/general.sqlite');
  assert.match(prompt,/\/workspace\/data\/general\.sqlite/);assert.match(prompt,/mode=rw/);assert.match(prompt,/mode=ro/);assert.match(prompt,/Do not create a separate database per file/);assert.match(prompt,/any number of unrelated tables/);assert.match(prompt,/do not create an empty replacement/);
});
test('database health reports missing, invalid and escaping paths accurately',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'database-status-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={workspaceDir:root,databasePath:'data/office.sqlite'};
  assert.equal((await databaseStatus(config)).exists,false);
  await fs.mkdir(path.join(root,'data'));await fs.writeFile(path.join(root,'data/office.sqlite'),'not SQLite');assert.match((await databaseStatus(config)).error||'',/valid SQLite/);
  await fs.unlink(path.join(root,'data/office.sqlite'));await fs.symlink(path.join(root,'outside.sqlite'),path.join(root,'data/office.sqlite'));assert.match((await databaseStatus(config)).error||'',/symbolic link/);
});
