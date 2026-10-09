import { config } from '../server/config.js';
import { initializeDatabase } from '../server/database.js';
import { SandboxManager } from '../server/sandbox.js';
const manager=new SandboxManager({workspaceDir:config.workspaceDir,image:config.sandboxImage,commandTimeoutMs:config.commandTimeoutMs,maxOutputBytes:config.maxToolOutputBytes});
const database=await initializeDatabase(config,manager);
console.log(`${database.created?'Created':'Verified'} shared SQLite database: ${database.path}`);
