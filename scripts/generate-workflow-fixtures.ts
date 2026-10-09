import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';

// Run the document libraries in the existing image. Answer keys have a separate
// mount only for this trusted fixture generator, never for agents or task runs.
await mkdir(path.resolve('catalog/fixtures'),{recursive:true});
await mkdir(path.resolve('.agent-state/validation/workflows'),{recursive:true});
const args=['run','--rm','--network','none','--cap-drop=ALL','--security-opt','no-new-privileges:true','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--env','HOME=/tmp','--mount',`type=bind,source=${path.resolve('scripts/generate-workflow-fixtures.py')},target=/generate.py,readonly`,'--mount',`type=bind,source=${path.resolve('catalog/fixtures')},target=/fixtures`,'--mount',`type=bind,source=${path.resolve('.agent-state/validation/workflows')},target=/validation`,config.sandboxImage,'python','/generate.py','--output-dir','/fixtures','--validation-dir','/validation',...process.argv.slice(2)];
const child=spawn('docker',args,{stdio:'inherit'});child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('close',code=>{process.exitCode=code??1;});
