import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerFileRoutes, validateAttachments } from '../server/files.js';
import { registerWorkflowExampleRoutes } from '../server/workflow-examples.js';
import type { Attachment } from '../shared/types.js';

test('the English starter has four statements and two normal, reusable uploaded documents', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'simple-workflow-'));
  const samples = path.join(root, 'samples');
  const workspace = path.join(root, 'workspace');
  const state = path.join(root, 'state');
  await mkdir(samples);
  const bytes = Buffer.from('%PDF-1.4\nSample document\n%%EOF');
  for (const name of ['invoice.pdf', 'purchase-order.pdf']) await writeFile(path.join(samples, name), bytes);
  const app = Fastify();
  await registerFileRoutes(app, workspace, state);
  registerWorkflowExampleRoutes(app, samples);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

  const examples = (await app.inject('/api/workflow-examples')).json();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].statements.length, 4);
  assert.deepEqual(examples[0].files.map((file: { name: string }) => file.name), ['invoice.pdf', 'purchase-order.pdf']);
  const uploaded = await app.inject({ method: 'POST', url: '/api/workflow-examples/invoice-check/files' });
  assert.equal(uploaded.statusCode, 200);
  const files = uploaded.json<{ files: Attachment[] }>().files;
  assert.equal(files.length, 2);
  assert.deepEqual(await validateAttachments(workspace, files, state), files);
  for (const file of files) assert.deepEqual(await readFile(path.join(workspace, file.path)), bytes);
  assert.equal((await app.inject('/api/workflow-examples/invoice-check/documents/invoice.pdf')).rawPayload.compare(bytes), 0);
  assert.equal((await app.inject('/api/workflow-examples/invoice-check/documents/private.json')).statusCode, 404);

  await rm(path.join(samples, 'invoice.pdf'));
  await symlink(path.join(samples, 'purchase-order.pdf'), path.join(samples, 'invoice.pdf'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/workflow-examples/invoice-check/files' })).statusCode, 400);
});
