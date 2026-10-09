export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export interface Attachment { path: string; name: string; size: number; mime: string }
export interface WorkspaceFile extends Attachment { modifiedAt: string }
export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface AppError { code: string; message: string; details?: string }
export interface ToolActivity { id: string; name: string; arguments: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'uncertain'; output?: string; error?: AppError; startedAt?: string; finishedAt?: string }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; attachments: Attachment[]; tools: ToolActivity[]; runId?: string; status?: RunStatus; usage?: Usage; artifacts?: WorkspaceFile[]; error?: AppError; elapsedMs?: number }
export interface ChatSummary { id: string; title: string; createdAt: string; updatedAt: string }
export interface Chat extends ChatSummary { messages: Message[] }
export interface Run { id: string; chatId: string; messageId: string; status: RunStatus; startedAt: string; finishedAt?: string; model: string; usage: Usage; error?: AppError; tools: ToolActivity[]; containerName?: string }
export interface RunEvent { id: number; runId: string; type: 'text' | 'tool' | 'tool_output' | 'status' | 'usage' | 'error' | 'files' | 'reset'; data: Record<string, unknown>; createdAt: string }
export interface Health { model: string; database?: { path:string; exists:boolean; error?:string }; activeRun: Run | null; activeExecution?: {id:string;kind:string}|null; docker: {ready:boolean; error?:string}; azure: {configured:boolean; endpoint?:string}; limits: {fileBytes:number; uploadBytes:number} }
