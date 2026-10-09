/** Reversible catalog cleanup. Cases, receipts, queues, and packages stay intact. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PublishedWorkflow, WorkflowDraft } from '../shared/workflow-types.js';

const baseURL = process.env.CATALOG_APP_URL ?? 'http://127.0.0.1:3001';
const keepVersion = process.argv.find(arg => arg.startsWith('--keep='))?.slice('--keep='.length);
const keepDraft = process.argv.find(arg => arg.startsWith('--keep-draft='))?.slice('--keep-draft='.length);
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${url}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
const [versions, drafts, queues] = await Promise.all([
  request<PublishedWorkflow[]>('/workflows?includeArchived=true'),
  request<WorkflowDraft[]>('/workflow-drafts?includeArchived=true'),
  request<unknown[]>('/queues'),
]);
if (keepVersion && !versions.some(v => v.id === keepVersion)) throw new Error('The workflow to keep does not exist.');
if (keepDraft && !drafts.some(d => d.id === keepDraft)) throw new Error('The draft to keep does not exist.');
if (drafts.some(d => d.status === 'authoring')) throw new Error('Wait for authoring to finish before catalog cleanup.');
const folder = path.resolve('.agent-state/validation/workflows/cleanup');
await mkdir(folder, { recursive: true });
const reportPath = path.join(folder, `archive-${new Date().toISOString().replaceAll(':', '-')}.json`);
const report = { createdAt: new Date().toISOString(), keepVersion, keepDraft, before: { versions, drafts, queues }, archivedVersions: [] as string[], archivedDrafts: [] as string[] };
await writeFile(reportPath, JSON.stringify(report, null, 2));
for (const version of versions) if (!version.archivedAt && version.id !== keepVersion) {
  await request(`/workflows/${version.id}/archive`, { archived: true });
  report.archivedVersions.push(version.id);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
for (const draft of drafts) if (!draft.archivedAt && draft.id !== keepDraft) {
  await request(`/workflow-drafts/${draft.id}/archive`, { archived: true });
  report.archivedDrafts.push(draft.id);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
if (JSON.stringify(await request('/queues')) !== JSON.stringify(queues)) throw new Error('Queue records changed during cleanup.');
console.log(`Archived ${report.archivedVersions.length} workflows and ${report.archivedDrafts.length} drafts. Restore them from the archive. Report: ${reportPath}`);
