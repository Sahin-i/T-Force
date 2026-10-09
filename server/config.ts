import dotenv from 'dotenv';
import path from 'node:path';
import { databaseRelativePath } from './database.js';
dotenv.config({quiet:true});
function integer(name:string, fallback:number, min=1, max=Number.MAX_SAFE_INTEGER):number {
  const value=Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
export const config={
  workspaceDir:path.resolve('workspace'),stateDir:path.resolve('.agent-state'),
  databasePath:databaseRelativePath(process.env.DEFAULT_SQLITE_DATABASE || 'data/office.sqlite'),
  port:integer('PORT',3001,1024,65535),model:process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-6-luna',
  endpoint:process.env.AZURE_OPENAI_ENDPOINT || '',apiKey:process.env.AZURE_OPENAI_API_KEY || '',
  sandboxImage:process.env.SANDBOX_IMAGE || 'office-agent-sandbox:local',
  maxIterations:integer('MAX_ITERATIONS',20,1,100),maxRunMs:integer('MAX_RUN_MS',600000,1000,3600000),
  commandTimeoutMs:integer('COMMAND_TIMEOUT_MS',120000,100,600000),maxToolOutputBytes:integer('MAX_TOOL_OUTPUT_BYTES',65536,1024,1048576),
  maxContextBytes:integer('MAX_CONTEXT_BYTES',1000000,1024,16000000),maxOutputTokens:integer('MAX_OUTPUT_TOKENS',12000,256,128000),modelRetries:integer('MODEL_RETRIES',2,0,5),
};
export type Config=typeof config;
