/** Real PDF/Docker regression of the retained live draft, optionally repaired by live Azure.
 * Isolated state only. Never modifies the demonstration's published package or queues.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { ConversationStore } from '../server/store.js';
import { AgentHarness } from '../server/agent.js';
import { SandboxManager } from '../server/sandbox.js';
import { canonicalHash, validatePackage } from '../server/workflow-validation.js';
import { uploadEvaluationFile, pollEvaluation } from './evaluate-workflows.js';
import { atomicReport } from './workflow-report.js';
import type { WorkflowDraft, WorkflowPackage } from '../shared/workflow-types.js';
import type { Attachment } from '../shared/types.js';

const repair = process.argv.includes('--repair');
const candidateFile = process.argv.find(arg => arg.startsWith('--candidate='))?.slice('--candidate='.length);
const out = path.resolve('deliverables/evidence/invoice-integrity');
await mkdir(out, { recursive: true });
const localSource = '.agent-state/validation/simple-invoice/generated-draft.json';
const source = process.argv.find(arg => arg.startsWith('--package='))?.slice('--package='.length) ?? (existsSync(localSource) ? localSource : 'deliverables/evidence/simple-invoice/generated-draft.json');
const original = JSON.parse(await readFile(source, 'utf8')) as WorkflowDraft | { package: WorkflowPackage };
const pkg = validatePackage('revisions' in original ? original.revisions.at(-1)!.package : original.package);
const temp = await mkdtemp(path.join(os.tmpdir(), 'office-integrity-'));
const bundledPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
await promisify(execFile)(process.env.WORKFLOW_TEST_PYTHON ?? (existsSync(bundledPython) ? bundledPython : 'python3'), ['scripts/invoice-integrity-fixtures.py', path.join(temp, 'controls')]);
const fixtures = JSON.parse(await readFile(path.join(temp, 'controls/index.json'), 'utf8')) as { seed: number; controls: { id: string; expectedReady: boolean; expectedOrder?: string; expectedRecord?: { supplier: string; invoice_number: string; currency: string; amount: string }; files: string[] }[] };
const cfg = { ...config, workspaceDir: path.join(temp, 'workspace'), stateDir: path.join(temp, 'state') };
const store = new ConversationStore(cfg.stateDir);
const sandboxes = new SandboxManager({ workspaceDir: cfg.workspaceDir, image: cfg.sandboxImage, commandTimeoutMs: cfg.commandTimeoutMs, maxOutputBytes: cfg.maxToolOutputBytes });
const harness = new AgentHarness(cfg, store, sandboxes);
const { app, workflows, workflowStore } = await createApp(cfg, { store, harness, sandboxes, skipRecovery: true });
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'running', synthetic: true, method: 'Actual PDF controls through the generic workflow test API and real isolated Docker tasks. Imported historical live-generated draft, then optional live Azure conversational repair of that same source. No production state, publication or queue mutations. Controls are regression tests, not an unseen accuracy benchmark.', sourcePackageHash: canonicalHash(pkg), seed: fixtures.seed, isolatedState: temp };
const save = () => atomicReport(path.join(out, 'report.json'), report);
const uploaded = new Map<string, Attachment[]>();
async function uploads(control: (typeof fixtures.controls)[number]) {
  if (!uploaded.has(control.id)) {
    const list: Attachment[] = [];
    for (const file of control.files) list.push(await uploadEvaluationFile(app, file));
    uploaded.set(control.id, list);
  }
  return uploaded.get(control.id)!;
}
async function assess(draft: WorkflowDraft) {
  const results = [];
  for (const control of fixtures.controls) {
    const tested = await workflows.test(draft.id, draft.revisions.at(-1)!.id, {}, await uploads(control), []);
    const item = await pollEvaluation(() => workflowStore.getCase(tested.caseId), c => c.status !== 'running');
    const r = item.revisions.at(-1)!;
    const isReady = r.disposition === 'ready';
    const result = r.tasks.find(task => task.result)?.result;
    const record = result?.queueRecord as Record<string, unknown> | undefined;
    const expected = control.expectedRecord;
    const factsCorrect = !expected || Boolean(record && record.supplier === expected.supplier && record.invoice_number === expected.invoice_number && record.currency === expected.currency && Number(record.amount) === Number(expected.amount));
    let summaryCorrect = r.artifacts.length > 0;
    for (const artifact of r.artifacts) {
      const response = await app.inject({ method: 'GET', url: artifact.contentUrl });
      summaryCorrect = summaryCorrect && response.statusCode === 200;
      if (expected) {
        const amounts = [...response.body.matchAll(/\b([A-Z]{3})\s+([0-9][0-9,]*(?:\.[0-9]+)?)/g)];
        summaryCorrect = summaryCorrect && amounts.some(match => match[1] === expected.currency && Number(match[2].replaceAll(',', '')) === Number(expected.amount)) && response.body.includes(expected.supplier) && response.body.includes(expected.invoice_number) && response.body.includes(control.expectedOrder!);
      }
    }
    results.push({ id: control.id, expectedReady: control.expectedReady, actualDisposition: r.disposition, passed: r.executionStatus === 'completed' && r.cleanupFinished && summaryCorrect && factsCorrect && isReady === control.expectedReady, factsCorrect, summaryCorrect, executionStatus: r.executionStatus, cleanupFinished: r.cleanupFinished, findings: r.findings, error: r.error, elapsedMs: r.elapsedMs, caseId: item.id, artifacts: r.artifacts.map(a => ({ path: a.path, hash: a.hash, size: a.size })) });
  }
  return { packageHash: draft.revisions.at(-1)!.packageHash, tested: results.length, passed: results.filter(r => r.passed).length, falseReady: results.filter(r => !r.expectedReady && r.actualDisposition === 'ready').length, results };
}
try {
  const draft = await workflows.createDraft('Invoice check integrity review');
  draft.revisions.push({ id: randomUUID(), number: 1, createdAt: new Date().toISOString(), package: pkg, packageHash: canonicalHash(pkg), changeSummary: 'Imported the retained live-generated package for isolated adversarial regression. Historical package unchanged.', testReports: [] });
  workflowStore.saveDraft(draft);
  report.before = await assess(draft); await save();
  console.log(`Historical package: ${JSON.stringify({ tested: (report.before as { tested: number }).tested, passed: (report.before as { passed: number }).passed, falseReady: (report.before as { falseReady: number }).falseReady })}`);
  if (repair) {
    const samples: Attachment[] = [];
    for (const filename of ['catalog/simple-invoice/invoice.pdf', 'catalog/simple-invoice/purchase-order.pdf']) samples.push(await uploadEvaluationFile(app, path.resolve(filename)));
    await workflows.author(draft.id, 'Review and repair this generated invoice workflow. Code review found silent duplicate-SKU overwrites, currency inconsistency within a document, unchecked quantity-times-price arithmetic and row sums, and missing invoice/order identifiers that can be misread as following headings. Preserve the four employee instructions and the sample documents. Read the actual run documents, account for every line, validate finite positive quantities and amounts, document and line currencies, identifiers, each line calculation and totals. Never treat missing, ambiguous or inconsistent facts as ready. Keep a readable summary for every result and the existing backend employee approval boundary. Preserve ordinary matching documents and changed quantities/prices. Do not hardcode sample facts, publish or approve anything. Syntax-check and dry-run your repair before writing the candidate.', samples);
    const revised = await pollEvaluation(() => workflowStore.getDraft(draft.id), d => d.status !== 'authoring', cfg.maxRunMs + 10000);
    if (revised.status === 'failed' || revised.revisions.length < 2) throw new Error(`Repair failed: ${revised.error?.message ?? 'No new revision'}`);
    report.model = cfg.model;
    report.authorRun = store.getRun(revised.activeRunId ?? [...revised.messages].reverse().find(m => m.runId)?.runId ?? '');
    report.after = await assess(revised);
    await writeFile(path.join(out, 'reviewed-package.json'), JSON.stringify({ package: revised.revisions.at(-1)!.package, packageHash: revised.revisions.at(-1)!.packageHash, provenance: 'Live Azure conversational repair of previously live-generated source following independent reviewer findings. This is a repaired draft, not a published production workflow.' }, null, 2));
    const after = report.after as { tested: number; passed: number; falseReady: number };
    console.log(`Repaired package: ${JSON.stringify({ tested: after.tested, passed: after.passed, falseReady: after.falseReady })}`);
    if (after.passed !== after.tested) throw new Error('Repaired package still fails integrity controls. Inspect the retained report; do not claim success.');
  } else if (candidateFile) {
    const candidate = JSON.parse(await readFile(candidateFile, 'utf8')) as { package: WorkflowPackage };
    const reviewed = validatePackage(candidate.package);
    const newDraft = await workflows.createDraft('Code-reviewed invoice check');
    newDraft.revisions.push({ id: randomUUID(), number: 1, createdAt: new Date().toISOString(), package: reviewed, packageHash: canonicalHash(reviewed), changeSummary: 'Team code review repair of the historical AI-generated source. No new model call.', testReports: [] });
    workflowStore.saveDraft(newDraft);
    report.after = await assess(newDraft);
    report.repairMethod = 'Local code review repair. Historical source untouched. No additional model call, publication or queue mutation.';
    await writeFile(path.join(out, 'reviewed-package.json'), JSON.stringify({ package: reviewed, packageHash: canonicalHash(reviewed), provenance: report.repairMethod }, null, 2));
    const after = report.after as { tested: number; passed: number; falseReady: number };
    console.log(`Code-reviewed package: ${JSON.stringify({ tested: after.tested, passed: after.passed, falseReady: after.falseReady })}`);
    if (after.passed !== after.tested) throw new Error('Code-reviewed package still fails integrity controls. Inspect the retained report; do not claim success.');
  }
  report.status = 'completed'; report.finishedAt = new Date().toISOString(); await save();
} catch (error) {
  report.status = 'failed'; report.error = (error as Error).message; await save(); throw error;
} finally {
  await app.close();
}
