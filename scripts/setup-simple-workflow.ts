/** Live example: all writes use the UI; assertions below are never supplied to the author. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import type { PublishedWorkflow, QueueRecord, WorkflowArtifact, WorkflowCase, WorkflowDraft } from '../shared/workflow-types.js';
import { atomicReport } from './workflow-report.js';
import { readXlsxCells } from './workflow-grading.js';

const baseURL = process.env.SIMPLE_WORKFLOW_APP_URL ?? 'http://127.0.0.1:3001';
const resumeDraft = process.argv.find(argument => argument.startsWith('--draft='))?.slice('--draft='.length);
const finishAttempt = process.argv.find(argument => argument.startsWith('--finish='))?.slice('--finish='.length);
const authorOnly = process.argv.includes('--author-only');
const output = path.resolve('.agent-state/validation/simple-invoice');
await mkdir(output, { recursive: true });
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const cached = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find(existsSync) : undefined;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? cached });
const page = await browser.newPage({ baseURL, viewport: { width: 1500, height: 1080 } });
page.setDefaultTimeout(20_000);
const execute = promisify(execFile);
const startedAt = new Date().toISOString();
const started = Date.now();
const attemptId = randomUUID();
const attemptOutput = path.join(output, 'attempts', attemptId);
await mkdir(attemptOutput, { recursive: true });
const report: Record<string, unknown> = { attemptId, startedAt, status: 'running', method: 'Actual UI, live configured Azure model, four English statements and exactly two PDF authoring attachments; no executable template, policy, schema or answer key uploaded.', steps: [] };
const steps = report.steps as Record<string, unknown>[];
let earlierExecutionMs = 0;
async function save() { report.attemptElapsedMs = Date.now() - started; report.elapsedMs = earlierExecutionMs + Date.now() - started; await atomicReport(path.join(attemptOutput, 'report.json'), report); await atomicReport(path.join(output, 'live-report.json'), report); }
async function get<T>(url: string): Promise<T> { const response = await page.request.get(url); if (!response.ok()) throw new Error(`${url}: ${await response.text()}`); return response.json(); }
async function readDraft(id: string) { return get<WorkflowDraft>(`/api/workflow-drafts/${id}`); }
async function waitDraft(id: string) {
  for (let i = 0; i < 900; i++) {
    const draft = await readDraft(id);
    if (draft.status === 'failed') throw new Error(`Authoring failed: ${draft.error?.code}: ${draft.error?.message}`);
    if (draft.status !== 'authoring' && draft.revisions.length) return draft;
    if (i % 30 === 0) console.log(`Live invoice authoring: ${draft.status}, ${i}s.`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Authoring exceeded 15 minutes; the saved draft remains available.');
}
async function waitCase(id: string) {
  for (let i = 0; i < 300; i++) {
    const item = await get<WorkflowCase>(`/api/cases/${id}`);
    if (item.status !== 'running') {
      const revision = item.revisions.at(-1)!;
      assert.equal(revision.executionStatus, 'completed', `${item.status}: ${revision.error?.message ?? 'execution did not complete'}`);
      assert.equal(revision.cleanupFinished, true);
      return item;
    }
    if (i % 30 === 0) console.log(`Invoice case ${id}: running, ${i}s.`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Case ${id} exceeded five minutes; it remains saved for inspection.`);
}
async function screenshot(name: string) { await page.screenshot({ path: path.join(attemptOutput, `${name}.png`), fullPage: true }); }
async function artifactText(artifact: WorkflowArtifact) {
  const response = await page.request.get(artifact.contentUrl);
  assert.equal(response.ok(), true, `Cannot read protected artifact ${artifact.name}`);
  const bytes = await response.body();
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.hash);
  const target = path.join(output, 'artifacts', `${artifact.id}-${path.basename(artifact.name)}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  if (artifact.mime === 'application/pdf' || /\.pdf$/i.test(artifact.path)) {
    const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
    const python = process.env.WORKFLOW_TEST_PYTHON ?? (existsSync(bundled) ? bundled : 'python3');
    const { stdout } = await execute(python, ['-c', 'from pypdf import PdfReader\nimport sys\nprint("\\n".join(p.extract_text() or "" for p in PdfReader(sys.argv[1]).pages))', target]);
    return stdout;
  }
  if (artifact.mime.includes('wordprocessingml') || /\.docx$/i.test(artifact.path)) return Buffer.from(unzipSync(bytes)['word/document.xml']).toString('utf8').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
  if (artifact.mime.includes('spreadsheetml') || /\.xlsx$/i.test(artifact.path)) {
    const sheet = readXlsxCells(bytes);
    return sheet.getRows(1, sheet.rowCount).map(row => Array.from({ length: 64 }, (_, column) => row.getCell(column + 1).value).filter(value => value !== undefined).join(' ')).join('\n');
  }
  return bytes.toString('utf8').replace(/<[^>]+>/g, ' ');
}
async function inspectSummary(item: WorkflowCase, amount?: 560 | 700) {
  const revision = item.revisions.at(-1)!;
  assert.ok(revision.artifacts.length, 'The employee requested a review summary, but no protected artifact was generated.');
  const texts = await Promise.all(revision.artifacts.map(artifactText));
  const summary = texts.join('\n');
  if (amount !== undefined) {
    assert.match(summary, /AZN/);
    assert.match(summary, new RegExp(`\\b${amount}(?:[.,]00)?\\b`));
  } else {
    assert.match(summary, /purchase.?order|\bPO\b/i);
    assert.match(summary, /missing|clarification|clarify|unavailable/i);
  }
  if (amount === 700) assert.match(summary, /quantity|quantities|total|difference|mismatch|issue/i);
  steps.push({ action: amount === undefined ? 'missing evidence summary inspected independently' : amount === 560 ? 'matching summary inspected independently' : 'mismatch summary inspected independently', caseId: item.id, status: item.status, disposition: revision.disposition, sources: revision.sources, artifacts: revision.artifacts.map(artifact => ({ name: artifact.name, hash: artifact.hash, size: artifact.size })), elapsedMs: revision.elapsedMs, usage: revision.usage });
  await save();
}
function recordLeaves(value: unknown, key = ''): { key: string; value: unknown }[] {
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([childKey, child]) => recordLeaves(child, key ? `${key}.${childKey}` : childKey));
  return [{ key, value }];
}
async function testDraft(draftId: string, scenario: 'matching' | 'mismatch' | 'missing' | 'precision' = 'matching') {
  await page.getByRole('button', { name: 'Run sample test', exact: true }).click();
  if (scenario !== 'matching') {
    let invoice = path.resolve('catalog/simple-invoice', scenario === 'mismatch' ? 'mismatch/invoice.pdf' : 'invoice.pdf');
    if (scenario === 'precision') {
      invoice = path.join(output, 'controls/invoice.pdf');
    if (!existsSync(invoice)) {
      const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
      await execute(process.env.WORKFLOW_TEST_PYTHON ?? (existsSync(bundled) ? bundled : 'python3'), ['catalog/simple-invoice/generate.py', '--precision-control', invoice]);
    }
    }
    await page.getByRole('dialog').getByRole('button', { name: 'Use different documents', exact: true }).click();
    const files = scenario === 'missing' ? [invoice] : [invoice, path.resolve('catalog/simple-invoice/purchase-order.pdf')];
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles(files);
    await expect(page.getByRole('dialog').locator('.wf-file-chip')).toHaveCount(files.length);
  }
  const response = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith(`/workflow-drafts/${draftId}/test`));
  await page.getByRole('button', { name: 'Run sample', exact: true }).click();
  const result = await response;
  assert.equal(result.ok(), true, await result.text());
  const body = await result.json() as { caseId: string };
  const item = await waitCase(body.caseId);
  assert.equal(item.isTest, true);
  if (scenario === 'precision') {
    const current = item.revisions.at(-1)!;
    assert.ok(current.disposition === 'blocked' || current.disposition === 'clarification', `The changed unit price 70.001 was silently approved: ${current.disposition}`);
    assert.ok(current.findings.length, 'The precision control has no discrepancy or clarification finding.');
    steps.push({ action: 'private price precision control', caseId: item.id, disposition: current.disposition, findings: current.findings, sources: current.sources, elapsedMs: current.elapsedMs, usage: current.usage });
    await save();
  } else {
    assert.equal(item.revisions.at(-1)!.disposition, scenario === 'mismatch' ? 'blocked' : scenario === 'missing' ? 'clarification' : 'ready');
    await inspectSummary(item, scenario === 'missing' ? undefined : scenario === 'mismatch' ? 700 : 560);
  }
  await screenshot(`${scenario}-test`);
  await page.getByRole('button', { name: 'Back to draft review', exact: true }).click();
  return item;
}
async function startBusinessCase(version: PublishedWorkflow, scenario: 'matching' | 'mismatch' | 'missing' | 'duplicate' = 'matching') {
  await page.getByRole('button', { name: /^(Run workflow|Run)$/ }).first().click();
  await page.getByRole('combobox', { name: 'Case workflow', exact: true }).selectOption(version.id);
  await page.getByRole('textbox', { name: 'Case title', exact: true }).fill(`Invoice INV-2026-1042: ${scenario === 'matching' ? 'payment review' : scenario === 'mismatch' ? 'quantity discrepancy' : scenario === 'missing' ? 'purchase order missing' : 'duplicate submission'}`);
  if (scenario === 'mismatch') {
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles([path.resolve('catalog/simple-invoice/mismatch/invoice.pdf'), path.resolve('catalog/simple-invoice/purchase-order.pdf')]);
  } else if (scenario === 'missing') {
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles([path.resolve('catalog/simple-invoice/invoice.pdf')]);
  } else await page.getByRole('dialog').getByRole('button', { name: 'Use sample documents', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.wf-file-chip')).toHaveCount(scenario === 'missing' ? 1 : 2);
  const response = page.waitForResponse(item => item.request().method() === 'POST' && new URL(item.url()).pathname === '/api/cases');
  await page.getByRole('dialog').getByRole('button', { name: 'Run workflow', exact: true }).click();
  const result = await response;
  assert.equal(result.ok(), true, await result.text());
  const item = await waitCase((await result.json() as WorkflowCase).id);
  assert.equal(item.workflowVersionId, version.id);
  assert.equal(item.revisions.at(-1)!.disposition, scenario === 'mismatch' ? 'blocked' : scenario === 'missing' ? 'clarification' : 'ready');
  assert.equal(item.status, scenario === 'mismatch' ? 'blocked' : scenario === 'missing' ? 'clarification' : 'awaiting_review');
  if (scenario === 'missing') assert.match(JSON.stringify(item.revisions.at(-1)!.findings), /purchase.?order|\bPO\b/i);
  await inspectSummary(item, scenario === 'missing' ? undefined : scenario === 'mismatch' ? 700 : 560);
  return item;
}
async function finishPublishedControls(version: PublishedWorkflow, queueAfterApproval: QueueRecord[]) {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Workflows', exact: true }).click();
  const mismatching = await startBusinessCase(version, 'mismatch');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  assert.ok(mismatching.revisions.at(-1)!.findings.length, 'The mismatched invoice has no business findings.');
  assert.deepEqual(await get('/api/queues'), queueAfterApproval, 'A mismatched invoice entered the payment list.');
  report.blockedCaseId = mismatching.id;
  await screenshot('mismatch-blocked');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Workflows', exact: true }).click();
  const missing = await startBusinessCase(version, 'missing');
  assert.deepEqual(await get('/api/queues'), queueAfterApproval, 'Missing evidence entered the payment list.');
  report.clarificationCaseId = missing.id;
  await screenshot('missing-purchase-order');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Workflows', exact: true }).click();
  const duplicate = await startBusinessCase(version, 'duplicate');
  await page.getByRole('checkbox', { name: 'I approve this result and the proposed action.', exact: true }).check();
  const duplicateApproving = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith(`/cases/${duplicate.id}/approve`));
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  assert.equal((await duplicateApproving).ok(), true);
  await expect(page.getByText('Already added to the list', { exact: true })).toBeVisible();
  assert.deepEqual(await get('/api/queues'), queueAfterApproval, 'Duplicate approval added another payment-list entry.');
  report.duplicateCaseId = duplicate.id;
  await screenshot('duplicate-prevented');
  report.status = 'completed'; report.finishedAt = new Date().toISOString(); await save();
  console.log(`Simple invoice workflow published as ${version.id}. Matching AZN 560 approved once; AZN 700 mismatch blocked; missing purchase order clarified; duplicate prevented. Report: ${path.join(output, 'live-report.json')}`);
}

try {
  await page.goto('/');
  report.health = await get('/api/health');
  if (finishAttempt) {
    assert.match(finishAttempt, /^[a-zA-Z0-9-]+$/);
    const prior = JSON.parse(await readFile(path.join(output, 'attempts', finishAttempt, 'report.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(typeof prior.versionId, 'string'); assert.equal(typeof prior.approvedCaseId, 'string');
    const { steps: previousSteps, ...previousMetadata } = prior;
    Object.assign(report, previousMetadata, { attemptId, startedAt, status: 'running', resumedFrom: finishAttempt, priorFailure: prior.error, error: undefined });
    steps.push(...previousSteps as Record<string, unknown>[]);
    earlierExecutionMs = Number(prior.elapsedMs);
    const version = (await get<PublishedWorkflow[]>('/api/workflows')).find(item => item.id === prior.versionId)!;
    assert.ok(version); assert.equal(version.packageHash, prior.packageHash);
    const approved = await get<WorkflowCase>(`/api/cases/${prior.approvedCaseId}`);
    assert.equal(approved.status, 'completed'); assert.equal(approved.approvals.length, 1);
    const queueAfterApproval = await get<QueueRecord[]>('/api/queues');
    const paymentRecord = prior.paymentRecord as QueueRecord;
    assert.deepEqual(queueAfterApproval.find(item => item.id === paymentRecord.id), paymentRecord);
    await save();
    await finishPublishedControls(version, queueAfterApproval);
  } else {
  const queueBefore = await get<QueueRecord[]>('/api/queues');
  report.queueBefore = queueBefore;
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Create workflow', exact: true }).click();
  const procedure = (await readFile('catalog/simple-invoice/procedure.txt', 'utf8')).trim();
  let draftId = resumeDraft;
  if (!draftId) {
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    const sampleResponse = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith('/workflow-examples/invoice-check/files'));
    await page.getByRole('button', { name: 'Try sample', exact: true }).click();
    assert.equal((await sampleResponse).ok(), true);
    await expect(page.locator('.wf-author-composer .wf-file-chip')).toHaveCount(2);
    await expect(page.getByRole('textbox', { name: 'Describe or refine a workflow' })).toHaveValue(procedure);
    await screenshot('starter');
    const generating = page.waitForResponse(item => item.request().method() === 'POST' && /\/workflow-drafts\/[^/]+\/messages$/.test(item.url()));
    await page.getByRole('button', { name: 'Generate workflow', exact: true }).click();
    const generated = await generating;
    assert.equal(generated.ok(), true, await generated.text());
    draftId = new URL(generated.url()).pathname.split('/')[3];
  } else {
    const existing = await readDraft(draftId);
    await page.locator('.wf-sidebar-list').getByRole('button').filter({ hasText: existing.name }).first().click();
  }
  report.draftId = draftId; await save();
  const draft = await waitDraft(draftId);
  const revision = draft.revisions.at(-1)!;
  assert.equal(revision.package.questions.length, 0, 'The generated draft still has unanswered questions.');
  const instruction = draft.messages.find(message => message.role === 'user')!;
  assert.equal(instruction.text.trim(), procedure);
  assert.deepEqual(instruction.attachments.map(file => file.name).sort(), ['invoice.pdf', 'purchase-order.pdf']);
  assert.ok(revision.package.steps.some(step => step.type === 'review'));
  const paymentStep = revision.package.steps.find(step => step.type === 'queue');
  assert.ok(paymentStep);
  report.packageHash = revision.packageHash;
  report.sourceAudit = Object.entries(revision.package.assets).filter(([name]) => /\.(py|sh|js|ts)$/i.test(name)).map(([name, source]) => ({ name, sha256: createHash('sha256').update(source).digest('hex'), sampleConstants: source.split('\n').flatMap((line, index) => /INV-2026-1042|PO-2026-0188|\b(?:8|70(?:\.0+)?|560(?:\.0+)?)\b/.test(line) ? [{ line: index + 1, text: line }] : []) }));
  report.authoring = draft.messages;
  report.authorRuns = await Promise.all(draft.messages.filter(message => message.role === 'assistant' && message.runId).map(message => get(`/api/runs/${message.runId}`)));
  await writeFile(path.join(output, 'generated-draft.json'), JSON.stringify(draft, null, 2));
  await writeFile(path.join(attemptOutput, 'generated-draft.json'), JSON.stringify(draft, null, 2));
  await expect(page.locator('.wf-package-title')).toHaveText(revision.package.name);
  await screenshot('generated-review'); await save();
  if (authorOnly) {
    report.status = 'authored'; report.finishedAt = new Date().toISOString(); await save();
    console.log(`Draft ${draftId} saved for independent source audit. Resume with --draft=${draftId}; no package, policy or answer key was supplied.`);
  } else {
  assert.match(paymentStep.destination ?? '', /payment|payable|accounting/i, 'The employee requested a local payment list.');
  report.sourceLimitations = ['Independent source audit found that zero uploaded files can index an empty evidence list in the generated missing-document loop. The app must reject an empty-file run before this script executes. One-document and altered-document paths are tested below.'];
  await testDraft(draftId);
  await testDraft(draftId, 'mismatch');
  await testDraft(draftId, 'missing');
  await testDraft(draftId, 'precision');
  const queueAfterTests = await get<QueueRecord[]>('/api/queues');
  assert.deepEqual(queueAfterTests, queueBefore, 'Sample tests must not commit payment rows.');
  await page.getByRole('checkbox', { name: /^I reviewed the workflow/ }).check();
  const publishing = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith(`/workflow-drafts/${draftId}/publish`));
  await page.getByRole('button', { name: 'Publish workflow', exact: true }).click();
  const published = await publishing;
  assert.equal(published.ok(), true, await published.text());
  const version = await published.json() as PublishedWorkflow;
  report.versionId = version.id;
  const exported = await get(`/api/workflows/${version.id}/export`);
  await writeFile(path.join(output, 'published.json'), JSON.stringify(exported, null, 2));
  await writeFile(path.join(attemptOutput, 'published.json'), JSON.stringify(exported, null, 2));
  await screenshot('published'); await save();
  const matching = await startBusinessCase(version);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  assert.deepEqual(await get('/api/queues'), queueBefore, 'A matching invoice entered the payment list before approval.');
  await screenshot('matching-awaiting-approval');
  await page.getByRole('checkbox', { name: 'I approve this result and the proposed action.', exact: true }).check();
  const approving = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith(`/cases/${matching.id}/approve`));
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const approved = await approving;
  assert.equal(approved.ok(), true, await approved.text());
  await expect(page.getByText('Approved and added to the list', { exact: true })).toBeVisible();
  const queueAfterApproval = await get<QueueRecord[]>('/api/queues');
  const added = queueAfterApproval.filter(record => !queueBefore.some(previous => previous.id === record.id));
  assert.equal(added.length, 1);
  assert.equal(added[0].caseId, matching.id);
  assert.match(added[0].destination, /payment|payable|accounting/i, 'The employee requested a local payment list.');
  const amounts = recordLeaves(added[0].record).filter(leaf => {
    const parts = leaf.key.split('.'); const last = parts.at(-1)!;
    return (/amount|total/i.test(last) || (last === 'value' && /amount|total/i.test(parts.at(-2) ?? ''))) && typeof leaf.value !== 'boolean';
  });
  assert.ok(amounts.length, 'The payment-list record has no named amount or total.');
  for (const amount of amounts) assert.equal(Number(String(amount.value).replace(/^AZN\s*/i, '')), 560, `Incorrect payment amount at ${amount.key}`);
  assert.ok(recordLeaves(added[0].record).some(leaf => leaf.value === 'AZN'), 'The payment-list record does not preserve AZN currency.');
  report.approvedCaseId = matching.id; report.paymentRecord = added[0];
  await screenshot('payment-approved'); await save();
  await page.reload();
  assert.deepEqual(await get('/api/queues'), queueAfterApproval, 'Reload repeated the payment-list action.');
  await finishPublishedControls(version, queueAfterApproval);
  }
  }
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); report.finishedAt = new Date().toISOString();
  if (typeof report.draftId === 'string') {
    await readDraft(report.draftId).then(async draft => {
      report.authoring = draft.messages; report.draftError = draft.error; report.candidateDiagnostics = draft.candidateDiagnostics;
      report.authorRuns = await Promise.all(draft.messages.filter(message => message.role === 'assistant' && message.runId).map(message => get(`/api/runs/${message.runId}`)));
      await writeFile(path.join(attemptOutput, 'generated-draft.json'), JSON.stringify(draft, null, 2));
    }).catch(() => {});
  }
  await screenshot('failure').catch(() => {}); await save();
  throw error;
} finally { await browser.close(); }
