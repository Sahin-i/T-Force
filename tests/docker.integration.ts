import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SandboxManager } from '../server/sandbox.js';
import { executeTool } from '../server/tools.js';

// Explicit opt-in: Docker needs a running daemon and the locally built image.
test('Docker file tools, office artifacts, isolation, streaming and cancellation', { skip: process.env.RUN_DOCKER_TESTS !== '1', timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-agent-integration-'));
  const manager = new SandboxManager({ workspaceDir: directory, image: process.env.SANDBOX_IMAGE ?? 'office-agent-sandbox:local', commandTimeoutMs: 30_000, maxOutputBytes: 8192 });
  const ready = await manager.readiness();
  if (!ready.ready) {
    t.skip(ready.error);
    await rm(directory, { recursive: true, force: true });
    return;
  }
  const abort = new AbortController();
  const sandbox = await manager.create('integration', abort.signal);
  const tool = (name: string, args: object) => executeTool(sandbox, name, JSON.stringify(args), { signal: abort.signal, maxOutputBytes: 8192 });
  try {
    assert.equal((await tool('write', { path: '/workspace/outputs/notes.txt', content: 'alpha\nbeta\n' })).ok, true);
    assert.equal((await tool('edit', { path: '/workspace/outputs/notes.txt', oldText: 'beta', newText: 'gamma' })).ok, true);
    assert.equal((await tool('read', { path: '/workspace/outputs/notes.txt' })).output, 'alpha\ngamma\n');
    await tool('write', { path: '/workspace/outputs/crlf.txt', content: 'one\r\ntwo\r\n' });
    assert.equal((await tool('edit', { path: '/workspace/outputs/crlf.txt', oldText: 'one\r\n', newText: 'three\r\n' })).ok, true);
    assert.equal((await tool('read', { path: '/workspace/outputs/crlf.txt' })).output, 'three\r\ntwo\r\n');
    assert.equal((await tool('edit', { path: '/workspace/outputs/notes.txt', oldText: 'missing', newText: 'x' })).error?.code, 'MATCH_NOT_FOUND');
    await tool('write', { path: '/workspace/outputs/ambiguous.txt', content: 'aaa' });
    assert.equal((await tool('edit', { path: '/workspace/outputs/ambiguous.txt', oldText: 'aa', newText: 'x' })).error?.code, 'AMBIGUOUS_MATCH');
    assert.equal((await tool('write', { path: '/workspace/../escape', content: 'x' })).error?.code, 'INVALID_PATH');
    assert.equal((await tool('bash', { command: 'ln -s /etc /workspace/escape-link' })).ok, true);
    assert.equal((await tool('read', { path: '/workspace/escape-link/passwd' })).error?.code, 'INVALID_PATH');
    assert.equal((await tool('write', { path: '/workspace/escape-link/evil', content: 'x' })).error?.code, 'INVALID_PATH');
    const isolated = await tool('bash', { command: 'test ! -e /workspace/.env && test ! -e /workspace/.agent-state && test ! -e /var/run/docker.sock && test ! -e /workspace/server && env' });
    assert.equal(isolated.ok, true);
    assert.ok(!/AZURE|OPENAI_API_KEY/.test(isolated.output));
    const office = await tool('bash', { command: `python - <<'PY'
import csv, sqlite3
from openpyxl import Workbook, load_workbook
from docx import Document
from reportlab.pdfgen import canvas
from pypdf import PdfReader
import fitz
from PIL import Image
import requests
from pathlib import Path
p = Path('/workspace/outputs')
(p/'values.csv').write_text('name,amount\\nA,12\\nB,8\\n')
total = sum(int(row['amount']) for row in csv.DictReader((p/'values.csv').open()))
book = Workbook(); book.active.append(['Total', total]); book.save(p/'result.xlsx')
doc = Document(); doc.add_paragraph(f'Total: {total}'); doc.save(p/'summary.docx')
c = canvas.Canvas(str(p/'result.pdf')); c.drawString(72, 720, f'Total: {total}'); c.save()
assert load_workbook(p/'result.xlsx').active['B1'].value == 20
assert Document(p/'summary.docx').paragraphs[0].text == 'Total: 20'
assert '20' in PdfReader(p/'result.pdf').pages[0].extract_text()
pdf = fitz.open(p/'result.pdf'); pdf[0].get_pixmap().save(p/'page.png')
db = sqlite3.connect(p/'values.sqlite'); db.execute('create table amounts(value integer)'); db.executemany('insert into amounts values (?)', [(12,), (8,)]); db.commit()
assert db.execute('select sum(value) from amounts').fetchone()[0] == 20
Image.new('RGB', (10,10), 'red').save(p/'input.jpg')
import random
pixels = random.Random(42).randbytes(1600 * 1200 * 4)
Image.frombytes('RGBA', (1600,1200), pixels).save(p/'large-input.png')
print('Office formats and SQLite verified: 20')
PY` });
    assert.equal(office.ok, true, office.error?.message);
    assert.match(office.output, /verified: 20/);
    const image = await tool('read', { path: '/workspace/outputs/input.jpg' });
    assert.equal(image.ok, true);
    assert.equal(image.images?.[0].mime, 'image/jpeg');
    assert.ok(image.images![0].data.length > 0);
    const largeOriginal = await readFile(join(directory, 'outputs/large-input.png'));
    assert.ok(largeOriginal.byteLength > 256 * 1024);
    const largeHash = createHash('sha256').update(largeOriginal).digest('hex');
    const inspectedLarge = await tool('read', { path: '/workspace/outputs/large-input.png' });
    assert.equal(inspectedLarge.ok, true, inspectedLarge.error?.message);
    assert.equal(inspectedLarge.images?.[0].mime, 'image/jpeg');
    const inspectionBytes = Buffer.from(inspectedLarge.images![0].data, 'base64');
    assert.ok(inspectionBytes.byteLength <= 256 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(inspectedLarge)) < 400_000, 'Inspection payload must fit ordinary bounded conversation state');
    assert.match(inspectedLarge.output, /original 1600 × 1200 pixels.*resized\/compressed.*transparency flattened/s);
    assert.equal(createHash('sha256').update(await readFile(join(directory, 'outputs/large-input.png'))).digest('hex'), largeHash);
    const inspectionWrite = await sandbox.exec('python -c "import sys,base64,io; from PIL import Image; image=Image.open(io.BytesIO(base64.b64decode(sys.stdin.read()))); assert image.width <= 2048 and image.height <= 2048; assert image.format == \'JPEG\'; print(\'Bounded inspection verified\')"', { stdin: inspectedLarge.images![0].data });
    assert.equal(inspectionWrite.exitCode, 0, inspectionWrite.stderr);
    const renderedPdf = await tool('read', { path: '/workspace/outputs/page.png' });
    assert.equal(renderedPdf.images?.[0].mime, 'image/png');
    const fetch = await tool('bash', { command: 'curl --fail --location --max-time 15 https://example.com | head -c 200' });
    assert.equal(fetch.ok, true, fetch.error?.message);
    assert.match(fetch.output, /Example Domain|doctype/i);
    const noisy = await tool('bash', { command: 'python -c "print(\'x\' * 100000)"' });
    assert.equal(noisy.ok, true);
    assert.match(noisy.output, /truncated/);
    assert.ok(Buffer.byteLength(noisy.output) <= 8192);
    await tool('bash', { command: '(while true; do echo x >> /workspace/background.txt; sleep 0.1; done) >/dev/null 2>&1 & disown' });
    const stream: string[] = [];
    const pending = executeTool(sandbox, 'bash', '{"command":"echo started; sleep 60"}', { signal: abort.signal, maxOutputBytes: 8192, onOutput: (delta) => { stream.push(delta); if (delta.includes('started')) abort.abort(); } });
    assert.equal((await pending).error?.code, 'COMMAND_ABORTED');
    assert.ok(stream.join('').includes('started'));
    const before = await readFile(join(directory, 'background.txt'), 'utf8');
    await new Promise((fulfill) => setTimeout(fulfill, 400));
    assert.equal(await readFile(join(directory, 'background.txt'), 'utf8'), before, 'Detached writer must stop with the container');
    const secondAbort = new AbortController();
    const second = await manager.create('shared', secondAbort.signal);
    try {
      const persisted = await executeTool(second, 'read', '{"path":"/workspace/outputs/notes.txt"}', { signal: new AbortController().signal, maxOutputBytes: 8192 });
      assert.equal(persisted.output, 'alpha\ngamma\n');
      const timedOut = await executeTool(second, 'bash', '{"command":"sleep 60","timeoutMs":100}', { signal: secondAbort.signal, maxOutputBytes: 8192 });
      assert.equal(timedOut.error?.code, 'COMMAND_TIMEOUT');
      const stopped = await executeTool(second, 'bash', '{"command":"true"}', { signal: secondAbort.signal, maxOutputBytes: 8192 });
      assert.equal(stopped.error?.code, 'SANDBOX_STOPPED');
    } finally { await second.dispose(); }
  } finally {
    await sandbox.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
