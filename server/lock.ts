import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError } from './errors.js';
export async function acquireApplicationLock(stateDir:string):Promise<()=>Promise<void>>{
  await fs.mkdir(stateDir,{recursive:true,mode:0o700});const filename=path.join(stateDir,'server.lock');const nonce=randomUUID();
  for(let attempt=0;attempt<3;attempt++){
    try{
      const handle=await fs.open(filename,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,nonce}));await handle.close();
      return async()=>{try{const lock=JSON.parse(await fs.readFile(filename,'utf8'));if(lock.nonce===nonce)await fs.unlink(filename);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      let owner:{pid:number};try{owner=JSON.parse(await fs.readFile(filename,'utf8'));}catch{throw new HarnessError('APP_ALREADY_RUNNING','An unreadable application lock exists. Ensure no backend is running before removing .agent-state/server.lock.');}
      if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw new HarnessError('APP_ALREADY_RUNNING','An invalid application lock exists. Ensure no backend is running before removing .agent-state/server.lock.');
      try{process.kill(owner.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH'){await fs.unlink(filename);continue;}throw new HarnessError('APP_ALREADY_RUNNING','Another backend owns this state directory. Stop it before starting a second instance.');}
      throw new HarnessError('APP_ALREADY_RUNNING','Another backend is already using this state directory. Stop it before starting a second instance.');
    }
  }
  throw new HarnessError('APP_ALREADY_RUNNING','Could not acquire the application state lock.');
}
