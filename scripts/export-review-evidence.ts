/** Explicit allowlist: no credentials, application database, chats or customer workspace. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';

const root = process.cwd();
const out = path.join(root, 'deliverables/evidence');
await mkdir(out, { recursive: true });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const copied: { source: string; file: string; sha256: string; bytes: number }[] = [];
const originalEvidence = path.join(root, 'deliverables/Office-Evidence.json');
const priorEvidence = path.join(out, 'prior-submission-evidence.json');
if (!existsSync(priorEvidence) && existsSync(originalEvidence)) await writeFile(priorEvidence, await readFile(originalEvidence));

async function copy(source: string, destination: string) {
  if (!existsSync(source)) return false;
  const bytes = await readFile(source);
  const target = path.join(out, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  copied.push({ source: path.relative(root, source), file: `deliverables/evidence/${destination}`, sha256: sha(bytes), bytes: bytes.length });
  return true;
}
const sources = [
  ['.agent-state/validation/workflows/evaluation-report.json', 'catalog-evaluation.json'],
  ['.agent-state/validation/workflows/general-agent-report.json', 'general-agent-evaluation.json'],
  ['.agent-state/validation/workflows/author-verification/report.json', 'author-verification.json'],
  ['.agent-state/validation/simple-invoice/live-report.json', 'simple-live-report.json'],
  ['.agent-state/validation/simple-invoice/generated-draft.json', 'simple-invoice/generated-draft.json'],
  ['.agent-state/validation/simple-invoice/published.json', 'simple-invoice/published.json'],
  ['deliverables/Office-Demo-Reviewed.json', 'demo-recording.json'],
];
for (const [source, destination] of sources) await copy(path.join(root, source), destination);
for (const suite of ['invoice-development', 'invoice-heldout', 'onboarding-development', 'onboarding-heldout', 'complaints-development', 'complaints-heldout'])
  await copy(path.join(root, '.agent-state/validation/workflows', `${suite}.json`), `truth/${suite}.json`);
const attempts = path.join(root, '.agent-state/validation/simple-invoice/attempts');
if (existsSync(attempts)) for (const attempt of await readdir(attempts)) {
  await copy(path.join(attempts, attempt, 'report.json'), `simple-invoice/attempts/${attempt}/report.json`);
}
for (const name of ['starter.png', 'generated-review.png', 'matching-test.png', 'mismatch-blocked.png', 'duplicate-prevented.png']) {
  const live = JSON.parse(await readFile(path.join(out, 'simple-live-report.json'), 'utf8')) as { attemptId: string; resumedFrom?: string };
  for (const id of [live.attemptId, live.resumedFrom].filter(Boolean)) if (await copy(path.join(attempts, id!, name), `images/${name}`)) break;
}
const read = async (filename: string) => JSON.parse(await readFile(path.join(out, filename), 'utf8'));
const catalog = await read('catalog-evaluation.json');
const general = await read('general-agent-evaluation.json');
const live = await read('simple-live-report.json');
const integrity = existsSync(path.join(out, 'invoice-integrity/report.json')) ? await read('invoice-integrity/report.json') : null;
const verification = existsSync(path.join(out, 'verification.json')) ? await read('verification.json') : null;
const localPublication = existsSync(path.join(out, 'local-reviewed-publication.json')) ? await read('local-reviewed-publication.json') : null;
const currentCatalog = existsSync(path.join(out, 'catalog-evaluation-current.json')) ? await read('catalog-evaluation-current.json') : null;
const recording = existsSync(path.join(out, 'demo-recording.json')) ? await read('demo-recording.json') : null;
const evidence = {
  project: 'Office', generatedAt: new Date().toISOString(), timezone: 'Asia/Baku', synthetic: true,
  verification,
  liveAuthoring: { model: live.health?.model, method: live.method, status: live.status, packageHash: live.packageHash, publicationTested: Boolean(live.versionId), originalFocusedControls: live.steps.length, usage: live.authorRuns?.map((run: { usage: unknown }) => run.usage), report: 'deliverables/evidence/simple-live-report.json', limitation: 'One successful template-free starter and focused controls do not measure broad workflow-generation accuracy. Initial failed authoring and UI failures are retained.' },
  invoiceIntegrity: integrity ? { method: integrity.method, status: integrity.status, before: { packageHash: integrity.before?.packageHash, tested: integrity.before?.tested, passed: integrity.before?.passed, falseReady: integrity.before?.falseReady }, after: { packageHash: integrity.after?.packageHash, tested: integrity.after?.tested, passed: integrity.after?.passed, falseReady: integrity.after?.falseReady }, repairMethod: integrity.repairMethod, report: 'deliverables/evidence/invoice-integrity/report.json', limitation: 'Focused regression controls, including varied matching facts. Supported starter layout only. Historical package remains unchanged; reviewed source is a separate version.' } : { status: 'not_run' },
  localReviewedPublication: localPublication ? { status: localPublication.status, method: localPublication.method, packageHash: localPublication.packageHash, versionId: localPublication.versionId, archived: localPublication.archived, queueRecordsPreserved: localPublication.queueRecordsPreserved, report: 'deliverables/evidence/local-reviewed-publication.json' } : null,
  currentCatalogEvaluation: currentCatalog ? { metrics: currentCatalog.metrics, method: currentCatalog.provenance, report: 'deliverables/evidence/catalog-evaluation-current.json' } : null,
  demoRecording: recording ? { status: recording.status, method: recording.method, report: 'deliverables/evidence/demo-recording.json', video: 'deliverables/Office-Demo-Reviewed.mp4' } : null,
  catalogEvaluation: { method: catalog.provenance, metrics: catalog.metrics, scope: catalog.method, report: 'deliverables/evidence/catalog-evaluation.json' },
  generalAgent: { model: general.model, method: general.provenance, metrics: general.metrics, additionalMetrics: general.additionalMetrics, report: 'deliverables/evidence/general-agent-evaluation.json', limitation: 'Same-model synthetic comparison with supplied reporting contract. Two development setups did not publish. This does not establish superiority over commercial products.' },
  disclosure: { runtimeModel: 'Configured Azure GPT-6 Luna through Responses API', developmentAssistance: 'OpenAI Codex assisted code, tests, documentation, slides and this review. Specific development-model build was not recorded.', data: 'All example company identities, business documents and policies are fictional. Expected benchmark truth stays outside execution mounts.', components: ['Application-owned TypeScript agent loop and workflow interpreter', 'React/Vite/Fastify/Zod/OpenAI TypeScript client', 'Docker/Python/SQLite', 'ExcelJS/PDF.js/docx-preview/fflate', 'Pinned Python libraries in sandbox/requirements.txt'], templates: 'Enterprise catalog procedures use supplied executable templates. The original simple starter was generated from four sentences and two PDFs. Its reviewed integrity repair is team-edited code, disclosed separately.' },
  limitations: ['No process-owner interviews, customer adoption or measured production savings supplied.', 'Local application with one active execution, no multi-user authentication and simulated queues.', 'Arbitrary layouts and image-only scanned invoices are not reliably supported by example parsers.', 'Model use sends relevant supplied content to the configured Azure service.', 'Actual billing, hosting and employee review cost remain unmeasured.', 'Hackathon build timing and eligibility are unverified; no Git history exists in this checkout.', 'Accessible repository URL, hosted demo and demo-video link still need participant publication.'],
  files: copied,
};
await writeFile(originalEvidence, JSON.stringify(evidence, null, 2));

if (process.argv.includes('--zip')) {
  const entries: Record<string, Uint8Array> = {};
  const files = ['README.md', 'package.json', 'package-lock.json', 'index.html', '.env.example', '.dockerignore', '.gitignore', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.tools.json', 'vite.config.ts', 'playwright.config.ts'];
  async function collect(relative: string) {
    const directory = path.join(root, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('~$') || entry.name === 'Office-Review-Package.zip') continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  for (const directory of ['server', 'client', 'shared', 'sandbox', 'scripts', 'tests', 'catalog', 'demo-assets', 'deliverables/evidence']) await collect(directory);
  for (const filename of ['Office-Evidence.json', 'Office-Reviewer-Report.txt', 'Office-Submission-Revised.txt', 'Office-Pilot-and-Costs.txt', 'Office-Pitch-Reviewed.pdf', 'Office-Pitch-Reviewed.pptx', 'Office-Demo-Reviewed.mp4', 'Office-Demo-Reviewed.webm']) {
    if (existsSync(path.join(root, 'deliverables', filename))) files.push(`deliverables/${filename}`);
  }
  for (const filename of [...new Set(files)].sort()) entries[filename] = await readFile(path.join(root, filename));
  const manifest = Object.entries(entries).map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha(bytes) }));
  const manifestBytes = Buffer.from(JSON.stringify({ generatedAt: new Date().toISOString(), exclusions: ['.env and credentials', '.agent-state database/chats', 'workspace/customer files', 'node_modules', 'dist', '.pitch-build', 'test-results'], files: manifest }, null, 2));
  entries['deliverables/Source-Manifest.json'] = manifestBytes;
  await writeFile(path.join(root, 'deliverables/Source-Manifest.json'), manifestBytes);
  await writeFile(path.join(root, 'deliverables/Office-Review-Package.zip'), zipSync(entries, { level: 6 }));
  console.log(`Packaged ${manifest.length} files with SHA-256 manifest; credentials and private application state excluded.`);
}
console.log(`Exported ${copied.length} retained evidence files. Current evidence: deliverables/Office-Evidence.json.`);
