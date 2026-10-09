/** Record the actual reviewed local UI. No authoring, import, or model requests. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Health } from '../shared/types.js';
import type { PublishedWorkflow, QueueRecord, WorkflowCase } from '../shared/workflow-types.js';

const baseURL = process.env.REVIEWED_DEMO_APP_URL ?? 'http://127.0.0.1:3001';
const address = new URL(baseURL);
assert(address.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'Record only the local app.');
const versionId = process.argv.find(argument => argument.startsWith('--version='))?.slice('--version='.length) ?? '7c6e7da3-05cc-4cd3-9a47-765d712d56ea';
const output = path.resolve('deliverables');
await mkdir(output, { recursive: true });
const recordingDirectory = await mkdtemp(path.join(os.tmpdir(), 'office-reviewed-recording-'));
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const cached = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find(existsSync) : undefined;
// Offline machines can use an installed FFmpeg with VP9 support through a
// temporary process-only cache, leaving installation directories untouched.
// Chromium itself still uses its explicit cached path.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(cache)) {
  const registry = JSON.parse(await readFile(path.resolve('node_modules/playwright-core/browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] };
  const required = registry.browsers.find(item => item.name === 'ffmpeg');
  const installed = [process.env.REVIEWED_DEMO_FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((file): file is string => !!file && existsSync(file));
  if (required && installed) {
    const processCache = path.join(recordingDirectory, 'browser-cache');
    const recorder = path.join(processCache, `ffmpeg-${required.revision}`);
    await mkdir(recorder, { recursive: true });
    await symlink(installed, path.join(recorder, 'ffmpeg-mac'));
    process.env.PLAYWRIGHT_BROWSERS_PATH = processCache;
  }
}
const { chromium, expect } = await import('@playwright/test');
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? cached });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, recordVideo: { dir: recordingDirectory, size: { width: 1440, height: 1000 } } });
await context.addInitScript(() => { localStorage.setItem('office.page', 'workflows'); });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const video = page.video()!;
const startedAt = new Date().toISOString();
const createdCases: string[] = [];
const forbiddenRequests: string[] = [];
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', route => {
  const request = route.request();
  if (request.method() === 'POST' && /\/(?:chats|workflow-drafts)\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) {
    forbiddenRequests.push(request.url());
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
async function get<T>(resource: string): Promise<T> {
  const response = await context.request.get(`/api/${resource}`);
  assert(response.ok(), `Local API read failed: ${resource}`);
  return response.json();
}
async function caption(title: string, text: string, milliseconds: number) {
  await page.evaluate(({ title, text }) => {
    let panel = document.getElementById('office-recording-caption');
    if (!panel) {
      panel = document.createElement('aside');
      panel.id = 'office-recording-caption';
      panel.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:9999;width:min(1060px,calc(100vw - 48px));padding:15px 22px;border:1px solid #638873;border-radius:10px;background:rgba(24,44,33,.96);color:white;box-shadow:0 5px 30px #0003;pointer-events:none;font-family:system-ui,sans-serif;';
      document.body.append(panel);
    }
    const heading = document.createElement('strong');
    heading.style.cssText = 'display:block;font-size:20px;line-height:1.4;margin-bottom:4px;';
    heading.textContent = title;
    const body = document.createElement('div');
    body.style.cssText = 'font-size:17px;line-height:1.5;color:#e8f1eb;';
    body.textContent = text;
    panel.replaceChildren(heading, body);
  }, { title, text });
  // Readable pauses belong only to the recording, never to app behavior.
  await page.waitForTimeout(milliseconds);
}
async function startCase(title: string, files?: string[]) {
  const modalButton = page.locator('.wf-header, .wf-detail-aside').getByRole('button', { name: 'Run workflow', exact: true });
  await modalButton.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Case workflow', exact: true }).selectOption(versionId);
  await dialog.getByRole('textbox', { name: 'Case title', exact: true }).fill(title);
  if (files) await dialog.locator('input[type=file]').setInputFiles(files);
  else await dialog.getByRole('button', { name: 'Use sample documents', exact: true }).click();
  await expect(dialog.locator('.wf-file-chip')).toHaveCount(2);
}
async function runCase(expected: WorkflowCase['status']): Promise<WorkflowCase> {
  const started = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/cases');
  await page.getByRole('dialog').getByRole('button', { name: 'Run workflow', exact: true }).click();
  const initial: WorkflowCase = await (await started).json();
  createdCases.push(initial.id);
  await expect.poll(async () => (await get<WorkflowCase>(`cases/${initial.id}`)).status, { timeout: 60_000 }).toBe(expected);
  await expect(page.locator('.wf-case-title')).toBeVisible();
  const completed = await get<WorkflowCase>(`cases/${initial.id}`);
  assert.equal(completed.revisions.at(-1)?.usage.totalTokens, 0, 'Reviewed Python execution must not invoke AI.');
  assert.equal(completed.revisions.at(-1)?.cleanupFinished, true);
  return completed;
}

let outcome = 'failed';
let failure: unknown;
try {
  const health = await get<Health>('health');
  assert(health.docker.ready && !health.activeExecution && !health.activeRun, 'The local server must be idle with Docker ready.');
  const versions = await get<PublishedWorkflow[]>('workflows?includeArchived=true');
  const reviewed = versions.find(version => version.id === versionId);
  assert(reviewed && !reviewed.archivedAt, 'The reviewed version must be published and active.');
  assert(reviewed.package.steps.every(step => step.type !== 'ai'), 'Recording cannot execute model tasks.');
  assert(reviewed.provenance.some(message => message.text.includes('No AI authoring was performed.')), 'Require explicit imported-code provenance.');
  const original = versions.find(version => version.name === 'Invoice check' && version.archivedAt && version.provenance.some(message => message.role === 'assistant'));
  assert(original, 'Retained earlier AI-generated workflow history must exist.');
  const beforeQueues = await get<QueueRecord[]>('queues');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Your team's workflows.", exact: true })).toBeVisible();
  await caption('Office: reusable workflows with employee review', 'Actual local UI • fictional starter documents • no new AI generation in this recording.', 6500);
  await page.locator('.wf-grid .wf-card').filter({ has: page.getByRole('heading', { name: reviewed.name, exact: true }) }).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('.wf-package-title')).toHaveText(reviewed.name);
  await caption('A procedure the employee can read', 'Compare the invoice and order, explain differences, prepare a summary, and require approval before adding a local list entry.', 7000);

  await page.getByText('Advanced: versions and original instructions', { exact: true }).click();
  await page.locator('.wf-detail-aside .wf-section > summary').first().click();
  await caption('Provenance is preserved', 'An earlier draft was generated by gpt-6-luna. The team reviewed and repaired its code, then imported this version. Earlier source history remains archived.', 8000);
  await page.getByText('Advanced: steps, scripts and references', { exact: true }).click();
  const script = page.getByText('Script: compare.py', { exact: true });
  await script.click();
  await script.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await caption('Inspectable code, declared limits', 'Saved Python code runs in isolated containers. This starter supports its labelled searchable-PDF layout; unsupported or ambiguous evidence needs clarification.', 8000);
  await page.locator('.wf-body').evaluate(element => { element.scrollTop = 0; });

  await startCase('Recorded demonstration: matching synthetic invoice');
  await caption('Run the same procedure on two actual PDFs', 'Built-in fictional supplier invoice and purchase order. The published code is reused; there is no model authoring request.', 6000);
  const matching = await runCase('awaiting_review');
  await page.locator('.wf-artifact button').first().click();
  await expect(page.getByRole('dialog')).toContainText('AZN 560.00');
  await caption('The written result is retained', 'A verified summary records the amount, findings and review scope. The employee checks the result before any local action.', 8000);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  const decision = page.locator('.wf-approval');
  await decision.scrollIntoViewIfNeeded();
  await expect(decision).toContainText('Caspian Office Supplies');
  await expect(decision).toContainText('INV-2026-1042');
  await expect(decision).toContainText('560.00');
  await expect(decision.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await caption('Approval binds to the exact result', 'Supplier: Caspian Office Supplies • invoice INV-2026-1042 • AZN 560.00. Approval stays disabled until the employee explicitly confirms.', 6500);

  const queueStep = reviewed.package.steps.find(step => step.type === 'queue')!;
  const result = matching.revisions.at(-1)!.tasks.find(task => task.stepId === 'compare')!.result as { businessKey: string; queueRecord: Record<string, unknown> };
  const existing = beforeQueues.find(record => record.destination === queueStep.destination && record.businessKey === result.businessKey);
  assert(existing, 'Only confirm a result already present in the local list.');
  assert.deepEqual(result.queueRecord, existing.record, 'Never confirm a conflicting existing business record.');
  await decision.getByRole('checkbox', { name: 'I approve this result and the proposed action.', exact: true }).check();
  await decision.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Already added to the list', { exact: true })).toBeVisible();
  await caption('One record, even when the same invoice returns', 'The existing entry is reused. No duplicate record is created, and this demonstration sends no payment.', 6500);

  await startCase('Recorded demonstration: quantity discrepancy', [path.resolve('catalog/simple-invoice/mismatch/invoice.pdf'), path.resolve('catalog/simple-invoice/purchase-order.pdf')]);
  await caption('Now change the evidence', 'The replacement invoice charges for ten routers (AZN 700); the purchase order still requests eight (AZN 560).', 6000);
  await runCase('blocked');
  await expect(page.locator('.wf-finding')).toContainText(['quantity', 'amount']);
  await caption('Differences block approval', 'The same published code flags quantity and total differences, retains its evidence, and keeps this invoice out of the payment list.', 8000);
  await page.locator('.wf-artifact button').first().click();
  await expect(page.getByRole('dialog')).toContainText('AZN 700.00');
  await caption('A working control, with honest scope', 'Searchable starter PDFs • reviewable findings • exact result fingerprints • employee approval • local duplicate prevention. No new model calls were made.', 6500);
  assert.deepEqual(await get<QueueRecord[]>('queues'), beforeQueues, 'All existing queue records must remain unchanged.');
  assert.deepEqual(await get<PublishedWorkflow[]>('workflows?includeArchived=true'), versions, 'Recording must preserve all published source history.');
  assert.deepEqual(forbiddenRequests, []);
  assert.deepEqual(errors, []);
  outcome = 'passed';
} catch (error) {
  failure = error;
} finally {
  await context.close();
  await browser.close();
  const recording = path.join(output, 'Office-Demo-Reviewed.webm');
  const rawRecording = await video.path();
  if (existsSync(rawRecording)) await rename(rawRecording, recording);
  else { outcome = 'failed'; failure ??= new Error('Native recorder did not produce a video file.'); }
  await writeFile(path.join(output, 'Office-Demo-Reviewed.json'), JSON.stringify({ status: outcome, startedAt, finishedAt: new Date().toISOString(), baseURL, workflowVersionId: versionId, createdCases, authorRequests: forbiddenRequests.length, error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined, method: 'Native Playwright recording of actual local UI with recording-only captions. Synthetic source PDFs, published reviewed Python code, no AI authoring or model execution. Existing queues and source history verified unchanged.' }, null, 2) + '\n');
  console.log(JSON.stringify({ status: outcome, recording, createdCases }, null, 2));
}
if (failure) throw failure;
