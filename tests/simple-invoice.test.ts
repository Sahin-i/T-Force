import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
let python = process.env.WORKFLOW_TEST_PYTHON ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
try { await access(python); } catch { python = 'python3'; }
let pdfLibrary = false;
try { await execute(python, ['-c', 'import pypdf']); pdfLibrary = true; } catch {}

test('the simple invoice procedure has exactly four ordinary English instructions', async () => {
  const statements = (await readFile('catalog/simple-invoice/procedure.txt', 'utf8')).trim().split('\n');
  assert.deepEqual(statements, [
    'Compare the supplier invoice with the purchase order.',
    'Flag any difference in quantities, prices, or totals.',
    'Make a short review summary showing the amount and any issues.',
    'Ask me to approve matching invoices before adding them to the payment list.',
  ]);
  assert.ok(statements.every(statement => !/schema|script|Python|JSON|SQLite|template/.test(statement)));
});

test('the two starter PDFs agree, and the replacement differs in quantity and total', { skip: !pdfLibrary }, async () => {
  const files = ['invoice.pdf', 'purchase-order.pdf', 'mismatch/invoice.pdf'];
  const { stdout } = await execute(python, ['-c', `import json, sys\nfrom pypdf import PdfReader\nrows=[]\nfor name in sys.argv[1:]:\n r=PdfReader(name)\n rows.append({'pages':len(r.pages),'text':'\\n'.join(p.extract_text() or '' for p in r.pages)})\nprint(json.dumps(rows))`, ...files.map(file => path.resolve('catalog/simple-invoice', file))]);
  const documents = JSON.parse(stdout) as { pages: number; text: string }[];
  for (const document of documents) {
    assert.equal(document.pages, 1);
    assert.match(document.text, /Caspian Office Supplies/);
    assert.match(document.text, /Northstar Studio/);
    assert.match(document.text, /PO-2026-0188/);
    assert.match(document.text, /AX1800 dual-band Wi-Fi router/);
    assert.match(document.text, /AZN 70\.00/);
    assert.match(document.text, /Fictional sample/);
  }
  assert.match(documents[0].text, /INV-2026-1042/);
  assert.match(documents[0].text, /SKU: RTR-AX1800\s+8\s+AZN 70\.00\s+AZN 560\.00/);
  assert.match(documents[1].text, /SKU: RTR-AX1800\s+8\s+AZN 70\.00\s+AZN 560\.00/);
  assert.match(documents[2].text, /SKU: RTR-AX1800\s+10\s+AZN 70\.00\s+AZN 700\.00/);
  assert.ok(!documents[2].text.includes('AZN 560.00'));
});
