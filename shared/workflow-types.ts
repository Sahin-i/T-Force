import type { Attachment, AppError, Usage } from './types.js';

export type JsonSchema = { type?: 'object'|'array'|'string'|'number'|'integer'|'boolean'|'null'; properties?: Record<string,JsonSchema>; required?: string[]; additionalProperties?: boolean; items?: JsonSchema; enum?: unknown[]; minimum?: number; maximum?: number };
export interface WorkflowCondition { stepId: string; path: string; operator: 'eq'|'ne'|'exists'; value?: unknown }
export interface WorkflowInput { key: string; label: string; required: boolean; kind: 'file'|'json'; description?: string }
export interface WorkflowReference { path: string; title: string; sourceUrl?: string; fictional: boolean }
export interface WorkflowRule { id: string; text: string; source: string }
export interface ArtifactDeclaration { path: string; label: string; required: boolean; when?: WorkflowCondition }
export interface WorkflowStep {
  id: string; type: 'ai'|'python'|'review'|'queue'; title: string; instructions: string;
  inputs: string[]; outputSchema: JsonSchema; artifacts: ArtifactDeclaration[]; condition?: WorkflowCondition;
  script?: string; destination?: string; businessKeyPath?: string; recordPath?: string;
}
export interface WorkflowPackage {
  schemaVersion: 1; name: string; slug: string; purpose: string;
  inputs: WorkflowInput[]; references: WorkflowReference[]; rules: WorkflowRule[];
  deliverables: string[]; exceptions: string[]; approval: string;
  questions: string[]; assumptions: string[]; steps: WorkflowStep[];
  assets: Record<string,string>; synthetic: boolean;
}
export interface AuthoringMessage { id: string; role: 'user'|'assistant'; text: string; createdAt: string; attachments: Attachment[]; runId?: string }
export interface DraftRevision { id: string; number: number; packageHash: string; package: WorkflowPackage; createdAt: string; changeSummary: string; runId?: string; testReports: TestReport[] }
export interface WorkflowDraft { id: string; name: string; chatId: string; createdAt: string; updatedAt: string; status: 'idle'|'authoring'|'failed'; messages: AuthoringMessage[]; revisions: DraftRevision[]; activeRunId?: string; error?: AppError; candidateDiagnostics?: string[]; clonedFrom?: string; importedFrom?: string; archivedAt?: string }
export interface PublishedWorkflow { id: string; workflowId: string; version: number; name: string; packageHash: string; package: WorkflowPackage; publishedAt: string; draftId: string; revisionId: string; provenance: AuthoringMessage[]; testReport: TestReport; reviewedBy: string; archivedAt?: string }
export interface TestAssertion { path: string; operator: 'eq'|'exists'; value?: unknown }
export interface TestReport { id: string; revisionId: string; packageHash: string; caseId: string; createdAt: string; executionStatus: 'running'|'completed'|'failed'|'stopped'|'interrupted'; assertions: TestAssertion[]; assertionResults: {assertion:TestAssertion;passed:boolean;actual?:unknown}[]; assertionsPassed: boolean | null; error?: AppError; elapsedMs?:number; usage?:Usage }
export interface SourceSnapshot { id: string; name: string; originalPath: string; hash: string; size: number; kind: 'input'|'reference' }
export interface WorkflowArtifact { id: string; stepId: string; path: string; name: string; mime: string; size: number; hash: string; downloadUrl: string; contentUrl: string }
export interface Evidence { source: string; location?: string; quote?: string }
export interface BusinessFinding { code: string; message: string; evidence?: Evidence[] }
export type Disposition = 'ready'|'blocked'|'clarification'|'escalated';
export interface TaskCompletionManifest { stepId: string; result: Record<string,unknown>; artifacts: {path:string;name?:string;mime?:string}[] }
export interface TaskResult { stepId: string; status: 'running'|'completed'|'skipped'|'failed'|'uncertain'; startedAt: string; finishedAt?: string; result?: Record<string,unknown>; artifacts: WorkflowArtifact[]; usage: Usage; error?: AppError; cleanupFinished: boolean; progress?: string }
export interface CaseRevision { id: string; number: number; createdAt: string; inputData: Record<string,unknown>; sources: SourceSnapshot[]; tasks: TaskResult[]; executionStatus: 'queued'|'running'|'completed'|'failed'|'stopped'|'interrupted'; disposition?: Disposition; findings: BusinessFinding[]; artifacts: WorkflowArtifact[]; resultHash?: string; cleanupFinished: boolean; reviewStatus: 'pending'|'approved'|'rejected'|'invalidated'|'none'; error?: AppError; usage: Usage; elapsedMs?: number }
export interface WorkflowCase { id: string; title: string; workflowVersionId: string; workflowName: string; packageHash: string; createdAt: string; updatedAt: string; isTest: boolean; draftRevisionId?: string; status: 'running'|'awaiting_review'|'blocked'|'clarification'|'escalated'|'completed'|'failed'|'stopped'|'interrupted'|'rejected'|'conflict'; revisions: CaseRevision[]; approvals: ApprovalReceipt[] }
export interface ApprovalReceipt { id: string; caseId: string; revisionId: string; resultHash: string; artifactHashes: string[]; sourceHashes: string[]; approvedBy: string; approvedAt: string; destination: string; businessKey: string; queueRecordId: string; duplicate: boolean }
export interface QueueRecord { id: string; destination: string; businessKey: string; recordHash: string; record: Record<string,unknown>; caseId: string; revisionId: string; createdAt: string }
export interface CaseEvent { id: number; caseId: string; revisionId: string; type: 'task'|'findings'|'artifacts'|'review'|'status'|'error'; data: Record<string,unknown>; createdAt: string }
