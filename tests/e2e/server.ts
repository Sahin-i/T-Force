/**
 * Same HTTP server, persistence, harness, Docker tools, and production UI as the
 * app; only the model is deterministic. Every file and chat lives in temp state.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response, ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { config } from '../../server/config.js';
import { createApp } from '../../server/app.js';
import { AgentHarness } from '../../server/agent.js';
import { SandboxManager } from '../../server/sandbox.js';
import { ConversationStore } from '../../server/store.js';
import type { ModelClient } from '../../server/model.js';
import { HarnessError } from '../../server/errors.js';
import { createCatalogModel } from '../../catalog/test-model.js';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'office-browser-e2e-'));
const cfg = { ...config, port: 3021, endpoint: 'https://example.invalid', apiKey: 'e2e-model-is-injected', model: 'Deterministic E2E model', workspaceDir: path.join(temporary, 'workspace'), stateDir: path.join(temporary, 'state') };
const manager = new SandboxManager({ workspaceDir: cfg.workspaceDir, image: cfg.sandboxImage, commandTimeoutMs: cfg.commandTimeoutMs, maxOutputBytes: cfg.maxToolOutputBytes });
const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});
function promptText(input: ResponseInputItem[]): string {
  const last = [...input].reverse().find(item => item.type !== 'function_call_output' && 'role' in item && item.role === 'user') as { content: string | { type: string; text?: string }[] } | undefined;
  return typeof last?.content === 'string' ? last.content : last?.content.map(item => item.text ?? '').join('\n') ?? '';
}
function response(text: string): Response {
  return { id: `e2e-response-${randomUUID()}`, status: 'completed', output: [{ type: 'message', id: `e2e-message-${randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } as unknown as Response;
}
function call(name: string, args: object): Response {
  return { ...response(''), output: [{ type: 'function_call', id: `e2e-function-${randomUUID()}`, call_id: `e2e-call-${randomUUID()}`, name, arguments: JSON.stringify(args), status: 'completed' }] } as unknown as Response;
}
class DeterministicModel implements ModelClient {
  private turns = 0;
  private readonly catalog = createCatalogModel();
  async respond(input: ResponseInputItem[], _tools: unknown, signal: AbortSignal, emit: (event: ResponseStreamEvent) => Promise<void>): Promise<Response> {
    const prompt = promptText(input);
    if (prompt.includes('Workflow authoring, draft ')) return this.catalog.respond(input, _tools as Parameters<ModelClient['respond']>[1], signal, emit);
    const first = this.turns++ === 0;
    if (prompt.includes('E2E provider failure')) throw new HarnessError('E2E_PROVIDER_FAILURE', 'The deterministic model failed before producing output.');
    if (first && prompt.includes('E2E create artifact')) return call('bash', { command: "printf 'Created by actual Docker tool\\n' > outputs/e2e-created.txt; cat outputs/e2e-created.txt", timeoutMs: null });
    if (first && prompt.includes('E2E tool cancellation')) return call('bash', { command: "echo E2E-command-started; sleep 30; printf 'Unexpected late write' > outputs/e2e-late-write.txt", timeoutMs: null });
    if (first && prompt.includes('E2E attachment inspection')) {
      const paths = [...prompt.matchAll(/Attached file: \/workspace\/(\S+) \(/g)].map(match => match[1]);
      return call('read', { path: `/workspace/${paths[0]}`, offset: null, limit: null });
    }
    const text = prompt.includes('E2E create artifact') ? 'Created [the artifact](sandbox:/workspace/outputs/e2e-created.txt).'
      : prompt.includes('E2E markdown') ? '## Verified result\n\n**Bold text** and `inline code`.\n\n| Label | Value |\n| --- | ---: |\n| Total | 42 |\n\n[External reference](https://example.com)\n\n[Unsafe](javascript:alert(1))\n\n[Missing file](sandbox:/workspace/outputs/not-created.txt)'
      : prompt.includes('E2E attachment inspection') ? 'Uploaded fixture inspected with the read tool.'
      : 'E2E streamed message completed exactly once.';
    if (prompt.includes('E2E slow model')) {
      await emit({ type: 'response.output_text.delta', delta: 'Slow stream started.', sequence_number: 1, item_id: 'e2e-message', output_index: 0, content_index: 0, logprobs: [] });
      await wait(30_000, signal);
    }
    const chunks = prompt.includes('E2E reconnect') ? ['E2E ', 'streamed ', 'message ', 'completed ', 'exactly once.'] : [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
    for (const [index, delta] of chunks.entries()) {
      signal.throwIfAborted();
      await emit({ type: 'response.output_text.delta', delta, sequence_number: index + 1, item_id: 'e2e-message', output_index: 0, content_index: 0, logprobs: [] });
      await wait(prompt.includes('E2E reconnect') ? 1300 : 200, signal);
    }
    return response(text);
  }
}

const store = new ConversationStore(cfg.stateDir);
const harness = new AgentHarness(cfg, store, manager, () => new DeterministicModel());
const { app } = await createApp(cfg, { store, harness, sandboxes: manager, skipRecovery: true });
const eventStreams = new Set<import('node:http').ServerResponse>();
app.addHook('onRequest', async (request, reply) => {
  if (/^\/api\/runs\/[^/]+\/events(?:\?|$)/.test(request.url)) {
    eventStreams.add(reply.raw);
    reply.raw.once('close', () => eventStreams.delete(reply.raw));
  }
});
app.post('/api/e2e/disconnect-streams', async () => {
  const count = eventStreams.size;
  // Cut the actual SSE socket while leaving the running harness intact.
  for (const stream of eventStreams) stream.destroy();
  return { disconnected: count };
});
const seed = await manager.create('e2e-preview-fixtures', new AbortController().signal);
try {
  const result = await seed.exec(`python - <<'PY'
from pathlib import Path
from docx import Document
from docx.shared import Inches
from openpyxl import Workbook
from reportlab.pdfgen import canvas
from PIL import Image
from zipfile import ZipFile, ZIP_DEFLATED
p=Path('/workspace/outputs');p.mkdir(exist_ok=True)
(p/'e2e-text.txt').write_text('E2E UTF-8 preview: Bakı ✓\\n')
(p/'e2e-empty.txt').write_text('')
(p/'e2e-long.txt').write_text('Truncated preview content\\n'*50000)
(p/'e2e-table.csv').write_text('name,value\\n"Comma, name",7\\n"Line\\nbreak",8\\n')
(p/'e2e-binary.bin').write_bytes(b'\\x00\\x01\\x02')
(p/'e2e-broken.docx').write_bytes(b'invalid zip')
Image.new('RGB',(240,120),'#397b54').save(p/'e2e-image.png')
d=Document();d.add_heading('E2E DOCX heading',0);d.add_paragraph('E2E document body with Bakı and Unicode ✓.')
t=d.add_table(rows=1, cols=2);t.rows[0].cells[0].text='Document cell';t.rows[0].cells[1].text='42';d.add_picture(str(p/'e2e-image.png'),width=Inches(1.5));d.add_page_break();d.add_paragraph('E2E second document page');d.save(p/'e2e-document.docx')
w=Workbook();s=w.active;s.title='Inputs';s.append(['Name','Value']);s.append(['Alpha',7]);s.append(['Beta',8]);s['B4']='=SUM(B2:B3)';s['A5']='=WEBSERVICE("https://example.invalid")';s['C2']=.125;s['C2'].number_format='0.0%';s['C3']=1234.5;s['C3'].number_format='$#,##0.00';s.merge_cells('D2:E2');s['D2']='Merged label';s['F201']='Beyond preview';z=w.create_sheet('Other sheet');z.append(['Another sheet',99]);w.save(p/'e2e-workbook.xlsx')
with ZipFile(p/'e2e-workbook.xlsx') as source:
 data={name:source.read(name) for name in source.namelist()}
data['xl/worksheets/sheet1.xml']=data['xl/worksheets/sheet1.xml'].replace(b'<f>SUM(B2:B3)</f><v></v>',b'<f>SUM(B2:B3)</f><v>15</v>')
with ZipFile(p/'e2e-workbook.xlsx','w',ZIP_DEFLATED) as target:
 for name,value in data.items():target.writestr(name,value)
c=canvas.Canvas(str(p/'e2e-reference.pdf'));c.drawString(72,720,'E2E first PDF page');c.showPage();c.drawString(72,720,'E2E second PDF page');c.save()
PY`);
  if (result.exitCode !== 0) throw new Error(result.stderr);
} finally { await seed.dispose(); }
// Supply a second preexisting chat so switching has a stable target from start.
const history = await store.create();
history.title = 'E2E existing history';
history.messages.push({ id: 'history-message', role: 'assistant', text: 'Restored history fixture.', createdAt: history.createdAt, attachments: [], tools: [], status: 'completed', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, elapsedMs: 1000 });
await store.save(store.get(history.id));
app.get('/api/e2e/observability', async () => ({ runs: store.allRuns(), files: await import('../../server/files.js').then(module => module.listWorkspaceFiles(cfg.workspaceDir)) }));
await writeFile(path.join(temporary, 'fixture-mode.txt'), 'Deterministic model, actual server and Docker tools. No Azure requests.');
await app.listen({ host: '127.0.0.1', port: cfg.port });
console.log(`Isolated browser E2E server: http://127.0.0.1:${cfg.port}`);
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  void app.close().then(() => rm(temporary, { recursive: true, force: true })).then(() => process.exit(0));
});
