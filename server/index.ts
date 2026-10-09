import { config } from './config.js';
import { createApp } from './app.js';
import { acquireApplicationLock } from './lock.js';
import { initializeDatabase } from './database.js';
import { appError } from './errors.js';
import { closeApplication } from './shutdown.js';
const release=await acquireApplicationLock(config.stateDir);
let app:Awaited<ReturnType<typeof createApp>>['app']|undefined;
try{
  const created=await createApp(config);app=created.app;const {sandboxes}=created;
  await initializeDatabase(config,sandboxes).then(db=>console.log(`Shared database: ${db.path}${db.created?' (created)':''}`)).catch(error=>console.warn('Shared database unavailable:',appError(error).message));
  await app.listen({host:'127.0.0.1',port:config.port});
  console.log(`T-force agent: http://127.0.0.1:${config.port}`);
  let closing=false;
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(!closing){closing=true;void closeApplication(app,release).then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});}});
}catch(error){try{await closeApplication(app,release);}catch(cleanupError){console.error('Cleanup after startup failure:',cleanupError);}throw error;}
