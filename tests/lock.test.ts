import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireApplicationLock } from '../server/lock.js';
test('application lock prevents a second backend from interrupting the active backend',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agent-lock-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const release=await acquireApplicationLock(directory);await assert.rejects(acquireApplicationLock(directory),{code:'APP_ALREADY_RUNNING'});await release();
 const again=await acquireApplicationLock(directory);await again();
});
