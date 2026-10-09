import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Archive, ArchiveRestore, ArrowDownToLine, ArrowLeft, ArrowUp, BadgeCheck, BookOpen, Check, ChevronRight, CircleAlert, Clock3, Copy, Database, FileCode2, FileSpreadsheet, FileText, FlaskConical, GitBranch, HardDrive, Layers, ListChecks, LoaderCircle, Menu, MessageSquare, Paperclip, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Square, UploadCloud, Workflow, X } from 'lucide-react';
import type { AppError, Attachment, Health, Run, RunEvent, WorkspaceFile } from '../shared/types';
import type { ApprovalReceipt, AuthoringMessage, BusinessFinding, CaseEvent, CaseRevision, DraftRevision, PublishedWorkflow, QueueRecord, TestAssertion, TestReport, WorkflowArtifact, WorkflowCase, WorkflowCondition, WorkflowDraft, WorkflowPackage } from '../shared/workflow-types';
import { api, errorInfo, post } from './api';
import './workflow.css';

export type AppPage = 'chat' | 'workflows' | 'create' | 'cases';
interface WorkflowExample { id: string; name: string; description: string; statements: string[]; files: { name: string; mime: string; size: number; downloadUrl: string }[] }
const INVOICE_STATEMENTS = ['Compare the supplier invoice with the purchase order.', 'Flag quantity, price or total mismatches.', 'Create a short review summary with the amount and any issues.', 'Ask for employee approval before adding a matching invoice to the payment list.'];
const isArchived = (item: object | null | undefined) => !!(item as { archivedAt?: string } | null | undefined)?.archivedAt;
const friendlyDestination = (value?: string) => ({ accounting: 'Accounting list', provisioning: 'Provisioning list', resolution: 'Resolution list', payments: 'Payment list', payment_list: 'Payment list' }[value ?? ''] ?? recordLabel(value ?? 'Payment list'));
interface EvaluationReport {
  generatedAt?: string;
  provenance: string;
  metrics: { scenarios: number; passed: number; falseReady: number; falseBlocked: number; extractionAccuracy: number; artifactCorrectness: number; duplicateRecords: number; duplicatesPrevented: number; elapsedMs: number; totalTokens: number };
  baseline: { status: string; reason?: string };
}

const OfficePreview = lazy(() => import('./OfficePreview'));
const PdfPreview = lazy(() => import('./PdfPreview'));
const NAV: { page: AppPage; label: string; icon: typeof Workflow }[] = [
  { page: 'chat', label: 'Chat', icon: MessageSquare }, { page: 'workflows', label: 'Workflows', icon: Layers }, { page: 'create', label: 'Create workflow', icon: Plus }, { page: 'cases', label: 'Cases', icon: ListChecks },
];
const activeExecution = (status: string | undefined) => status === 'running' || status === 'queued';
const runActive = (status: string | undefined) => status === 'running' || status === 'queued';
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const time = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const duration = (value?: number) => value === undefined ? '' : value < 60000 ? `${(value / 1000).toFixed(1)}s` : `${Math.floor(value / 60000)}m ${Math.floor(value % 60000 / 1000)}s`;
const latestRevision = <T extends { revisions: { id: string }[] }>(value: T | null | undefined) => value?.revisions.at(-1);
const idPath = (id: string) => encodeURIComponent(id);
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
function mergeUpdated<T extends { id: string; updatedAt: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) {
    const old = merged.get(item.id);
    if (!old || item.updatedAt >= old.updatedAt) merged.set(item.id, item);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function getValue(value: unknown, dotted: string): unknown {
  if (!dotted || dotted.length > 512) return undefined;
  let current = value;
  for (const key of dotted.split('.')) {
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key) || !current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function recordLabel(key: string): string {
  const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function RecordMapping({ record }: { record: Record<string, unknown> }) {
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: unknown, depth = 0) => {
    if (depth > 32) { rows.push({ label, value: 'See advanced details' }); return; }
    if (Array.isArray(value)) {
      if (!value.length) rows.push({ label, value: 'None' });
      else if (value.every(item => item === null || typeof item !== 'object')) rows.push({ label, value: value.map(item => item === null ? 'Not provided' : String(item)).join(', ') });
      else value.forEach((item, index) => add(`${label} ${index + 1}`, item, depth + 1));
    } else if (value && typeof value === 'object') {
      const fields = value as Record<string, unknown>;
      const money = typeof fields.currency === 'string' && ['number', 'string'].includes(typeof fields.value);
      if (money) rows.push({ label, value: `${fields.currency} ${String(fields.value)}` });
      const entries = Object.entries(fields).filter(([key]) => !money || !['value', 'currency'].includes(key));
      if (!entries.length && !money) rows.push({ label, value: 'No details' });
      for (const [key, item] of entries) add(`${label} · ${recordLabel(key)}`, item, depth + 1);
    } else rows.push({ label, value: value === null || value === undefined ? 'Not provided' : String(value) });
  };
  for (const [key, value] of Object.entries(record)) add(recordLabel(key), value);
  return <dl className="wf-record-mapping">{rows.map((row, index) => <div key={index}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}{!rows.length && <div><dt>Record</dt><dd>No additional fields.</dd></div>}</dl>;
}
function objectJSON(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text.trim() || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Structured inputs must be a JSON object.');
  return value as Record<string, unknown>;
}
function assertionsJSON(text: string): TestAssertion[] {
  const value: unknown = JSON.parse(text.trim() || '[]');
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path || !['eq', 'exists'].includes(item.operator) || (item.operator === 'eq' && !Object.prototype.hasOwnProperty.call(item, 'value')))) throw new Error('Assertions must be an array with a path, operator (eq or exists), and an expected value for eq.');
  return value as TestAssertion[];
}

interface ComposerDraft { text: string; files: Attachment[]; uploads: number; inputs: string }
export interface WorkflowComposerState { author: Record<string, ComposerDraft>; correction: Record<string, ComposerDraft> }
// Setters retain the scope that started the request. A late upload must never
// append documents to a different draft or correction after navigation.
function scopedComposer(scope: string, values: Record<string, ComposerDraft>, setValues: Dispatch<SetStateAction<Record<string, ComposerDraft>>>, initialInputs = '{}') {
  const empty = (): ComposerDraft => ({ text: '', files: [], uploads: 0, inputs: initialInputs });
  const value = values[scope] ?? empty();
  const update = (change: (current: ComposerDraft) => ComposerDraft) => setValues(current => ({ ...current, [scope]: change(current[scope] ?? empty()) }));
  return {
    text: value.text, files: value.files, uploading: value.uploads > 0, inputs: value.inputs,
    setText: (text: string) => update(current => ({ ...current, text })),
    setFiles: (files: SetStateAction<Attachment[]>) => update(current => ({ ...current, files: typeof files === 'function' ? files(current.files) : files })),
    setUploading: (uploading: boolean) => update(current => ({ ...current, uploads: Math.max(0, current.uploads + (uploading ? 1 : -1)) })),
    setInputs: (inputs: string) => update(current => ({ ...current, inputs })),
  };
}

export function WorkflowNavigation({ page, onNavigate }: { page: AppPage; onNavigate: (page: AppPage) => void }) {
  return <nav className="workflow-navigation" aria-label="Main navigation">{NAV.map(item => <button type="button" key={item.page} className={page === item.page ? 'active' : ''} onClick={() => onNavigate(item.page)} aria-current={page === item.page ? 'page' : undefined}><item.icon size={17} /><span>{item.label}</span></button>)}</nav>;
}
function Notice({ error, onDismiss }: { error: AppError; onDismiss?: () => void }) {
  return <div className="wf-error" role="alert"><CircleAlert size={16} /><div><p>{error.message}</p>{error.details && <details><summary>Details</summary><pre>{error.details}</pre></details>}</div>{onDismiss && <button type="button" className="icon-button" aria-label="Dismiss error" onClick={onDismiss}><X size={15} /></button>}</div>;
}
function authorIssue(error: AppError): AppError {
  return ['INVALID_PACKAGE', 'PACKAGE_LIMIT', 'INVALID_MANIFEST', 'JSON_LIMIT', 'UNSAFE_PACKAGE_PATH', 'INVALID_TASK_RESULT'].includes(error.code)
    ? { code: error.code, message: 'T-force could not finish this draft. Try again or clarify your instructions.' }
    : error;
}
function Badge({ value }: { value: string }) {
  const color = ['failed', 'blocked', 'rejected', 'conflict', 'uncertain'].includes(value) ? 'red' : ['clarification', 'escalated', 'interrupted', 'stopped', 'outdated', 'awaiting_review'].includes(value) ? 'amber' : ['completed', 'approved', 'ready', 'passed'].includes(value) ? '' : 'gray';
  const labels: Record<string, string> = { running: 'Working', queued: 'Waiting', completed: 'Done', awaiting_review: 'Ready for review', blocked: 'Needs correction', clarification: 'Needs information', escalated: 'Needs investigation', failed: 'Could not finish', ready: 'Ready', approved: 'Approved', rejected: 'Rejected', interrupted: 'Interrupted', stopped: 'Stopped', outdated: 'Earlier draft' };
  return <span className={`wf-badge ${color}`}>{labels[value] ?? recordLabel(value)}</span>;
}
function Empty({ title, children, icon = Workflow }: { title: string; children: ReactNode; icon?: typeof Workflow }) {
  const Icon = icon;
  return <div className="wf-empty"><Icon size={31} strokeWidth={1.5} /><h3>{title}</h3>{children}</div>;
}
function Markdown({ text }: { text: string }) {
  return <div className="wf-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>{text}</ReactMarkdown></div>;
}
function conditionLabel(condition: WorkflowCondition): string {
  const path = `${condition.stepId}.${condition.path}`;
  return condition.operator === 'exists' ? `${path} is present` : `${path} ${condition.operator === 'eq' ? 'equals' : 'does not equal'} ${JSON.stringify(condition.value)}`;
}
function revisionChanges(previous: DraftRevision | undefined, revision: DraftRevision | null): string[] {
  if (!previous || !revision) return [];
  const changes: string[] = [];
  const before = previous.package; const after = revision.package;
  if (before.name !== after.name) changes.push(`Renamed procedure to ${after.name}.`);
  if (before.purpose !== after.purpose) changes.push('Updated the procedure purpose.');
  for (const rule of after.rules) {
    const old = before.rules.find(item => item.id === rule.id);
    if (!old || old.text !== rule.text || old.source !== rule.source) changes.push(`${old ? 'Updated' : 'Added'} rule: ${rule.text}`);
  }
  for (const rule of before.rules) if (!after.rules.some(item => item.id === rule.id)) changes.push(`Removed rule: ${rule.text}`);
  if (pretty(before.inputs) !== pretty(after.inputs)) changes.push('Updated required inputs.');
  for (const step of after.steps) {
    const old = before.steps.find(item => item.id === step.id);
    if (!old) changes.push(`Added step: ${step.title}.`);
    else if (pretty(old) !== pretty(step)) changes.push(`Updated step: ${step.title}.`);
  }
  for (const step of before.steps) if (!after.steps.some(item => item.id === step.id)) changes.push(`Removed step: ${step.title}.`);
  for (const [asset, content] of Object.entries(after.assets)) if (before.assets[asset] !== content) changes.push(`${asset in before.assets ? 'Changed' : 'Added'} package asset: ${asset}.`);
  for (const asset of Object.keys(before.assets)) if (!(asset in after.assets)) changes.push(`Removed package asset: ${asset}.`);
  if (pretty(before.questions) !== pretty(after.questions)) changes.push('Updated unresolved policy questions.');
  if (pretty(before.assumptions) !== pretty(after.assumptions)) changes.push('Updated declared assumptions.');
  if (pretty(before.references) !== pretty(after.references)) changes.push('Updated reference data.');
  return changes.length ? changes : ['No executable package changes were imported in this revision.'];
}
function PackageReview({ package: pkg }: { package: WorkflowPackage }) {
  const conditionText = (condition: WorkflowCondition) => condition.path === 'disposition' && condition.value === 'ready'
    ? condition.operator === 'eq' ? 'When the documents match' : 'When something needs attention'
    : `${recordLabel(condition.path)} ${condition.operator === 'exists' ? 'is available' : condition.operator === 'eq' ? 'is' : 'is not'} ${condition.operator === 'exists' ? '' : String(condition.value)}`;
  return <div className="wf-package">
    <h2 className="wf-package-title">{pkg.name}</h2><p className="wf-package-purpose">{pkg.purpose}</p>
    {pkg.synthetic && <div className="wf-package-meta"><span className="wf-badge amber">Fictional sample data</span></div>}
    <section className="wf-section"><h3><Workflow size={12} />What it does</h3>{pkg.steps.map((step, i) => <div className="wf-step wf-simple-step" key={step.id}><div className="wf-step-heading"><span className="wf-step-number">{i + 1}</span><h4>{step.title}</h4></div>{step.type === 'review' && <p>{step.instructions}</p>}{step.condition && <div className="wf-step-condition"><GitBranch size={11} /><span>{conditionText(step.condition)}</span></div>}{step.type === 'queue' && <p>Add the approved item to the {friendlyDestination(step.destination).toLowerCase()}.</p>}</div>)}</section>
    <section className="wf-section"><h3><Paperclip size={12} />Documents it needs</h3>{pkg.inputs.map(input => <div className="wf-info-row" key={input.key}><span className={`wf-badge ${input.required ? '' : 'gray'}`}>{input.required ? 'Required' : 'Optional'}</span><strong>{input.label}</strong>{input.description && <p>{input.description}</p>}</div>)}</section>
    {!!pkg.rules.length && <section className="wf-section"><h3><ListChecks size={12} />Checks to review</h3>{pkg.rules.map(rule => <div className="wf-info-row" key={rule.id}>{rule.text}<div className="wf-reference"><BookOpen size={11} /><span>{pkg.references.find(reference => reference.path === rule.source)?.title ?? 'Employee instructions'}</span></div></div>)}</section>}
    <section className="wf-section"><h3><FileText size={12} />What you get</h3>{pkg.deliverables.map((item, i) => <div className="wf-info-row" key={i}>{item}</div>)}</section>
    <section className="wf-section"><h3><ShieldCheck size={12} />Your approval</h3><div className="wf-info-row">{pkg.approval}</div></section>
    {!!pkg.questions.length && <div className="wf-change wf-questions"><strong><CircleAlert size={13} />A few things to clarify</strong><ul>{pkg.questions.map((item, i) => <li key={i}>{item}</li>)}</ul><p>Reply in the conversation before publishing.</p></div>}
    {!!pkg.exceptions.length && <details className="wf-plain-details"><summary>When something needs attention</summary>{pkg.exceptions.map((item, i) => <p key={i}>{item}</p>)}</details>}
    {!!pkg.assumptions.length && <details className="wf-plain-details"><summary>Assumptions to review</summary>{pkg.assumptions.map((item, i) => <p key={i}>{item}</p>)}</details>}
    <details className="wf-advanced"><summary>Advanced: steps, scripts and references</summary>
      {pkg.steps.map(step => <div className="wf-step" key={step.id}><h4>{step.title}</h4><p>{step.instructions}</p><div className="wf-reference">{step.type} · {step.id} · Uses {step.inputs.join(', ')}</div>{step.condition && <p className="wf-reference">{conditionLabel(step.condition)}</p>}<details><summary>Structured outputs</summary><pre>{pretty(step.outputSchema)}</pre></details>{step.script && <details><summary>Script: {step.script}</summary><pre>{pkg.assets[step.script]}</pre></details>}{step.artifacts.map(item => <div className="wf-reference" key={item.path}>{item.label} · {item.path}{item.when && ` · ${conditionLabel(item.when)}`}</div>)}</div>)}
      {pkg.references.map((reference, i) => <div className="wf-info-row" key={i}><strong>{reference.title}</strong><p>{reference.path}{reference.fictional ? ' · Fictional' : ''}</p>{reference.sourceUrl && /^https?:\/\//i.test(reference.sourceUrl) && <a href={reference.sourceUrl} target="_blank" rel="noopener noreferrer">Public reference</a>}</div>)}
      {Object.entries(pkg.assets).map(([path, content]) => <details className="wf-step" key={path}><summary>{path}</summary><pre>{content}</pre></details>)}
    </details>
  </div>;
}
function TestResults({ report, currentHash, onInspect }: { report: TestReport; currentHash: string; onInspect: () => void }) {
  const outdated = report.packageHash !== currentHash;
  return <div className="wf-tests"><div className="wf-tests-top"><FlaskConical size={15} /><strong>Sample run</strong><Badge value={outdated ? 'outdated' : report.executionStatus} /></div><p>{outdated ? 'This sample used an earlier draft. Try the current draft before publishing.' : report.executionStatus === 'completed' ? 'The sample run finished. Review its findings and files before publishing.' : report.executionStatus === 'running' ? 'Checking the sample documents…' : `The sample run ${report.executionStatus}.`}</p>{report.assertions.length > 0 && <p>{report.assertionsPassed === true ? 'Passed all specified assertions.' : report.assertionsPassed === false ? 'One or more specified assertions failed.' : 'Additional checks are still running.'}</p>}{report.error && <Notice error={report.error} />}<button type="button" className="wf-button" onClick={onInspect}><Search size={13} />Review sample result</button><details className="wf-advanced"><summary>Advanced: test checks and run details</summary><p>A completed run confirms execution. Accuracy requires reviewing the result{report.assertions.length ? ' and the specified checks' : ''}.</p><div className="wf-hash">{report.packageHash}</div>{report.assertionResults.map((result, i) => <div className={`wf-test-assertion ${result.passed ? '' : 'failed'}`} key={i}>{result.passed ? <Check size={12} /> : <CircleAlert size={12} />}<span>{result.assertion.path} {result.assertion.operator === 'exists' ? 'exists' : `= ${JSON.stringify(result.assertion.value)}`}<small>Actual: {JSON.stringify(result.actual) ?? 'missing'}</small></span></div>)}<p>{duration(report.elapsedMs)}{report.usage && ` · ${report.usage.totalTokens.toLocaleString()} tokens`}</p></details></div>;
}
function EvaluationPanel({ report }: { report: EvaluationReport }) {
  const metrics = report.metrics;
  return <section className="wf-evaluation" aria-labelledby="wf-evaluation-title">
    <div className="wf-evaluation-heading"><span className="wf-card-icon"><FlaskConical size={20} /></span><div><h3 id="wf-evaluation-title">Recorded catalog evaluation</h3><p>Fictional fixture run{report.generatedAt && ` · ${time(report.generatedAt)}`}</p></div><span className={`wf-badge ${metrics.passed < metrics.scenarios ? 'amber' : ''}`}>{metrics.passed}/{metrics.scenarios} scenarios passed</span></div>
    <div className="wf-evaluation-metrics">
      <div><strong>{metrics.falseReady}</strong><span>Incorrectly ready</span></div><div><strong>{metrics.falseBlocked}</strong><span>Incorrectly blocked</span></div>
      <div><strong>{(metrics.extractionAccuracy * 100).toFixed(1)}%</strong><span>Extracted fields correct</span></div><div><strong>{(metrics.artifactCorrectness * 100).toFixed(0)}%</strong><span>Artifacts correct</span></div>
      <div><strong>{metrics.duplicateRecords}</strong><span>Duplicate queue records</span></div><div><strong>{duration(metrics.scenarios ? metrics.elapsedMs / metrics.scenarios : 0)}</strong><span>Mean case execution</span></div>
    </div>
    <p className="wf-evaluation-note">Deterministic catalog recipes were evaluated using actual source files, isolated task containers, independently parsed artifacts and local queue records. {report.baseline.status === 'not_run' ? 'Live-model quality and the general-agent comparison remain unmeasured.' : report.baseline.status === 'running' ? 'The live-model general-agent comparison is still running.' : report.baseline.status === 'failed' ? 'The live-model comparison failed; its limitations are recorded below.' : 'A separate live-model general-agent comparison is recorded.'}</p>
    <details><summary>Method, execution usage and comparison status</summary><p>{report.provenance}</p><p>{metrics.duplicatesPrevented} repeated submissions prevented · {duration(metrics.elapsedMs)} total case execution · {metrics.totalTokens.toLocaleString()} execution tokens</p><p>General-agent comparison: {report.baseline.status.replaceAll('_', ' ')}.{report.baseline.reason && ` ${report.baseline.reason}`}</p><a className="wf-button" href="/api/workflow-evaluations" target="_blank" rel="noopener noreferrer"><ArrowDownToLine size={12} />Open evaluation report</a></details>
  </section>;
}
function Files({ files, onRemove }: { files: Attachment[]; onRemove: (path: string) => void }) {
  return <div className="wf-files">{files.map(file => <div className="wf-file-chip" key={file.path}><FileText size={14} /><span>{file.name}</span><small>{bytes(file.size)}</small><button type="button" className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => onRemove(file.path)}><X size={13} /></button></div>)}</div>;
}
function Upload({ onFiles, uploading }: { onFiles: (files: FileList) => void; uploading: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <><input ref={input} type="file" multiple hidden onChange={event => { if (event.target.files) onFiles(event.target.files); event.target.value = ''; }} /><button className="wf-upload-zone" type="button" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle size={23} className="spin" /> : <UploadCloud size={23} strokeWidth={1.5} />}<strong>{uploading ? 'Uploading files…' : 'Upload source documents'}</strong><span>Policies, PDFs, spreadsheets, documents or record snapshots</span></button></>;
}
function Findings({ findings }: { findings: BusinessFinding[] }) {
  return <>{findings.map((finding, i) => <div className="wf-finding" key={`${finding.code}-${i}`}><CircleAlert size={15} /><div><h4>{recordLabel(finding.code)}</h4><p>{finding.message}</p>{finding.evidence?.map((evidence, index) => <div className="wf-reference" key={index}><BookOpen size={11} /><span>{evidence.source}{evidence.location && ` · ${evidence.location}`}{evidence.quote && ` · “${evidence.quote}”`}</span></div>)}</div></div>)}</>;
}
function ArtifactPreview({ artifact, onClose }: { artifact: WorkflowArtifact; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const image = /^(image\/)(png|jpeg|gif|webp|bmp)$/.test(artifact.mime);
  const pdf = artifact.mime === 'application/pdf' || /\.pdf$/i.test(artifact.name);
  const office = /\.(docx|xlsx)$/i.test(artifact.name);
  const textual = artifact.mime.startsWith('text/') || /\.(txt|md|json|csv|tsv|py|html|xml|log)$/i.test(artifact.name);
  const file: WorkspaceFile = { path: artifact.path, name: artifact.name, size: artifact.size, mime: artifact.mime, modifiedAt: artifact.hash };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], iframe, input, [tabindex="0"]') ?? []);
      if ((event.target as Node | null)?.ownerDocument && (event.target as Node).ownerDocument !== document) {
        const index = items.indexOf(document.activeElement as HTMLElement); event.preventDefault(); items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      } else if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    const frameDocuments = new Set<Document>();
    const frames = new Map<HTMLIFrameElement, () => void>();
    const attachFrames = () => {
      for (const frame of dialogRef.current?.querySelectorAll<HTMLIFrameElement>('iframe') ?? []) {
        if (frames.has(frame)) continue;
        const attach = () => { try { const child = frame.contentDocument; if (child && !frameDocuments.has(child)) { child.addEventListener('keydown', keydown); frameDocuments.add(child); } } catch { /* External frames cannot receive listeners. */ } };
        frames.set(frame, attach); frame.addEventListener('load', attach); attach();
      }
    };
    const observer = new MutationObserver(attachFrames);
    if (dialogRef.current) observer.observe(dialogRef.current, { childList: true, subtree: true });
    attachFrames(); document.addEventListener('keydown', keydown);
    return () => { observer.disconnect(); for (const [frame, attach] of frames) frame.removeEventListener('load', attach); for (const child of frameDocuments) child.removeEventListener('keydown', keydown); document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
  useEffect(() => {
    if (!textual || office || pdf || image) return;
    const controller = new AbortController();
    void fetch(artifact.contentUrl, { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(`Could not load artifact (${response.status}).`); const reader = response.body?.getReader(); if (!reader) return ''; let result = ''; let total = 0; const decoder = new TextDecoder(); while (true) { const item = await reader.read(); if (item.done) break; total += item.value.length; result += decoder.decode(item.value, { stream: true }); if (total >= 256 * 1024) { await reader.cancel(); result += '\n\nPreview truncated. Download to view the complete file.'; break; } } return result; }).then(value => setText(value)).catch(error => { if (!controller.signal.aborted) setError(errorInfo(error)); });
    return () => controller.abort();
  }, [artifact.contentUrl, textual, office, pdf, image]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="wf-preview-title"><header><span className="preview-file-icon"><FileText size={20} /></span><div><h2 id="wf-preview-title">{artifact.name}</h2><p>{bytes(artifact.size)} · Verified case artifact</p></div><a className="button secondary" href={artifact.downloadUrl} download={artifact.name}><ArrowDownToLine size={15} />Download</a><button type="button" ref={closeRef} className="icon-button" aria-label="Close preview" onClick={onClose}><X size={20} /></button></header><div className={`preview-body ${image ? 'image-preview' : ''}`}>{image ? <img src={artifact.contentUrl} alt={artifact.name} onError={() => setError({ code: 'preview_error', message: 'This image could not be previewed. Download the verified artifact to inspect it.' })} /> : pdf ? <Suspense fallback={<div className="wf-loading"><LoaderCircle className="spin" size={22} />Loading PDF preview</div>}><PdfPreview file={file} contentURL={artifact.contentUrl} downloadURL={artifact.downloadUrl} /></Suspense> : office ? <Suspense fallback={<div className="wf-loading"><LoaderCircle className="spin" size={22} />Loading document preview</div>}><OfficePreview file={file} contentURL={artifact.contentUrl} downloadURL={artifact.downloadUrl} /></Suspense> : textual ? text === null && !error ? <div className="wf-loading"><LoaderCircle className="spin" size={22} />Loading artifact</div> : text !== null && (artifact.mime === 'text/markdown' || /\.md$/i.test(artifact.name)) ? <div className="wf-document-markdown"><Markdown text={text} /></div> : <pre className="wf-preview-text">{text}</pre> : <Empty title="Download this artifact" icon={FileText}><p>A preview is unavailable for this format.</p><a className="wf-button" href={artifact.downloadUrl} download={artifact.name}>Download file</a></Empty>}{error && <Notice error={error} />}</div></section></div>;
}

export default function WorkflowApp({ page, onNavigate, health, onExecutionChange, composers, onComposersChange }: { page: AppPage; onNavigate: (page: AppPage) => void; health: Health | null; onExecutionChange: () => Promise<Health>; composers: WorkflowComposerState; onComposersChange: Dispatch<SetStateAction<WorkflowComposerState>> }) {
  const [examples, setExamples] = useState<WorkflowExample[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [showPastCases, setShowPastCases] = useState(false);
  const [testUseOriginal, setTestUseOriginal] = useState(true);
  const [catalog, setCatalog] = useState<PublishedWorkflow[]>([]);
  const [drafts, setDrafts] = useState<WorkflowDraft[]>([]);
  const [cases, setCases] = useState<WorkflowCase[]>([]);
  const [queues, setQueues] = useState<QueueRecord[]>([]);
  const [evaluation, setEvaluation] = useState<EvaluationReport | null>(null);
  const [draftId, setDraftId] = useState<string | null>(() => localStorage.getItem('office.workflow-draft'));
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [catalogId, setCatalogId] = useState<string | null>(null);
  const [caseId, setCaseId] = useState<string | null>(() => localStorage.getItem('office.workflow-case'));
  const [caseRevisionId, setCaseRevisionId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const { text: authorText, setText: setAuthorText, files: authorFiles, setFiles: setAuthorFiles, uploading: authorUploading, setUploading: setAuthorUploading } = scopedComposer(draftId ?? 'new', composers.author, update => onComposersChange(current => ({ ...current, author: typeof update === 'function' ? update(current.author) : update })));
  const [authorLive, setAuthorLive] = useState<{ runId: string; text: string; status: string; connected: boolean; progress?: string } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testInputs, setTestInputs] = useState('{}');
  const [testAssertions, setTestAssertions] = useState('[]');
  const [testFiles, setTestFiles] = useState<Attachment[]>([]);
  const [testUploading, setTestUploading] = useState(false);
  const [newCaseOpen, setNewCaseOpen] = useState(false);
  const [caseWorkflowId, setCaseWorkflowId] = useState('');
  const [caseTitle, setCaseTitle] = useState('');
  const [caseInputs, setCaseInputs] = useState('{}');
  const [caseFiles, setCaseFiles] = useState<Attachment[]>([]);
  const [caseUploading, setCaseUploading] = useState(false);
  const [approvalChecked, setApprovalChecked] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [preview, setPreview] = useState<WorkflowArtifact | null>(null);
  const [connected, setConnected] = useState(false);
  const [caseFilter, setCaseFilter] = useState('');
  const actionRef = useRef(false);
  const modalUploadingRef = useRef(false);
  const selectionIntent = useRef({ draft: false, case: false });
  const eventIds = useRef<Record<string, number>>({});
  const authorEvents = useRef<Record<string, number>>({});
  const authorRef = useRef(authorLive);
  const draftRef = useRef(draftId);
  const caseRef = useRef(caseId);
  const authorInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const authorScroll = useRef<HTMLDivElement>(null);
  authorRef.current = authorLive; draftRef.current = draftId; caseRef.current = caseId;
  modalUploadingRef.current = testUploading || caseUploading;

  const draft = drafts.find(item => item.id === draftId) ?? null;
  const currentRevision = draft?.revisions.find(item => item.id === revisionId) ?? draft?.revisions.at(-1) ?? null;
  const published = catalog.find(item => item.id === catalogId) ?? null;
  const currentCase = cases.find(item => item.id === caseId) ?? null;
  const caseWorkflow = catalog.find(item => item.id === currentCase?.workflowVersionId) ?? null;
  const currentCaseRevision = currentCase?.revisions.find(item => item.id === caseRevisionId) ?? currentCase?.revisions.at(-1) ?? null;
  const latestCaseRevision = currentCase?.revisions.at(-1) ?? null;
  const { text: correctionText, setText: setCorrectionText, inputs: correctionInputs, setInputs: setCorrectionInputs, files: correctionFiles, setFiles: setCorrectionFiles, uploading: correctionUploading, setUploading: setCorrectionUploading } = scopedComposer(latestCaseRevision?.id ?? 'no-case', composers.correction, update => onComposersChange(current => ({ ...current, correction: typeof update === 'function' ? update(current.correction) : update })), pretty(latestCaseRevision?.inputData ?? {}));
  const isCurrentCaseRevision = !!currentCaseRevision && currentCaseRevision.id === latestCaseRevision?.id;
  const authoring = draft?.status === 'authoring' || runActive(authorLive?.status);
  const sharedExecution = health?.activeExecution;
  const executionBusy = !!sharedExecution || drafts.some(item => item.status === 'authoring') || cases.some(item => activeExecution(item.revisions.at(-1)?.executionStatus));
  const ownsExecution = sharedExecution?.kind === 'authoring' ? sharedExecution.id === (draft?.activeRunId ?? authorLive?.runId) : sharedExecution?.kind === 'workflow' && sharedExecution.id === caseId;
  const ready = !!health?.docker.ready && !!health.azure.configured;
  const activeVersions = catalog.filter(item => !isArchived(item)).sort((a, b) => b.version - a.version);
  const activeCatalog = activeVersions.filter((item, index) => activeVersions.findIndex(other => other.workflowId === item.workflowId) === index).sort((a, b) => Number(b.package.slug === 'invoice-check') - Number(a.package.slug === 'invoice-check') || b.publishedAt.localeCompare(a.publishedAt));
  const visibleCatalog = showArchived ? [...activeCatalog, ...catalog.filter(item => isArchived(item))] : activeCatalog;
  const visibleDrafts = drafts.filter(item => showArchived || !isArchived(item));
  const sampleDocuments = [...new Map((draft?.messages ?? []).flatMap(message => message.attachments).filter(file => !/^(?:package|.*[-_]template)\.json$/i.test(file.name)).map(file => [file.name, file])).values()];
  const testDocumentsMissing = !!currentRevision?.package.inputs.some(input => input.kind === 'file' && input.required) && (testUseOriginal ? sampleDocuments.length === 0 : testFiles.length === 0);
  const selectedRunWorkflow = catalog.find(item => item.id === caseWorkflowId);
  const packageReady = (pkg?: WorkflowPackage | null) => !!health?.docker.ready && !!pkg && (!pkg.steps.some(step => step.type === 'ai') || !!health.azure.configured);
  const sampleReady = packageReady(currentRevision?.package);
  const caseReady = packageReady(selectedRunWorkflow?.package);
  const correctionReady = packageReady(caseWorkflow?.package);
  const caseDocumentsMissing = !!selectedRunWorkflow?.package.inputs.some(input => input.kind === 'file' && input.required) && caseFiles.length === 0;
  const currentReport = currentRevision?.testReports.at(-1);
  const packageChanges = revisionChanges(draft?.revisions.find(item => item.number === (currentRevision?.number ?? 0) - 1), currentRevision);
  const publishable = !!currentRevision && currentRevision.id === draft?.revisions.at(-1)?.id && currentRevision.package.questions.length === 0 && !!currentReport && currentReport.packageHash === currentRevision.packageHash && currentReport.executionStatus === 'completed' && (currentReport.assertions.length === 0 || currentReport.assertionsPassed === true) && !authoring && !isArchived(draft);
  const sourceCount = currentCaseRevision?.sources.length ?? 0;
  const receipt = currentCase?.approvals.find(item => item.revisionId === currentCaseRevision?.id);
  const reviewStep = caseWorkflow?.package.steps.find(item => item.type === 'review');
  const queueStep = caseWorkflow?.package.steps.find(item => item.type === 'queue');
  const verifiedResults = Object.fromEntries((currentCaseRevision?.tasks ?? []).filter(task => task.status === 'completed' && task.result).map(task => [task.stepId, task.result]));
  const queueValue = queueStep?.recordPath ? getValue(verifiedResults, queueStep.recordPath) : undefined;
  const proposedRecord = queueValue && typeof queueValue === 'object' && !Array.isArray(queueValue) ? queueValue as Record<string, unknown> : null;
  const proposedBusinessKey = queueStep?.businessKeyPath ? getValue(verifiedResults, queueStep.businessKeyPath) : undefined;
  const reviewDetailsReady = !!reviewStep && !!queueStep && !!proposedRecord && typeof proposedBusinessKey === 'string' && !!proposedBusinessKey.trim();

  const loadAll = useCallback(async (initial = false) => {
    const results = await Promise.allSettled([api<PublishedWorkflow[]>('/workflows?includeArchived=true'), api<WorkflowDraft[]>('/workflow-drafts?includeArchived=true'), api<WorkflowCase[]>('/cases?includeTests=true'), api<QueueRecord[]>('/queues'), api<EvaluationReport | null>('/workflow-evaluations').catch(() => null)]);
    if (results[0].status === 'fulfilled') setCatalog(results[0].value);
    if (results[1].status === 'fulfilled') { const value = results[1].value; setDrafts(current => mergeUpdated(current, value)); }
    if (results[2].status === 'fulfilled') { const value = results[2].value; setCases(current => mergeUpdated(current, value)); }
    if (results[3].status === 'fulfilled') setQueues(results[3].value);
    if (results[4].status === 'fulfilled') setEvaluation(results[4].value);
    if (initial) {
      if (!selectionIntent.current.draft && draftRef.current && results[1].status === 'fulfilled') { const storedDraft = results[1].value.find(item => item.id === draftRef.current); if (!storedDraft || isArchived(storedDraft)) setDraftId(null); }
      if (!selectionIntent.current.case && caseRef.current && results[0].status === 'fulfilled' && results[2].status === 'fulfilled') {
        const stored = results[2].value.find(item => item.id === caseRef.current);
        const version = results[0].value.find(item => item.id === stored?.workflowVersionId);
        const owner = stored?.isTest && results[1].status === 'fulfilled' ? results[1].value.find(item => item.revisions.some(revision => revision.id === stored.draftRevisionId)) : null;
        if (!stored || (stored.isTest ? !owner || isArchived(owner) : isArchived(version))) setCaseId(null);
      }
    }
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected' && initial) setError(errorInfo(failed.reason));
    setLoading(false);
  }, []);
  const loadDraft = useCallback(async (id: string) => { const result = await api<WorkflowDraft>(`/workflow-drafts/${idPath(id)}`); setDrafts(items => mergeUpdated(items, [result])); return result; }, []);
  const loadCase = useCallback(async (id: string) => { const result = await api<WorkflowCase>(`/cases/${idPath(id)}`); setCases(items => mergeUpdated(items, [result])); return result; }, []);
  useEffect(() => { void loadAll(true); void api<WorkflowExample[]>('/workflow-examples').then(setExamples).catch(() => {}); }, [loadAll]);
  useEffect(() => { if (sharedExecution) void loadAll(); }, [sharedExecution?.id, sharedExecution?.kind, loadAll]);
  useEffect(() => { void onExecutionChange().catch(() => {}); }, [draft?.status, latestCaseRevision?.executionStatus, authorLive?.status, onExecutionChange]);
  useEffect(() => { if (caseId) void loadCase(caseId).catch(error => setError(errorInfo(error))); }, [caseId, loadCase]);
  useEffect(() => { if (draftId) localStorage.setItem('office.workflow-draft', draftId); else localStorage.removeItem('office.workflow-draft'); }, [draftId]);
  useEffect(() => { if (caseId) localStorage.setItem('office.workflow-case', caseId); else localStorage.removeItem('office.workflow-case'); }, [caseId]);
  useEffect(() => { setReviewed(false); }, [currentRevision?.id, currentReport?.id, currentReport?.executionStatus]);
  useEffect(() => {
    if (!testOpen && !newCaseOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = document.querySelector<HTMLElement>('.wf-modal-text');
    dialog?.querySelector<HTMLElement>('select, input:not([type=file]), textarea, button')?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !actionRef.current && !modalUploadingRef.current) { setTestOpen(false); setNewCaseOpen(false); }
      if (event.key !== 'Tab') return;
      const items = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, a[href]') ?? []).filter(item => item.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); previous?.focus(); };
  }, [testOpen, newCaseOpen]);

  useEffect(() => { setApprovalChecked(false); setShowReject(false); setRejectionReason(''); }, [latestCaseRevision?.id]);
  useEffect(() => { authorScroll.current?.scrollTo({ top: authorScroll.current.scrollHeight }); }, [authorLive?.text, draft?.messages.length]);
  useEffect(() => {
    if (!draft?.activeRunId || !authoring || authorLive?.runId === draft.activeRunId) return;
    authorEvents.current[draft.activeRunId] = 0;
    setAuthorLive({ runId: draft.activeRunId, text: '', status: 'running', connected: false });
  }, [draft?.activeRunId, authoring, authorLive?.runId]);
  useEffect(() => {
    const active = drafts.some(item => item.status === 'authoring' || item.revisions.some(revision => revision.testReports.some(report => report.executionStatus === 'running'))) || cases.some(item => activeExecution(item.revisions.at(-1)?.executionStatus));
    if (!active) return;
    const timer = window.setInterval(() => { void loadAll(); }, 3000);
    return () => clearInterval(timer);
  }, [drafts, cases, loadAll]);
  useEffect(() => {
    const runId = authorLive?.runId;
    if (!runId || !runActive(authorLive?.status)) return;
    let source: EventSource | null = null; let timer: number | undefined; let disposed = false; let retries = 0;
    const restore = async () => {
      const run = await api<Run>(`/runs/${idPath(runId)}`);
      if (disposed) return;
      setAuthorLive(current => current?.runId === runId ? { ...current, status: run.status } : current);
      if (!runActive(run.status)) { source?.close(); if (draftRef.current) await loadDraft(draftRef.current); await loadAll(); }
    };
    const connect = () => {
      if (disposed) return;
      source = new EventSource(`/api/runs/${idPath(runId)}/events?after=${authorEvents.current[runId] ?? 0}`);
      source.onopen = () => { retries = 0; setAuthorLive(current => current?.runId === runId ? { ...current, connected: true } : current); void restore().catch(() => {}); };
      source.addEventListener('run', raw => {
        let event: RunEvent; try { event = JSON.parse((raw as MessageEvent).data) as RunEvent; } catch { return; }
        if (event.runId !== runId || event.id <= (authorEvents.current[runId] ?? 0)) return;
        authorEvents.current[runId] = event.id;
        setAuthorLive(current => { if (!current || current.runId !== runId) return current; if (event.type === 'text' && typeof event.data.delta === 'string') return { ...current, text: current.text + event.data.delta, progress: undefined }; if (event.type === 'status' && typeof event.data.status === 'string') return { ...current, status: event.data.status, progress: typeof event.data.detail === 'string' ? event.data.detail : undefined }; return current; });
        if (event.type === 'reset' || (event.type === 'status' && !runActive(event.data.status as string))) void restore().catch(error => setError(errorInfo(error)));
      });
      source.onerror = () => { source?.close(); if (disposed) return; setAuthorLive(current => current?.runId === runId ? { ...current, connected: false } : current); void restore().catch(() => {}); timer = window.setTimeout(connect, Math.min(1000 * 2 ** retries++, 10000)); };
    };
    connect();
    return () => { disposed = true; source?.close(); if (timer) clearTimeout(timer); };
  }, [authorLive?.runId, authorLive?.status, loadDraft, loadAll]);
  useEffect(() => {
    if (!caseId || !activeExecution(latestCaseRevision?.executionStatus)) { setConnected(false); return; }
    const id = caseId; let source: EventSource | null = null; let timer: number | undefined; let refreshTimer: number | undefined; let disposed = false; let retries = 0;
    const refresh = () => { if (refreshTimer) return; refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void loadCase(id).then(result => { if (result.isTest) void loadAll(); if (result.status === 'completed') void api<QueueRecord[]>('/queues').then(setQueues); }).catch(error => { if (!disposed) setError(errorInfo(error)); }); }, 100); };
    const connect = () => {
      if (disposed) return;
      source = new EventSource(`/api/cases/${idPath(id)}/events?after=${eventIds.current[id] ?? 0}`);
      source.onopen = () => { retries = 0; setConnected(true); refresh(); };
      const event = (raw: Event) => {
        let item: CaseEvent; try { item = JSON.parse((raw as MessageEvent).data) as CaseEvent; } catch { return; }
        if (item.caseId !== id || item.id <= (eventIds.current[id] ?? 0)) return;
        eventIds.current[id] = item.id; refresh();
      };
      source.addEventListener('case', event);
      source.onmessage = event;
      source.addEventListener('reset', refresh);
      source.onerror = () => { source?.close(); if (disposed) return; setConnected(false); refresh(); timer = window.setTimeout(connect, Math.min(1000 * 2 ** retries++, 10000)); };
    };
    connect();
    return () => { disposed = true; source?.close(); if (timer) clearTimeout(timer); if (refreshTimer) clearTimeout(refreshTimer); };
  }, [caseId, latestCaseRevision?.id, latestCaseRevision?.executionStatus, loadCase, loadAll]);

  async function action(name: string, task: () => Promise<void>) {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(name); setError(null);
    try { await task(); } catch (error) {
      setError(errorInfo(error));
      // Restore authoritative state after an ambiguous response; never repeat a mutation.
      void loadAll();
      if (caseRef.current) void loadCase(caseRef.current).catch(() => {});
      if (draftRef.current) void loadDraft(draftRef.current).catch(() => {});
    } finally { actionRef.current = false; setBusy(null); void onExecutionChange().catch(() => {}); }
  }
  async function upload(files: FileList, target: 'author' | 'test' | 'case' | 'correction') {
    const list = Array.from(files); if (!list.length) return;
    const setUploading = { author: setAuthorUploading, test: setTestUploading, case: setCaseUploading, correction: setCorrectionUploading }[target];
    const setFiles = { author: setAuthorFiles, test: setTestFiles, case: setCaseFiles, correction: setCorrectionFiles }[target];
    const fileLimit = health?.limits.fileBytes ?? 25 * 1024 * 1024; const uploadLimit = health?.limits.uploadBytes ?? 100 * 1024 * 1024;
    if (list.some(file => file.size > fileLimit) || list.reduce((sum, file) => sum + file.size, 0) > uploadLimit) { setError({ code: 'upload_too_large', message: `Each file must be ${bytes(fileLimit)} or smaller; total uploads must be ${bytes(uploadLimit)} or smaller.` }); return; }
    setUploading(true); setError(null);
    const form = new FormData(); for (const file of list) form.append('files', file, file.name);
    try { const result = await api<{ files: Attachment[] }>('/files/upload', { method: 'POST', body: form }); setFiles(current => [...current, ...result.files]); } catch (error) { setError(errorInfo(error)); } finally { setUploading(false); }
  }
  function selectDraft(id: string | null) { selectionIntent.current.draft = true; setDraftId(id); setRevisionId(null); setAuthorLive(null); setMobileMenu(false); setError(null); onNavigate('create'); if (id) void loadDraft(id).catch(error => setError(errorInfo(error))); }
  function selectCase(id: string | null) { selectionIntent.current.case = true; setCaseId(id); setCaseRevisionId(null); setMobileMenu(false); setError(null); onNavigate('cases'); if (id) void loadCase(id).catch(error => setError(errorInfo(error))); }
  async function sendAuthor(event?: FormEvent) {
    event?.preventDefault(); if (executionBusy || authoring || authorUploading || !ready || (!authorText.trim() && !authorFiles.length)) return;
    const submission = { text: authorText.trim(), attachments: authorFiles };
    if (isArchived(draft)) return;
    await action('author', async () => {
      selectionIntent.current.draft = true;
      let id = draftId;
      if (!id) { const created = await post<WorkflowDraft>('/workflow-drafts', {}); id = created.id; setDrafts(current => [created, ...current]); setDraftId(id); draftRef.current = id; }
      const { runId } = await post<{ runId: string }>(`/workflow-drafts/${idPath(id)}/messages`, submission);
      setAuthorText(''); setAuthorFiles([]); setRevisionId(null);
      setAuthorLive({ runId, text: '', status: 'running', connected: false });
      await loadDraft(id);
    });
  }
  async function importWorkflow(file: File) {
    if (file.size > 8 * 1024 * 1024) { setError({ code: 'import_too_large', message: 'Workflow JSON must be 8 MiB or smaller.' }); return; }
    await action('import', async () => {
      let value: unknown;
      try { value = JSON.parse(await file.text()); }
      catch { throw new Error('This file is not valid JSON. Choose a workflow package or an exported workflow.'); }
      const pkg = value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'package') ? (value as { package: unknown }).package : value;
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Workflow JSON must contain a workflow package object.');
      const imported = await post<WorkflowDraft>('/workflow-drafts/import', { package: pkg, sourceLabel: file.name });
      setDrafts(items => mergeUpdated(items, [imported]));
      selectDraft(imported.id);
    });
  }
  async function testRevision(event: FormEvent) {
    event.preventDefault(); if (executionBusy || testUploading || !sampleReady || testDocumentsMissing || !draft || !currentRevision) return;
    await action('test', async () => {
      const inputData = objectJSON(testInputs); const assertions = assertionsJSON(testAssertions);
      const result = await post<{ caseId: string; reportId: string }>(`/workflow-drafts/${idPath(draft.id)}/test`, { revisionId: currentRevision.id, ...(testInputs.trim() !== '{}' && testInputs.trim() ? { inputData } : {}), ...(testUseOriginal ? {} : { attachments: testFiles }), ...(assertions.length ? { assertions } : {}) });
      setTestOpen(false); selectionIntent.current.case = true; await loadDraft(draft.id); await loadCase(result.caseId); setCaseId(result.caseId); setCaseRevisionId(null); onNavigate('cases');
    });
  }
  async function publishRevision() {
    if (!draft || !currentRevision || !reviewed || !publishable) return;
    await action('publish', async () => { const result = await post<PublishedWorkflow>(`/workflow-drafts/${idPath(draft.id)}/publish`, { revisionId: currentRevision.id, reviewed: true, reviewedBy: 'Employee' }); await loadAll(); setCatalogId(result.id); onNavigate('workflows'); });
  }
  async function cloneWorkflow(workflow: PublishedWorkflow) {
    await action('clone', async () => { const result = await post<WorkflowDraft>(`/workflows/${idPath(workflow.id)}/clone`); setDrafts(items => [result, ...items]); selectDraft(result.id); });
  }
  function startCase(workflowId?: string) { setCaseWorkflowId(workflowId ?? activeCatalog[0]?.id ?? ''); setCaseInputs('{}'); setCaseTitle(''); setCaseFiles([]); setNewCaseOpen(true); }
  async function submitCase(event: FormEvent) {
    event.preventDefault(); if (executionBusy || caseUploading || !caseReady || !caseWorkflowId || caseDocumentsMissing) return;
    await action('case', async () => { const result = await post<WorkflowCase>('/cases', { workflowVersionId: caseWorkflowId, title: caseTitle.trim() || undefined, inputData: objectJSON(caseInputs), attachments: caseFiles }); setNewCaseOpen(false); setCases(items => [result, ...items]); selectCase(result.id); });
  }
  async function correctCase(event: FormEvent) {
    event.preventDefault(); if (executionBusy || correctionUploading || !correctionReady || !currentCase || !latestCaseRevision) return;
    await action('correction', async () => { const result = await post<WorkflowCase>(`/cases/${idPath(currentCase.id)}/corrections`, { revisionId: latestCaseRevision.id, inputData: objectJSON(correctionInputs), attachments: correctionFiles, text: correctionText.trim() }); setCases(items => items.map(item => item.id === result.id ? result : item)); setCaseRevisionId(null); setCorrectionFiles([]); setCorrectionText(''); });
  }
  async function approveCase() {
    if (!currentCase || !currentCaseRevision?.resultHash || !approvalChecked) return;
    await action('approve', async () => { await post<ApprovalReceipt>(`/cases/${idPath(currentCase.id)}/approve`, { revisionId: currentCaseRevision.id, resultHash: currentCaseRevision.resultHash, approvedBy: 'Employee' }); await loadCase(currentCase.id); await loadAll(); });
  }
  async function rejectCase(event: FormEvent) {
    event.preventDefault(); if (!currentCase || !currentCaseRevision || !rejectionReason.trim()) return;
    await action('reject', async () => { await post(`/cases/${idPath(currentCase.id)}/reject`, { revisionId: currentCaseRevision.id, reason: rejectionReason.trim() }); await loadCase(currentCase.id); setShowReject(false); });
  }
  async function useExample(target: 'author' | 'case') {
    await action('sample', async () => {
      const example = examples.find(item => item.id === 'invoice-check');
      const result = await post<{ files: Attachment[] }>('/workflow-examples/invoice-check/files');
      if (target === 'author') { setAuthorText((example?.statements ?? INVOICE_STATEMENTS).join('\n')); setAuthorFiles(result.files); }
      else setCaseFiles(result.files);
    });
  }
  async function archiveItem(kind: 'draft' | 'workflow', item: WorkflowDraft | PublishedWorkflow, archived = true) {
    await action('archive', async () => {
      if (kind === 'draft') { const updated = await post<WorkflowDraft>(`/workflow-drafts/${idPath(item.id)}/archive`, { archived }); setDrafts(items => items.map(value => value.id === updated.id ? updated : value)); if (archived && draftId === updated.id) selectDraft(null); }
      else { const version = item as PublishedWorkflow; const targets = archived ? catalog.filter(value => value.workflowId === version.workflowId && !isArchived(value)) : [version]; for (const target of targets) { const updated = await post<PublishedWorkflow>(`/workflows/${idPath(target.id)}/archive`, { archived }); setCatalog(items => items.map(value => value.id === updated.id ? updated : value)); } if (archived) setCatalogId(null); }
    });
  }
  const closePreview = useCallback(() => setPreview(null), []);
  const visibleCases = useMemo(() => cases.filter(item => showPastCases || (!item.isTest && activeVersions.some(workflow => workflow.id === item.workflowVersionId))).filter(item => `${item.title} ${item.workflowName} ${item.status}`.toLowerCase().includes(caseFilter.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [cases, caseFilter, showPastCases, activeVersions]);
  const messages: AuthoringMessage[] = [...(draft?.messages ?? [])];
  if (authorLive && authorLive.text && !messages.some(item => item.role === 'assistant' && item.runId === authorLive.runId)) messages.push({ id: authorLive.runId, role: 'assistant', text: authorLive.text, createdAt: new Date().toISOString(), attachments: [], runId: authorLive.runId });
  const title = page === 'create' ? draft?.name ?? 'Create workflow' : page === 'cases' ? currentCase?.title ?? 'Cases' : published?.name ?? 'Workflow catalog';
  const canApprove = !!currentCase && !currentCase.isTest && isCurrentCaseRevision && currentCase.status === 'awaiting_review' && currentCaseRevision?.executionStatus === 'completed' && currentCaseRevision.cleanupFinished && currentCaseRevision.reviewStatus === 'pending' && !!currentCaseRevision.resultHash;

  const showDecision = canApprove || (!!caseWorkflow && !currentCase?.isTest && currentCaseRevision?.executionStatus === 'completed' && currentCaseRevision.cleanupFinished && currentCaseRevision.disposition === 'ready');

  return <div className="app-shell wf-shell">
    {mobileMenu && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'sidebar-mobile-open' : ''}`}>
      <a className="brand" href="/" onClick={event => { event.preventDefault(); onNavigate('chat'); }}><span className="brand-mark"><Sparkles size={21} /></span><span>T-force<span className="brand-caption">Your local workspace</span></span></a>
      <WorkflowNavigation page={page} onNavigate={value => { setMobileMenu(false); setError(null); onNavigate(value); }} />
      {page === 'create' ? <>
        <button type="button" className="wf-sidebar-item" onClick={() => selectDraft(null)}><Plus size={15} /><span>New workflow</span></button>
        <div className="wf-sidebar-subtitle">Your drafts</div>
        <div className="wf-sidebar-list">{visibleDrafts.map(item => <button type="button" className={`wf-sidebar-item ${draftId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => selectDraft(item.id)} aria-label={`${item.name || 'New workflow'}${isArchived(item) ? ' (archived)' : ''}`}><Workflow size={15} /><span>{item.name || 'New workflow'}</span>{isArchived(item) ? <Archive size={12} /> : item.status === 'authoring' ? <LoaderCircle size={13} className="spin" /> : null}</button>)}{!visibleDrafts.length && <p className="wf-no-drafts">Start with a few instructions and the documents you use.</p>}</div>
        <button type="button" className="wf-sidebar-item wf-muted-action" onClick={() => setShowArchived(value => !value)}><Archive size={13} />{showArchived ? 'Hide archived drafts' : 'Show archived drafts'}</button>
      </> : page === 'cases' ? <>
        <button type="button" className="wf-sidebar-item" onClick={() => selectCase(null)}><ListChecks size={15} /><span>All runs</span><small>{visibleCases.length}</small></button>
        <div className="wf-sidebar-subtitle">Recent runs</div><div className="wf-sidebar-list">{visibleCases.slice(0, 10).map(item => <button type="button" className={`wf-sidebar-item ${caseId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => selectCase(item.id)}><FileText size={15} /><span>{item.title}</span>{item.status === 'running' && <LoaderCircle size={13} className="spin" />}</button>)}</div>
      </> : <><div className="wf-sidebar-subtitle">Ready to use</div><div className="wf-sidebar-list">{visibleCatalog.map(item => <button type="button" key={item.id} className={`wf-sidebar-item ${catalogId === item.id ? 'selected' : ''}`} onClick={() => { setCatalogId(item.id); setMobileMenu(false); }}><Workflow size={15} /><span>{item.name}</span>{isArchived(item) && <Archive size={12} />}</button>)}</div></>}
      <div className="sidebar-footer wf-sidebar-footer"><div className="local-badge"><HardDrive size={16} /><div><strong>Local files and execution</strong><span>AI uses your Azure deployment</span></div></div><div className="connection-line"><span className={`status-dot ${ready ? 'online' : 'offline'}`} /><span>{!health ? 'Connecting to server' : ready ? 'Ready to work' : !health.docker.ready ? 'Docker unavailable' : 'Azure setup needed'}</span></div></div>
    </aside>
    <main className="wf-main">
      <header className="wf-header"><button type="button" className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileMenu(true)}><Menu size={19} /></button><div><h1>{title}</h1><p>{page === 'create' ? 'Explain the work. Review the draft. Try it.' : page === 'cases' ? 'Run a workflow and review the result' : 'Choose a workflow and add your documents'}</p></div><div className="wf-header-actions">
        {page === 'workflows' && published && <button className="wf-button" type="button" onClick={() => setCatalogId(null)}><ArrowLeft size={13} />All workflows</button>}
        {page === 'workflows' && <button type="button" className="wf-button primary" onClick={() => selectDraft(null)}><Plus size={14} />Create workflow</button>}
        {page === 'create' && <><input ref={importInput} type="file" accept=".json,application/json" hidden aria-label="Import workflow JSON" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importWorkflow(file); }} /><button type="button" className="wf-button" disabled={!!busy || !health} onClick={() => importInput.current?.click()}>{busy === 'import' ? <LoaderCircle size={13} className="spin" /> : <FileCode2 size={13} />}Import workflow</button></>}
        {page === 'create' && draft && <button type="button" className="wf-button" disabled={!!busy || authoring} onClick={() => void archiveItem('draft', draft, !isArchived(draft))}>{isArchived(draft) ? <ArchiveRestore size={13} /> : <Archive size={13} />}{isArchived(draft) ? 'Restore draft' : 'Archive draft'}</button>}
        {page === 'cases' && <button type="button" className="wf-button primary" onClick={() => startCase()} disabled={!activeCatalog.length}><Plus size={14} />Run workflow</button>}
        {page !== 'create' && <button type="button" className="icon-button" aria-label="Refresh workflows and cases" onClick={() => void loadAll(true)}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>}
      </div></header>
      {health && !ready && <div className="setup-banner"><CircleAlert size={16} /><span>{!health.docker.ready ? health.docker.error ?? 'Start Docker to run a workflow.' : 'Configure Azure for AI authoring and AI steps. Imported Python workflows can run locally.'}</span></div>}
      {sharedExecution && !ownsExecution && <div className="busy-banner wf-slot-banner"><LoaderCircle size={14} className="spin" /><span>{sharedExecution.kind === 'chat' ? 'Another conversation is working.' : sharedExecution.kind === 'authoring' ? 'Another workflow is being created.' : 'Another workflow is running.'} You can review documents while it finishes.</span><button type="button" onClick={() => sharedExecution.kind === 'chat' ? onNavigate('chat') : sharedExecution.kind === 'authoring' ? onNavigate('create') : selectCase(sharedExecution.id)}>View progress<ChevronRight size={13} /></button></div>}
      {page === 'create' ? <div className="wf-split">
        <section className="wf-author"><div className="wf-author-scroll" ref={authorScroll}>
          {error && <Notice error={authorIssue(error)} onDismiss={() => setError(null)} />}
          {!messages.length && <div className="wf-intro"><div className="wf-eyebrow">Start with what you already know</div><h2>Explain the work<br />in a few sentences.</h2><p>Tell T-force what to compare, what to flag, what to produce and what needs your approval. Attach the documents it should use.</p>
            <div className="wf-starter"><div className="wf-starter-heading"><FileText size={20} /><div><h3>Invoice check</h3><p>Four instructions. Two sample documents.</p></div></div><ol>{(examples.find(item => item.id === 'invoice-check')?.statements ?? INVOICE_STATEMENTS).map((statement, i) => <li key={i}>{statement}</li>)}</ol><div className="wf-starter-documents">{examples.find(item => item.id === 'invoice-check')?.files.map(file => <a key={file.name} href={file.downloadUrl} download={file.name}><FileText size={13} />{file.name}</a>) ?? <><span><FileText size={13} />invoice.pdf</span><span><FileText size={13} />purchase-order.pdf</span></>}</div><button type="button" className="wf-button primary" onClick={() => void useExample('author')} disabled={!!busy || authorUploading}>{busy === 'sample' ? <LoaderCircle size={13} className="spin" /> : <Plus size={13} />}Try sample</button><small>Fictional documents. Review the instructions before generating.</small></div>
          </div>}
          {messages.map(message => <article className={`wf-author-message ${message.role}`} key={message.id}><div className="wf-author-message-label">{message.role === 'assistant' ? <Sparkles size={13} /> : <MessageSquare size={13} />}{message.role === 'assistant' ? 'T-force' : 'You'}</div><Markdown text={authorLive && message.runId === authorLive.runId && authorLive.text ? authorLive.text : message.text} />{!!message.attachments.length && <div className="wf-author-message-meta"><Paperclip size={11} />{message.attachments.map(file => file.name).join(', ')}</div>}</article>)}
          {authoring && <div className="wf-progress"><LoaderCircle size={14} className="spin" /><span>{authorLive?.connected === false ? 'Reconnecting…' : authorLive?.progress ?? 'Reading your documents and creating the workflow…'}</span></div>}
          {draft?.error && <Notice error={authorIssue(draft.error)} />}{!!draft?.candidateDiagnostics?.length && <details className="wf-advanced"><summary>Details about the draft issue</summary>{draft.candidateDiagnostics.map((item, i) => <p key={i}>{item}</p>)}</details>}
        </div><form className="wf-author-composer" onSubmit={event => void sendAuthor(event)}><Files files={authorFiles} onRemove={path => setAuthorFiles(files => files.filter(item => item.path !== path))} /><div className="composer"><textarea rows={5} aria-label="Describe or refine a workflow" placeholder={draft?.revisions.length ? 'Tell T-force what to change or clarify…' : 'What should this workflow do?'} value={authorText} onChange={event => setAuthorText(event.target.value)} disabled={isArchived(draft)} /><div className="composer-toolbar"><input type="file" multiple hidden ref={authorInput} onChange={event => { if (event.target.files) void upload(event.target.files, 'author'); event.target.value = ''; }} /><button type="button" className="attach-button" onClick={() => authorInput.current?.click()} disabled={authorUploading || isArchived(draft)}><Paperclip size={17} /><span>{authorUploading ? 'Uploading…' : 'Attach documents'}</span></button>{authoring ? <button type="button" className="stop-button" disabled={!!busy} onClick={() => void action('stop-author', async () => { const id = draft?.activeRunId ?? authorLive?.runId; if (id) await post(`/runs/${idPath(id)}/abort`); })}><Square size={12} fill="currentColor" />Stop</button> : <button className="send-button wf-generate-button" type="submit" aria-label={draft?.revisions.length ? 'Refine workflow' : 'Generate workflow'} disabled={!!busy || executionBusy || isArchived(draft) || authorUploading || !ready || (!authorText.trim() && !authorFiles.length)}>{busy === 'author' ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={16} />}<span>{draft?.revisions.length ? 'Update workflow' : 'Generate workflow'}</span></button>}</div></div><p className="wf-composer-note"><ShieldCheck size={11} />{!draft && authorFiles.length === 2 && authorText.trim() ? 'Ready to generate. Review your instructions, then select Generate workflow.' : 'T-force asks when a rule is unclear.'}</p></form></section>
        <section className="wf-review"><div className="wf-review-bar"><Workflow size={15} /><strong>Your workflow</strong>{draft && !!draft.revisions.length && <select aria-label="Draft revision" value={currentRevision?.id ?? ''} onChange={event => setRevisionId(event.target.value)}>{[...draft.revisions].reverse().map(item => <option key={item.id} value={item.id}>Draft {item.number}</option>)}</select>}</div><div className="wf-review-scroll">
          {isArchived(draft) && <div className="wf-change"><strong>This draft is archived.</strong>Restore it to make changes or run it.</div>}
          {currentRevision ? <>
            {draft?.importedFrom && <div className="wf-change"><strong><FileCode2 size={13} />Imported workflow code</strong><p>Imported code still needs a sample test and your review before publication.</p><p>Source: {draft.importedFrom}</p></div>}
            {currentRevision.number > 1 && <div className="wf-change"><strong><GitBranch size={13} />What changed</strong>{packageChanges.filter(change => !/package asset/.test(change)).slice(0, 3).map((change, i) => <p key={i}>{change}</p>)}<details><summary>Advanced change details</summary><p>{currentRevision.changeSummary}</p>{packageChanges.map((change, i) => <p key={i}>{change}</p>)}</details></div>}
            <PackageReview package={currentRevision.package} />
            <section className="wf-section"><h3><FlaskConical size={12} />Try it with your documents</h3>{currentRevision.testReports.map(report => <TestResults key={report.id} report={report} currentHash={currentRevision.packageHash} onInspect={() => selectCase(report.caseId)} />)}<button type="button" className="wf-button" onClick={() => { setTestFiles([]); setTestInputs('{}'); setTestAssertions('[]'); setTestUseOriginal(sampleDocuments.length > 0); setTestOpen(true); }} disabled={!!busy || executionBusy || authoring || isArchived(draft) || !sampleReady}><FlaskConical size={14} />Run sample test</button><p className="wf-publish-note">Run the draft on your attached documents, then review what it finds.</p></section>
            <details className="wf-advanced"><summary>Advanced: revision details</summary><div className="wf-hash">Draft {currentRevision.number} · {currentRevision.packageHash}</div></details>
          </> : <Empty title="A draft you can review"><p>Your instructions become a clear set of steps and checks. You can ask for changes in the conversation.</p></Empty>}
        </div>{currentRevision && <footer className="wf-review-footer"><label className="wf-checkbox"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={authoring || isArchived(draft) || !publishable} /><span>I reviewed the workflow and its sample result.</span></label><button type="button" className="wf-button primary" disabled={!reviewed || !publishable || !!busy} onClick={() => void publishRevision()}>{busy === 'publish' ? <LoaderCircle size={14} className="spin" /> : <BadgeCheck size={15} />}Publish workflow</button><p className="wf-publish-note">{isArchived(draft) ? 'Restore this draft before publishing.' : currentRevision.id !== draft?.revisions.at(-1)?.id ? 'Select the latest draft before publishing.' : currentRevision.package.questions.length ? 'Answer the questions in the conversation before publishing.' : !publishable ? 'Run a sample and review the result before publishing.' : 'Employees will still approve each result before an item is added to the list.'}</p></footer>}</section>
      </div> : <div className="wf-body">
        {error && <Notice error={error} onDismiss={() => setError(null)} />}
        {loading ? <div className="wf-loading"><LoaderCircle size={24} className="spin" />Loading your workflows</div> : page === 'workflows' ? published ? <div className="wf-catalog-detail">
          <div className="wf-package"><PackageReview package={published.package} /><TestResults report={published.testReport} currentHash={published.packageHash} onInspect={() => selectCase(published.testReport.caseId)} /></div>
          <aside className="wf-detail-aside"><div className="wf-card"><h3>{isArchived(published) ? 'Archived workflow' : 'Ready to use'}</h3><p>{isArchived(published) ? 'Restore this workflow to run it again.' : 'Add your documents and review the result before approving any action.'}</p><button className="wf-button primary" type="button" onClick={() => startCase(published.id)} disabled={isArchived(published)}><Workflow size={14} />Run workflow</button><button className="wf-button" type="button" disabled={!!busy || isArchived(published)} onClick={() => void cloneWorkflow(published)}><Copy size={13} />Make a copy</button><button className="wf-button" type="button" disabled={!!busy} onClick={() => void archiveItem('workflow', published, !isArchived(published))}>{isArchived(published) ? <ArchiveRestore size={13} /> : <Archive size={13} />}{isArchived(published) ? 'Restore workflow' : 'Archive workflow'}</button></div>
            <details className="wf-card wf-advanced"><summary>Advanced: versions and original instructions</summary><p>Version {published.version} · Reviewed by {published.reviewedBy} · {time(published.publishedAt)}</p><label className="wf-field"><span>Workflow version</span><select aria-label="Workflow version" value={published.id} onChange={event => setCatalogId(event.target.value)}>{catalog.filter(item => item.workflowId === published.workflowId).sort((a, b) => b.version - a.version).map(item => <option key={item.id} value={item.id}>Version {item.version}{isArchived(item) ? ' · archived' : ''}</option>)}</select></label><div className="wf-hash">{published.packageHash}</div><a className="wf-button" href={`/api/workflows/${idPath(published.id)}/export`} download={`${published.package.slug}-v${published.version}.json`}><ArrowDownToLine size={13} />Export package</a>{published.provenance.map(message => <details className="wf-section" key={message.id}><summary>{message.role === 'user' ? 'Employee instructions' : 'T-force'} · {time(message.createdAt)}</summary><Markdown text={message.text} /></details>)}</details>
          </aside></div> : <>
            <div className="wf-hero"><span className="wf-hero-icon"><Layers size={25} strokeWidth={1.5} /></span><div><div className="wf-eyebrow">Repeat everyday work</div><h2>Your team's workflows.</h2><p>Choose a workflow, add the documents and review the result. T-force asks for approval before adding anything to a business list.</p></div></div>
            <div className="wf-catalog-toolbar"><span>{showArchived ? 'All workflows, including archived versions' : `${activeCatalog.length} ${activeCatalog.length === 1 ? 'workflow' : 'workflows'} ready to use`}</span><button type="button" className="wf-button" onClick={() => setShowArchived(value => !value)}><Archive size={13} />{showArchived ? 'Hide archived workflows' : 'Show archived workflows'}</button></div>
            {visibleCatalog.length ? <div className="wf-grid">{visibleCatalog.map(item => <article className={`wf-card ${isArchived(item) ? 'wf-card-archived' : ''}`} key={item.id}><div className="wf-card-top"><span className="wf-card-icon"><Workflow size={21} strokeWidth={1.5} /></span>{isArchived(item) ? <span className="wf-badge gray">Archived</span> : item.package.synthetic && <span className="wf-badge amber">Sample documents</span>}</div><h3>{item.name}</h3><p>{item.package.purpose}</p><div className="wf-card-actions">{isArchived(item) ? <button type="button" className="wf-button" disabled={!!busy} onClick={() => void archiveItem('workflow', item, false)}><ArchiveRestore size={13} />Restore</button> : <button type="button" className="wf-button primary" onClick={() => startCase(item.id)}>Run<ChevronRight size={12} /></button>}<button type="button" className="wf-button" onClick={() => setCatalogId(item.id)}>Review</button><button type="button" className="icon-button" aria-label={`${isArchived(item) ? 'Restore' : 'Archive'} ${item.name}`} disabled={!!busy} onClick={() => void archiveItem('workflow', item, !isArchived(item))}>{isArchived(item) ? <ArchiveRestore size={15} /> : <Archive size={15} />}</button></div></article>)}</div> : <Empty title="Create a workflow for your team"><p>Start with a few instructions and the documents you already use.</p><button type="button" className="wf-button primary" onClick={() => selectDraft(null)}><Plus size={14} />Create workflow</button></Empty>}
            <p className="wf-synthetic-note">Sample workflows use fictional documents. All business lists are local demonstrations.</p>
            {evaluation && <details className="wf-advanced wf-evaluation-collapsed"><summary>Advanced: recorded evaluation results</summary><EvaluationPanel report={evaluation} /></details>}
          </> : currentCase && currentCaseRevision ? <div className="wf-case-layout">
            <section><div className="wf-case-title"><h2>{currentCase.title}</h2><Badge value={currentCase.status} /></div><div className="wf-case-meta"><span><Workflow size={11} />{currentCase.workflowName}</span><span><Clock3 size={11} />{time(currentCase.createdAt)}</span>{currentCase.isTest && <span><FlaskConical size={11} />Sample run</span>}</div>
              {currentCase.revisions.length > 1 && <div className="wf-history-tabs">{currentCase.revisions.map(item => <button type="button" className={currentCaseRevision.id === item.id ? 'active' : ''} key={item.id} onClick={() => setCaseRevisionId(item.id)}>Revision {item.number}</button>)}</div>}
              {!isCurrentCaseRevision && <div className="wf-history-note">You're viewing an earlier result. Approval uses the latest revision.</div>}
              {activeExecution(currentCaseRevision.executionStatus) && <div className="wf-progress"><LoaderCircle size={14} className="spin" /><span>{connected ? currentCaseRevision.tasks.find(task => task.status === 'running')?.progress ?? 'Reading the documents and checking the details…' : 'Reconnecting to progress…'}</span></div>}
              <div className="wf-panel"><h3><ListChecks size={15} />Review the result</h3><div className="wf-package-meta">{currentCaseRevision.disposition && <Badge value={currentCaseRevision.disposition} />}</div>{currentCaseRevision.findings.length ? <Findings findings={currentCaseRevision.findings} /> : <p>{activeExecution(currentCaseRevision.executionStatus) ? 'The findings will appear here.' : currentCaseRevision.disposition === 'ready' ? 'The documents passed the workflow checks. Review the summary and files before approving.' : 'No business findings were recorded.'}</p>}{currentCaseRevision.error && <Notice error={currentCaseRevision.error} />}<details className="wf-advanced"><summary>Advanced: execution and task results</summary><p>Execution: {currentCaseRevision.executionStatus} · Review: {currentCaseRevision.reviewStatus} · {duration(currentCaseRevision.elapsedMs)} · {currentCaseRevision.usage.totalTokens.toLocaleString()} tokens</p>{currentCaseRevision.tasks.map(task => <div className="wf-task" key={task.stepId}><div className="wf-task-top"><strong>{caseWorkflow?.package.steps.find(item => item.id === task.stepId)?.title ?? task.stepId}</strong><Badge value={task.status} /></div><p>{task.cleanupFinished ? 'Container cleanup completed.' : task.progress ?? 'Cleanup is pending.'}</p>{task.result && <details><summary>Verified structured result</summary><pre className="wf-code">{pretty(task.result)}</pre></details>}{task.error && <Notice error={task.error} />}</div>)}</details></div>
              <div className="wf-panel"><h3><FileText size={15} />Files</h3>{currentCaseRevision.artifacts.map(artifact => <div className="wf-artifact" key={artifact.id}><button type="button" onClick={() => setPreview(artifact)}><FileText size={19} /><span><strong>{artifact.name}</strong><small>{bytes(artifact.size)} · Ready to open</small></span></button><a className="icon-button" href={artifact.downloadUrl} download={artifact.name} aria-label={`Download ${artifact.name}`}><ArrowDownToLine size={15} /></a></div>)}{!currentCaseRevision.artifacts.length && <p>{activeExecution(currentCaseRevision.executionStatus) ? 'Files will appear when the run finishes.' : 'This run did not create files.'}</p>}</div>
              {receipt && <div className="wf-receipt"><strong><Check size={15} />{receipt.duplicate ? 'Already added to the list' : 'Approved and added to the list'}</strong>{friendlyDestination(receipt.destination)} · {receipt.businessKey}<small>{receipt.duplicate ? 'No duplicate entry was created.' : `Approved ${time(receipt.approvedAt)}`}</small><details className="wf-advanced"><summary>Advanced: approval receipt</summary><pre className="wf-code">{pretty(receipt)}</pre></details></div>}
            </section>
            <aside className="wf-case-aside"><div className="wf-panel"><h3><Paperclip size={15} />Documents used</h3>{currentCaseRevision.sources.map(source => <div className="wf-source" key={source.id}><FileText size={13} /><div><strong>{source.name}</strong>{bytes(source.size)}</div></div>)}<details className="wf-advanced"><summary>Advanced: inputs and source fingerprints</summary><pre className="wf-code">{pretty(currentCaseRevision.inputData)}</pre>{currentCaseRevision.sources.map(source => <div className="wf-source" key={source.id}><div><strong>{source.name}</strong><small>{source.hash}</small></div></div>)}</details></div>
              {showDecision && <div className="wf-panel wf-approval"><h3><ShieldCheck size={15} />Employee decision</h3>{caseWorkflow ? <><div className="wf-approval-info"><h4>{reviewStep?.title ?? 'Before you approve'}</h4><p>{reviewStep?.instructions}</p><h4>Your approval</h4><p>{caseWorkflow.package.approval}</p></div><div className="wf-approval-info"><h4>{receipt ? 'Added to the list' : 'What will be added'}</h4><p>{friendlyDestination(queueStep?.destination)}</p>{proposedRecord ? <RecordMapping record={proposedRecord} /> : <p>The result has no entry to add. Submit a correction before approving.</p>}</div></> : <p>Loading the workflow's review instructions…</p>}{canApprove && <><label className="wf-checkbox"><input type="checkbox" checked={approvalChecked} disabled={!reviewDetailsReady} onChange={event => setApprovalChecked(event.target.checked)} /><span>I approve this result and the proposed action.</span></label><div className="wf-approval-actions"><button type="button" className="wf-button primary" disabled={!reviewDetailsReady || !approvalChecked || !!busy} onClick={() => void approveCase()}>{busy === 'approve' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}Approve</button><button type="button" className="wf-button danger" disabled={!!busy} onClick={() => setShowReject(value => !value)}>Reject</button></div>{showReject && <form onSubmit={event => void rejectCase(event)}><label className="wf-field"><span>Why should this be rejected?</span><textarea value={rejectionReason} onChange={event => setRejectionReason(event.target.value)} required aria-label="Rejection reason" /></label><button type="submit" className="wf-button danger" disabled={!!busy || !rejectionReason.trim()}>Confirm rejection</button></form>}</>}<details className="wf-advanced"><summary>Advanced: verified result</summary><p>Execution and cleanup are complete. This decision binds to this exact revision.</p><div className="wf-hash">{currentCaseRevision.resultHash}</div><p>Destination: {queueStep?.destination} · Business key: {String(proposedBusinessKey ?? '')}</p><pre className="wf-code">{pretty(proposedRecord)}</pre></details></div>}
              {currentCase.isTest && <div className="wf-panel"><h3><FlaskConical size={15} />Sample result</h3><p>Review the findings and files. Sample runs do not add business entries.</p><button type="button" className="wf-button" onClick={() => { const owner = drafts.find(item => item.revisions.some(revision => revision.id === currentCase.draftRevisionId)); if (owner) { selectDraft(owner.id); setRevisionId(currentCase.draftRevisionId ?? null); } }}><ArrowLeft size={13} />Back to draft review</button></div>}
              {!currentCase.isTest && isCurrentCaseRevision && !activeExecution(latestCaseRevision?.executionStatus) && <form className="wf-panel" onSubmit={event => void correctCase(event)}><h3><GitBranch size={15} />Provide a correction</h3><p>Add the missing document or upload its corrected version. The previous result stays in this run's history.</p><label className="wf-field"><span>What changed?</span><textarea aria-label="Correction instructions" value={correctionText} onChange={event => setCorrectionText(event.target.value)} placeholder="Tell T-force what changed…" /></label><Upload onFiles={files => void upload(files, 'correction')} uploading={correctionUploading} /><Files files={correctionFiles} onRemove={path => setCorrectionFiles(files => files.filter(item => item.path !== path))} /><details className="wf-advanced"><summary>Advanced: structured inputs</summary><label className="wf-field"><textarea aria-label="Correction structured inputs JSON" value={correctionInputs} onChange={event => setCorrectionInputs(event.target.value)} spellCheck={false} /></label></details><button type="submit" className="wf-button" disabled={!!busy || executionBusy || correctionUploading || !correctionReady || (!correctionText.trim() && !correctionFiles.length && correctionInputs === pretty(latestCaseRevision?.inputData ?? {}))}><GitBranch size={13} />Run correction</button></form>}
              {activeExecution(latestCaseRevision?.executionStatus) && <div className="wf-panel"><h3>Run in progress</h3><button type="button" className="wf-button danger" disabled={!!busy} onClick={() => void action('stop', async () => { await post(`/cases/${idPath(currentCase.id)}/stop`); await loadCase(currentCase.id); })}>{busy === 'stop' ? <LoaderCircle size={13} className="spin" /> : <Square size={12} />}Stop run</button></div>}
            </aside>
          </div> : <><div className="wf-hero"><span className="wf-hero-icon"><ListChecks size={25} strokeWidth={1.5} /></span><div><div className="wf-eyebrow">Run and review</div><h2>Your workflow results.</h2><p>Choose a workflow and add the documents. Review its findings and files before approving anything.</p></div></div><div className="wf-catalog-toolbar"><label className="wf-checkbox"><input type="checkbox" checked={showPastCases} onChange={event => setShowPastCases(event.target.checked)} /><span>Show past runs and tests</span></label></div><label className="file-search" style={{ margin: '0 0 21px' }}><Search size={15} /><input type="search" placeholder="Find a run…" aria-label="Search cases" value={caseFilter} onChange={event => setCaseFilter(event.target.value)} /></label><div className="wf-case-list">{visibleCases.map(item => <button type="button" className="wf-case-row" key={item.id} onClick={() => selectCase(item.id)}><FileText size={20} /><div><strong>{item.title}</strong><small>{item.workflowName} · {time(item.updatedAt)}{item.isTest && ' · sample'}</small></div><Badge value={item.status} /><ChevronRight size={14} /></button>)}{!visibleCases.length && <Empty title={caseFilter ? 'No matching runs' : 'Ready for your first run'} icon={ListChecks}><p>{caseFilter ? 'Try a different name or status.' : 'Choose a published workflow and add its documents.'}</p>{!caseFilter && <button type="button" className="wf-button primary" disabled={!activeCatalog.length} onClick={() => startCase()}><Plus size={14} />Run workflow</button>}</Empty>}</div>{showPastCases && <details className="wf-advanced"><summary>Approved list entries · {queues.length}</summary>{queues.map(item => <div className="wf-info-row" key={item.id}><strong>{friendlyDestination(item.destination)}</strong>{item.businessKey}<RecordMapping record={item.record} /></div>)}</details>}</>}
      </div>}
    </main>
    {testOpen && currentRevision && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy && !testUploading) setTestOpen(false); }}><section className="preview-dialog wf-modal-text" role="dialog" aria-modal="true" aria-labelledby="wf-test-title"><header><span className="preview-file-icon"><FlaskConical size={20} /></span><div><h2 id="wf-test-title">Try {currentRevision.package.name}</h2><p>Run the draft on a sample, then review the result</p></div><button type="button" className="icon-button" aria-label="Close test form" disabled={!!busy || testUploading} onClick={() => setTestOpen(false)}><X size={19} /></button></header><form className="wf-modal-body" onSubmit={event => void testRevision(event)}><div className="wf-test-form">{error && <Notice error={error} onDismiss={() => setError(null)} />}{testUseOriginal && sampleDocuments.length ? <><p className="wf-modal-intro">Use the documents already attached to this workflow.</p><div className="wf-sample-documents">{sampleDocuments.map(file => <div key={file.name}><FileText size={17} /><strong>{file.name}</strong><small>{bytes(file.size)}</small></div>)}</div><button type="button" className="wf-button" onClick={() => { setTestUseOriginal(false); setTestFiles([]); }}>Use different documents</button></> : <><Upload onFiles={files => void upload(files, 'test')} uploading={testUploading} /><Files files={testFiles} onRemove={path => setTestFiles(files => files.filter(item => item.path !== path))} />{!!sampleDocuments.length && <button type="button" className="wf-button" disabled={testUploading} onClick={() => setTestUseOriginal(true)}>Use attached documents</button>}</>}{testDocumentsMissing && <p className="wf-document-prompt">Add the documents this workflow needs.</p>}<p className="wf-publish-note">A sample run confirms the workflow can run. Review its findings and files to check that it does what you intended.</p><details className="wf-advanced"><summary>Advanced: structured inputs and test assertions</summary><label className="wf-field"><span>Structured inputs (JSON, optional)</span><textarea aria-label="Test structured inputs JSON" value={testInputs} onChange={event => setTestInputs(event.target.value)} spellCheck={false} /></label><label className="wf-field"><span>Expected assertions (JSON, optional)</span><textarea aria-label="Test assertions JSON" value={testAssertions} onChange={event => setTestAssertions(event.target.value)} spellCheck={false} /><small>Specify result paths and expected values for additional checks. Failed checks block publication.</small></label></details></div><footer className="wf-modal-actions"><button className="wf-button" type="button" disabled={!!busy || testUploading} onClick={() => setTestOpen(false)}>Cancel</button><button className="wf-button primary" type="submit" disabled={!!busy || executionBusy || testDocumentsMissing || testUploading || !sampleReady}>{busy === 'test' ? <LoaderCircle size={14} className="spin" /> : <FlaskConical size={14} />}Run sample</button></footer></form></section></div>}
    {newCaseOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy && !caseUploading) setNewCaseOpen(false); }}><section className="preview-dialog wf-modal-text" role="dialog" aria-modal="true" aria-labelledby="wf-case-start-title"><header><span className="preview-file-icon"><Workflow size={20} /></span><div><h2 id="wf-case-start-title">Run a workflow</h2><p>Add the documents you want T-force to check</p></div><button type="button" className="icon-button" aria-label="Close new case form" disabled={!!busy || caseUploading} onClick={() => setNewCaseOpen(false)}><X size={19} /></button></header><form className="wf-modal-body" onSubmit={event => void submitCase(event)}><div className="wf-test-form">{error && <Notice error={error} onDismiss={() => setError(null)} />}<label className="wf-field"><span>Workflow</span><select aria-label="Case workflow" value={caseWorkflowId} onChange={event => setCaseWorkflowId(event.target.value)} required>{[...activeCatalog, ...activeVersions.filter(item => item.id === caseWorkflowId && !activeCatalog.some(current => current.id === item.id))].map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><Upload onFiles={files => void upload(files, 'case')} uploading={caseUploading} /><Files files={caseFiles} onRemove={path => setCaseFiles(files => files.filter(item => item.path !== path))} />{/invoice/i.test(`${catalog.find(item => item.id === caseWorkflowId)?.name ?? ''} ${catalog.find(item => item.id === caseWorkflowId)?.package.purpose ?? ''}`) && <button type="button" className="wf-button" disabled={!!busy || caseUploading} onClick={() => void useExample('case')}><FileText size={13} />Use sample documents</button>}{caseDocumentsMissing && <p className="wf-document-prompt">Add the documents this workflow needs.</p>}<label className="wf-field"><span>Name this run (optional)</span><input aria-label="Case title" value={caseTitle} onChange={event => setCaseTitle(event.target.value)} placeholder="For example, invoice INV-1007" /></label><details className="wf-advanced"><summary>Advanced: structured inputs</summary><label className="wf-field"><span>Structured inputs (JSON, optional)</span><textarea aria-label="Case structured inputs JSON" value={caseInputs} onChange={event => setCaseInputs(event.target.value)} spellCheck={false} /></label></details><p className="wf-publish-note"><ShieldCheck size={12} /> You'll review the result before approving any item for the list.</p></div><footer className="wf-modal-actions"><button className="wf-button" type="button" disabled={!!busy || caseUploading} onClick={() => setNewCaseOpen(false)}>Cancel</button><button className="wf-button primary" type="submit" disabled={!!busy || executionBusy || caseDocumentsMissing || caseUploading || !caseWorkflowId || !caseReady}>{busy === 'case' ? <LoaderCircle size={14} className="spin" /> : <Workflow size={14} />}Run workflow</button></footer></form></section></div>}
    {preview && <ArtifactPreview key={preview.id} artifact={preview} onClose={closePreview} />}
  </div>;
}
