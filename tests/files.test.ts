import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Attachment } from '../shared/types.js';
import { FILE_BYTES, UPLOAD_BYTES, ensureWorkspace, listWorkspaceFiles, registerFileRoutes, validateAttachments } from '../server/files.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'office-files-'));
  const workspace = path.join(directory, 'workspace');
  const state = path.join(directory, 'private-state');
  const app = Fastify();
  await registerFileRoutes(app, workspace, state);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, workspace, state, app };
}

interface Upload { name: string; data?: string | Buffer; bytes?: number; mime?: string }
function body(files: Upload[], finish = true) {
  const boundary = 'office-agent-test-boundary';
  async function* chunks() {
    for (const file of files) {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.mime ?? 'application/octet-stream'}\r\n\r\n`);
      if (file.data !== undefined) yield Buffer.from(file.data);
      else {
        const chunk = Buffer.alloc(1024 * 1024, 65);
        let remaining = file.bytes ?? 0;
        while (remaining > 0) { yield chunk.subarray(0, Math.min(chunk.length, remaining)); remaining -= Math.min(chunk.length, remaining); }
      }
      yield Buffer.from('\r\n');
    }
    if (finish) yield Buffer.from(`--${boundary}--\r\n`);
  }
  return { payload: Readable.from(chunks()), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function fileUrl(route: string, file: string): string { return `/api/files/${route}?${new URLSearchParams({ path: file })}`; }

test('uploads preserve duplicate names, persist receipts outside the workspace and validate references', async t => {
  const { app, workspace, state } = await fixture(t);
  const response = await app.inject({ method: 'POST', url: '/api/files/upload', ...body([
    { name: 'report.csv', data: 'name,total\nA,12\n' }, { name: 'report.csv', data: 'name,total\nB,34\n' },
  ]) });
  assert.equal(response.statusCode, 200, response.body);
  const files = response.json<{ files: Attachment[] }>().files;
  assert.equal(files.length, 2);
  assert.notEqual(files[0]!.path, files[1]!.path);
  assert.match(files[0]!.path, /^uploads\/[0-9a-f-]{36}\/report\.csv$/);
  assert.equal(files[0]!.mime, 'text/csv');
  assert.equal(await readFile(path.join(workspace, files[0]!.path), 'utf8'), 'name,total\nA,12\n');
  assert.deepEqual(await validateAttachments(workspace, files, state), files);
  assert.equal((await listWorkspaceFiles(workspace)).length, 2);
  assert.equal((await readdir(path.join(state, 'upload-receipts', 'completed'))).length, 1);
  assert.deepEqual(await readdir(path.join(state, 'upload-staging')), []);
  await assert.rejects(validateAttachments(workspace, [{ ...files[0]!, size: 0 }], state), /invalid|changed/i);
  await assert.rejects(validateAttachments(workspace, [files[0]!, files[0]!], state), /unique/i);
  await assert.rejects(validateAttachments(workspace, files), /incomplete|invalid/i);
});

test('files cannot expose configuration, absolute paths, traversal or escaping symlinks', async t => {
  const { app, directory, workspace } = await fixture(t);
  await writeFile(path.join(directory, '.env'), 'SECRET=hidden');
  await writeFile(path.join(workspace, '.env'), 'ROOT_CONFIG=hidden');
  await writeFile(path.join(workspace, 'outputs', 'safe.txt'), 'safe output');
  await writeFile(path.join(workspace, 'example.txt'), 'root workspace file');
  await symlink(path.join(directory, '.env'), path.join(workspace, 'outputs', 'leak.txt'));
  await symlink(directory, path.join(workspace, 'scratch', 'outside'));
  for (const relative of ['../.env', '/etc/passwd', 'C:\\private\\file.txt', 'outputs/../.env', 'outputs//safe.txt', '.env', 'outputs/leak.txt', 'scratch/outside/.env']) {
    for (const route of ['preview', 'content', 'download']) {
      const response = await app.inject(fileUrl(route, relative));
      assert.equal(response.statusCode, 400, `${route}: ${relative}: ${response.body}`);
      assert.ok(response.json().code);
    }
  }
  const files = (await app.inject('/api/files')).json<Attachment[]>();
  assert.deepEqual(files.map(file => file.path).sort(), ['example.txt', 'outputs/safe.txt']);
  assert.equal((await app.inject(fileUrl('preview', 'example.txt'))).json().text, 'root workspace file');
  assert.equal((await app.inject(fileUrl('download', 'outputs/safe.txt'))).body, 'safe output');
  assert.equal((await app.inject(fileUrl('download', 'outputs/missing.txt'))).statusCode, 404);
});

test('text previews are bounded UTF-8 JSON and binary/active content cannot be served inline', async t => {
  const { app, workspace } = await fixture(t);
  await writeFile(path.join(workspace, 'outputs', 'large.txt'), 'a'.repeat(64 * 1024 - 1) + '€tail');
  await writeFile(path.join(workspace, 'outputs', 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(workspace, 'outputs', 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(workspace, 'outputs', 'active.svg'), '<svg onload="alert(1)"></svg>');
  await writeFile(path.join(workspace, 'outputs', 'page.html'), '<script>alert(1)</script>');
  await writeFile(path.join(workspace, 'outputs', 'plot.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const preview = (await app.inject(fileUrl('preview', 'outputs/large.txt'))).json();
  assert.equal(preview.kind, 'text');
  assert.equal(preview.truncated, true);
  assert.equal(preview.text, 'a'.repeat(64 * 1024 - 1));
  for (const name of ['binary.dat', 'invalid.txt', 'plot.png']) assert.equal((await app.inject(fileUrl('preview', `outputs/${name}`))).statusCode, 415);
  for (const name of ['active.svg', 'page.html']) assert.equal((await app.inject(fileUrl('content', `outputs/${name}`))).statusCode, 415);
  assert.equal((await app.inject(fileUrl('preview', 'outputs/page.html'))).json().text, '<script>alert(1)</script>');
  const image = await app.inject(fileUrl('content', 'outputs/plot.png'));
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.match(String(image.headers['content-disposition']), /^inline;/);
  const download = await app.inject(fileUrl('download', 'outputs/active.svg'));
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.match(String(download.headers['content-disposition']), /^attachment;/);
});

test('25 MiB is accepted, a larger file rejects the entire request and cleans all partial data', async t => {
  const { app, workspace, state } = await fixture(t);
  const accepted = await app.inject({ method: 'POST', url: '/api/files/upload', ...body([{ name: 'maximum.bin', bytes: FILE_BYTES }]) });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().files[0].size, FILE_BYTES);
  const failed = await app.inject({ method: 'POST', url: '/api/files/upload', ...body([
    { name: 'must-not-commit.txt', data: 'first part' }, { name: 'oversize.bin', bytes: FILE_BYTES + 1 },
  ]) });
  assert.equal(failed.statusCode, 413, failed.body);
  assert.deepEqual((await listWorkspaceFiles(workspace)).map(file => file.name), ['maximum.bin']);
  assert.deepEqual(await readdir(path.join(state, 'upload-staging')), []);
  assert.equal((await readdir(path.join(state, 'upload-receipts', 'completed'))).length, 1);
});

test('100 MiB applies to actual aggregate file bytes even without Content-Length', async t => {
  const { app, workspace, state } = await fixture(t);
  const files = Array.from({ length: UPLOAD_BYTES / FILE_BYTES }, (_, index) => ({ name: `part-${index}.bin`, bytes: FILE_BYTES }));
  files.push({ name: 'one-byte-too-many.bin', bytes: 1 });
  const response = await app.inject({ method: 'POST', url: '/api/files/upload', ...body(files) });
  assert.equal(response.statusCode, 413, response.body);
  assert.deepEqual(await listWorkspaceFiles(workspace), []);
  assert.deepEqual(await readdir(path.join(state, 'upload-staging')), []);
  assert.deepEqual(await readdir(path.join(state, 'upload-receipts', 'completed')), []);
});

test('incomplete requests and forged upload references never become message attachments', async t => {
  const { app, workspace, state } = await fixture(t);
  const response = await app.inject({ method: 'POST', url: '/api/files/upload', ...body([{ name: 'partial.txt', data: 'unfinished upload' }], false) });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(await listWorkspaceFiles(workspace), []);
  assert.deepEqual(await readdir(path.join(state, 'upload-staging')), []);
  const id = '00000000-0000-4000-8000-000000000000';
  await mkdir(path.join(workspace, 'uploads', id));
  await writeFile(path.join(workspace, 'uploads', id, 'forged.txt'), 'made by a tool');
  await assert.rejects(validateAttachments(workspace, [{ path: `uploads/${id}/forged.txt`, name: 'forged.txt', size: 14, mime: 'text/plain' }], state), /incomplete|invalid/i);
  const fake = { path: `uploads/${id}/forged.txt`, name: 'forged.txt', size: 14, mime: 'text/plain' };
  await writeFile(path.join(state, 'upload-receipts', `${id}.json`), JSON.stringify({ requestId: id, attachment: fake }));
  await assert.rejects(validateAttachments(workspace, [fake], state), /incomplete|invalid/i);
});

test('workspace/upload symbolic-link directories are rejected before writing', async t => {
  const { app, directory, workspace, state } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await rm(path.join(workspace, 'uploads'), { recursive: true });
  await symlink(outside, path.join(workspace, 'uploads'));
  await assert.rejects(ensureWorkspace(workspace), /real directories/i);
  const response = await app.inject({ method: 'POST', url: '/api/files/upload', ...body([{ name: 'cannot-escape.txt', data: 'private' }]) });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(path.join(state, 'upload-staging')), []);
  assert.deepEqual((await app.inject('/api/files')).json(), []);
});

test('uploaded filenames cannot contain host paths or reserved configuration names', async t => {
  const { app, workspace, state } = await fixture(t);
  for (const name of ['../escape.txt', '/tmp/escape.txt', 'C:\\private\\escape.txt', '.env', '.agent-state']) {
    const response = await app.inject({ method: 'POST', url: '/api/files/upload', ...body([{ name, data: 'unsafe name' }]) });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual(await listWorkspaceFiles(workspace), []);
  assert.deepEqual(await readdir(path.join(state, 'upload-staging')), []);
  const response = await app.inject({ method: 'POST', url: '/api/files/upload', ...body([{ name: 'hesabat-Əliyev.csv', data: 'total\n42' }]) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().files[0].name, 'hesabat-Əliyev.csv');
  const download = await app.inject(fileUrl('download', response.json().files[0].path));
  assert.match(String(download.headers['content-disposition']), /filename\*=UTF-8''hesabat-%C6%8Fliyev\.csv/);
});

test('workspace listings have a finite file count', async t => {
  const { workspace } = await fixture(t);
  await Promise.all(Array.from({ length: 1002 }, (_, index) => writeFile(path.join(workspace, 'outputs', `${index}.txt`), 'a')));
  assert.equal((await listWorkspaceFiles(workspace)).length, 1000);
});

test('office preview metadata and bounded binary delivery support DOCX and XLSX', async t => {
  const {app,workspace}=await fixture(t);
  for(const [name,mime] of [['essay.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],['totals.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]){
    const data=Buffer.from('PK-office-preview-test');
    await writeFile(path.join(workspace,'outputs',name!),data);
    const metadata=await app.inject(fileUrl('preview',`outputs/${name}`));assert.equal(metadata.statusCode,200);
    assert.equal(metadata.json().kind,'office');assert.equal(metadata.json().format,name!.split('.').at(-1));assert.equal(metadata.json().mime,mime);
    const content=await app.inject(metadata.json().url);assert.equal(content.statusCode,200);assert.deepEqual(content.rawPayload,data);
    assert.equal(content.headers['content-type'],mime);assert.match(String(content.headers['content-disposition']),/^attachment;/);assert.equal(content.headers['x-content-type-options'],'nosniff');
  }
});
test('oversized office previews fail explicitly while downloads remain available', async t=>{
  const {app,workspace}=await fixture(t);const file=path.join(workspace,'outputs','large.docx');
  const {open}=await import('node:fs/promises');const handle=await open(file,'w');await handle.truncate(FILE_BYTES+1);await handle.close();
  for(const endpoint of ['content','preview']){const r=await app.inject(fileUrl(endpoint,'outputs/large.docx'));assert.equal(r.statusCode,413);assert.equal(r.json().code,'PREVIEW_LIMIT');}
});
