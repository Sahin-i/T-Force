/** Activate locally reviewed source through normal API gates; no model request or business approval. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHash } from '../server/workflow-validation.js';
import { atomicReport } from './workflow-report.js';
import type { Attachment } from '../shared/types.js';
import type { PublishedWorkflow, WorkflowDraft, WorkflowCase, WorkflowPackage, QueueRecord } from '../shared/workflow-types.js';

const base = process.env.REVIEWED_APP_URL ?? 'http://127.0.0.1:3001';
const packageFile = 'catalog/simple-invoice/reviewed-package.json';
const { package: pkg } = JSON.parse(await readFile(packageFile, 'utf8')) as { package: WorkflowPackage };
const hash = canonicalHash(pkg);
const assessment = JSON.parse(await readFile('deliverables/evidence/invoice-integrity/report.json', 'utf8'));
assert.equal(assessment.status, 'completed');
assert.equal(assessment.after.packageHash, hash);
assert.equal(assessment.after.passed, assessment.after.tested);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'running', packageHash: hash, synthetic: true, method: 'Imported disclosed team-reviewed source through the running localhost API. Real Docker matching/mismatch/missing-document tests, verified exact published hash, explicit automated demonstration review, then reversible archive of the unsafe historical version. No Azure authoring or business approval. Existing queue records preserved.' };
const save = () => atomicReport('deliverables/evidence/local-reviewed-publication.json', report);
async function api<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/${endpoint}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${endpoint}: ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function upload(filename: string): Promise<Attachment> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(await readFile(filename))], { type: 'application/pdf' }), path.basename(filename));
  const response = await fetch(`${base}/api/files/upload`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Upload failed: ${await response.text()}`);
  return ((await response.json()) as { files: Attachment[] }).files[0]!;
}
try {
  const health = await api<{ activeRun: unknown; activeExecution: unknown }>('health');
  assert.equal(health.activeRun, null); assert.equal(health.activeExecution, null);
  const queueBefore = await api<QueueRecord[]>('queues');
  report.queueBefore = queueBefore;
  const activeBefore = await api<PublishedWorkflow[]>('workflows');
  report.activeBefore = activeBefore.map(w => ({ id: w.id, packageHash: w.packageHash, name: w.name }));
  const existing = activeBefore.find(w => w.packageHash === hash);
  if (existing) { report.versionId = existing.id; report.status = 'already_active'; await save(); }
  else {
    const draft = await api<WorkflowDraft>('workflow-drafts/import', { package: pkg, sourceLabel: 'Team-reviewed repair of the AI-generated invoice starter; actual PDF integrity controls verified. Automated local demonstration review, no new model generation.' });
    report.draftId = draft.id; await save();
    const invoice = await upload('catalog/simple-invoice/invoice.pdf');
    const order = await upload('catalog/simple-invoice/purchase-order.pdf');
    const mismatch = await upload('catalog/simple-invoice/mismatch/invoice.pdf');
    const tests: Record<string, unknown>[] = [];
    for (const scenario of [{ id: 'match', files: [invoice, order], disposition: 'ready' }, { id: 'mismatch', files: [mismatch, order], disposition: 'blocked' }, { id: 'missing-order', files: [invoice], disposition: 'clarification' }]) {
      const response = await api<{ caseId: string }>(`workflow-drafts/${draft.id}/test`, { revisionId: draft.revisions.at(-1)!.id, inputData: {}, attachments: scenario.files, assertions: [{ path: 'compare.disposition', operator: 'eq', value: scenario.disposition }] });
      let item: WorkflowCase;
      const started = Date.now();
      do { item = await api<WorkflowCase>(`cases/${response.caseId}`); if (item.status !== 'running') break; if (Date.now() - started > 120000) throw new Error('Local test timed out'); await new Promise(resolve => setTimeout(resolve, 100)); } while (true);
      const r = item.revisions.at(-1)!;
      assert.equal(r.executionStatus, 'completed'); assert.equal(r.cleanupFinished, true); assert.equal(r.disposition, scenario.disposition);
      const artifact = r.artifacts.find(a => a.path === 'invoice-review.md')!; assert.ok(artifact);
      const content = await fetch(`${base}${artifact.contentUrl}`); assert.equal(content.status, 200);
      const summary = await content.text();
      if (scenario.id === 'match') { assert.match(summary, /INV-2026-1042/); assert.match(summary, /PO-2026-0188/); assert.match(summary, /Caspian Office Supplies/); assert.match(summary, /AZN 560(?:\.00)?/); }
      tests.push({ id: scenario.id, caseId: item.id, disposition: r.disposition, cleanupFinished: r.cleanupFinished, usage: r.usage, artifacts: r.artifacts.map(a => ({ path: a.path, hash: a.hash })) });
      report.tests = tests; await save();
    }
    const published = await api<PublishedWorkflow>(`workflow-drafts/${draft.id}/publish`, { revisionId: draft.revisions.at(-1)!.id, reviewed: true, reviewedBy: 'Automated hackathon code reviewer: synthetic local demonstration, all exact-source regression controls inspected.' });
    assert.equal(published.packageHash, hash);
    report.versionId = published.id; report.published = { id: published.id, packageHash: published.packageHash, reviewedBy: published.reviewedBy, importedFrom: draft.importedFrom };
    const archived = [];
    for (const old of activeBefore.filter(w => w.packageHash === assessment.before.packageHash)) {
      await api(`workflows/${old.id}/archive`, { archived: true });
      await api(`workflow-drafts/${old.draftId}/archive`, { archived: true });
      archived.push({ versionId: old.id, draftId: old.draftId, packageHash: old.packageHash });
    }
    report.archived = archived;
    assert.deepEqual(await api('queues'), queueBefore);
    report.queueRecordsPreserved = queueBefore.length;
    report.status = 'completed'; report.finishedAt = new Date().toISOString(); await save();
    console.log(`Reviewed local workflow published: ${published.id}; ${archived.length} unsafe historical version(s) archived; ${queueBefore.length} queue records unchanged.`);
  }
} catch (error) { report.status = 'failed'; report.error = (error as Error).message; await save(); throw error; }
