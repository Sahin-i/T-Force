/** Read-only screenshots of the running workflow UI; no cases or drafts are submitted. */
import { chromium } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PublishedWorkflow, WorkflowCase, WorkflowDraft } from '../shared/workflow-types.js';

const base = process.env.CAPTURE_APP_URL ?? 'http://127.0.0.1:3001';
const output = path.resolve(process.env.CAPTURE_OUTPUT_DIR ?? 'test-results');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const cachedBrowser = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find(file => existsSync(file)) : undefined;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? cachedBrowser });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  // Screenshots may change this browser's selection, but cannot submit work.
  await context.route('**/api/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) return route.abort('blockedbyclient');
    return route.continue();
  });
  const workflowResponse = await context.request.get(`${base}/api/workflows`);
  if (!workflowResponse.ok()) throw new Error(`Could not read the catalog (${workflowResponse.status()}).`);
  const workflows: PublishedWorkflow[] = await workflowResponse.json();
  const workflow = workflows.filter(item => /invoice/i.test(item.name)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
  if (!workflow) throw new Error('There is no active invoice workflow to capture.');
  const response = await context.request.get(`${base}/api/workflow-drafts`);
  if (!response.ok()) throw new Error(`Could not read workflows (${response.status()}).`);
  const drafts: WorkflowDraft[] = await response.json();
  const valid = drafts.filter(draft => draft.revisions.length > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const draft = valid.find(item => item.id === workflow.draftId) ?? valid.find(item => /invoice/i.test(item.name)) ?? valid[0];
  if (!draft) throw new Error('There is no imported workflow revision to capture.');
  await context.addInitScript(() => { if (!localStorage.getItem('office.page')) localStorage.setItem('office.page', 'workflows'); });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('.wf-grid').waitFor();
  await page.getByText('Connecting to server', { exact: true }).waitFor({ state: 'hidden' });
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'workflows-catalog.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create workflow', exact: true }).last().click();
  await page.getByRole('button', { name: 'Try sample', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Generate workflow', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'workflows-starter.png'), fullPage: true });
  await page.evaluate(({ draftId }) => { localStorage.setItem('office.page', 'create'); localStorage.setItem('office.workflow-draft', draftId); }, { draftId: draft.id });
  await page.reload();
  await page.locator('.wf-package-title').waitFor();
  await page.getByRole('button', { name: 'Publish workflow', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'workflows-review.png'), fullPage: true });
  const caseResponse = await context.request.get(`${base}/api/cases`);
  const cases: WorkflowCase[] = caseResponse.ok() ? await caseResponse.json() : [];
  const approved = cases.filter(item => item.workflowVersionId === workflow.id && item.approvals.some(approval => approval.revisionId === item.revisions.at(-1)?.id)).sort((a, b) => Number(a.approvals.find(approval => approval.revisionId === a.revisions.at(-1)?.id)?.duplicate) - Number(b.approvals.find(approval => approval.revisionId === b.revisions.at(-1)?.id)?.duplicate) || b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!approved) throw new Error('There is no current approved invoice run to capture.');
  {
    await page.evaluate(({ caseId }) => { localStorage.setItem('office.page', 'cases'); localStorage.setItem('office.workflow-case', caseId); }, { caseId: approved.id });
    await page.reload();
    await page.getByRole('heading', { name: 'Employee decision', exact: true }).waitFor();
    await page.getByText('Connecting to server', { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.wf-approval').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'workflows-approved-invoice.png'), fullPage: true });
    const artifact = approved.revisions.at(-1)?.artifacts.find(item => item.mime === 'text/markdown' || /\.md$/i.test(item.name));
    if (!artifact) throw new Error('The approved run has no Markdown review summary.');
    await page.locator('.wf-artifact').getByRole('button', { name: new RegExp(artifact.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
    await page.locator('.wf-document-markdown h1, .wf-document-markdown h2').first().waitFor();
    await page.getByRole('dialog').screenshot({ path: path.join(output, 'workflows-invoice-summary.png') });
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ workflowId: workflow.id, draftId: draft.id, approvedCaseId: approved.id, output, screenshots: ['workflows-catalog.png', 'workflows-starter.png', 'workflows-review.png', 'workflows-approved-invoice.png', 'workflows-invoice-summary.png'] }));
} finally { await browser.close(); }
