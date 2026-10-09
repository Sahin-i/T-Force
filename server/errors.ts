import OpenAI from 'openai';
import type { AppError } from '../shared/types.js';
export class HarnessError extends Error {
  constructor(public code:string,message:string,public statusCode=500,public details?:string){super(message);}
}
export function appError(error:unknown):AppError {
  if(error instanceof HarnessError)return {code:error.code,message:error.message,...(error.details?{details:error.details}:{})};
  const e=error as {code?:string;message?:string;status?:number;statusCode?:number};
  const message=e?.message || String(error);
  if(/context[_ ](length|window)|maximum context|too many tokens/i.test(message))return {code:'CONTEXT_LIMIT',message:'This chat exceeds the model context limit. Your chat is preserved; start a new chat to continue.'};
  if(error instanceof OpenAI.APIConnectionTimeoutError||e?.status===408)return {code:'MODEL_TIMEOUT',message:'The Azure model request timed out. No pending tool action was executed. Try again when the connection is available.'};
  if(error instanceof OpenAI.APIConnectionError)return {code:'MODEL_CONNECTION_ERROR',message:'The backend could not reach the Azure model endpoint. Check the connection and retry.'};
  if(e?.status===401||e?.status===403)return {code:'AZURE_AUTH',message:'Azure rejected the credentials or access permissions. Check the backend Azure configuration.'};
  if(e?.status===404)return {code:'MISSING_DEPLOYMENT',message:'The configured Azure deployment was not found. Create the gpt-6-luna deployment in the configured resource.'};
  if(e?.status===429)return {code:'RATE_LIMIT',message:'Azure rate limit or quota was reached. Wait before retrying or check the deployment quota.'};
  return {code:e?.code || 'RUN_FAILED',message:message.slice(0,2000)};
}
