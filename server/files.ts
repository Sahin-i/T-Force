import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppError, Attachment, WorkspaceFile } from '../shared/types.js';

export const FILE_BYTES = 25 * 1024 * 1024;
export const UPLOAD_BYTES = 100 * 1024 * 1024;
const PREVIEW_BYTES = 64 * 1024;
const MAX_FILES = 128;
const MAX_LIST_FILES = 1000;
const MAX_LIST_ENTRIES = 5000;
const WORKSPACE_DIRS = ['uploads', 'outputs', 'scratch'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_NAMES = new Set(['.git', '.agent-state', '.codex', '.agents', '.aws']);
const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.log': 'text/plain', '.py': 'text/plain',
  '.js': 'text/plain', '.ts': 'text/plain', '.css': 'text/plain', '.sh': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.sqlite': 'application/vnd.sqlite3', '.db': 'application/octet-stream',
};
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf']);
const OFFICE_TYPES = new Set([MIME['.docx']!, MIME['.xlsx']!]);
const BINARY_TYPES = new Set([...INLINE_TYPES, 'application/zip', 'application/vnd.sqlite3',
  MIME['.docx']!, MIME['.xlsx']!, MIME['.pptx']!]);

export class FileServiceError extends Error implements AppError {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

function defaultStateDir(workspaceDir: string): string {
  return path.join(path.dirname(path.resolve(workspaceDir)), '.agent-state');
}

export function mimeFor(filename: string): string { return MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'; }

async function plainDirectory(directory: string, create = false): Promise<string> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new FileServiceError(400, 'UNSAFE_PATH', 'Workspace and application directories must be real directories.');
  }
  const canonical = await realpath(directory);
  if (canonical !== path.resolve(directory)) {
    // macOS /var and /tmp are system aliases; compare the parent separately instead of rejecting those aliases.
    const parent = await realpath(path.dirname(path.resolve(directory)));
    if (canonical !== path.join(parent, path.basename(directory))) {
      throw new FileServiceError(400, 'UNSAFE_PATH', 'Directory resolves through an unsafe symbolic link.');
    }
  }
  return canonical;
}

export async function ensureWorkspace(workspaceDir: string): Promise<void> {
  const root = await plainDirectory(path.resolve(workspaceDir), true);
  for (const name of WORKSPACE_DIRS) await plainDirectory(path.join(root, name), true);
}

function validatePath(relative: unknown): string {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\\') ||
      relative.includes('\0') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new FileServiceError(400, 'INVALID_PATH', 'Use a relative workspace file path.');
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || PRIVATE_NAMES.has(part) || part === '.env' || part.startsWith('.env.'))) {
    throw new FileServiceError(400, 'INVALID_PATH', 'File path must identify an ordinary file inside the workspace.');
  }
  return relative;
}

export async function safeFile(workspaceDir: string, relative: unknown): Promise<{ handle: FileHandle; size: number; relative: string }> {
  const checked = validatePath(relative);
  try {
    const root = await plainDirectory(path.resolve(workspaceDir));
    const parts = checked.split('/');
    let target = root;
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]!);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new FileServiceError(400, 'UNSAFE_PATH', 'Symbolic links are not served.');
      if (i < parts.length - 1 && !info.isDirectory()) throw new FileServiceError(404, 'FILE_NOT_FOUND', 'Workspace file was not found.');
      if (i === parts.length - 1 && !info.isFile()) throw new FileServiceError(400, 'INVALID_FILE', 'Path must identify a regular file.');
    }
    const resolved = await realpath(target);
    if (!resolved.startsWith(root + path.sep)) throw new FileServiceError(400, 'UNSAFE_PATH', 'File is outside the workspace.');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      throw new FileServiceError(400, 'INVALID_FILE', 'Path must identify a regular file.');
    }
    // Check again after opening: the shared workspace may change while a tool runs.
    try {
      let current = root;
      for (const component of parts) {
        current = path.join(current, component);
        if ((await lstat(current)).isSymbolicLink()) throw new FileServiceError(400, 'UNSAFE_PATH', 'Symbolic links are not served.');
      }
      const after = await lstat(target);
      if (!(await realpath(target)).startsWith(root + path.sep) || after.dev !== info.dev || after.ino !== info.ino) {
        throw new FileServiceError(400, 'UNSAFE_PATH', 'File changed while it was being opened. Retry the file operation.');
      }
    } catch (error) { await handle.close(); throw error; }
    return { handle, size: info.size, relative: checked };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new FileServiceError(404, 'FILE_NOT_FOUND', 'Workspace file was not found.');
    if (code === 'EACCES' || code === 'EPERM') throw new FileServiceError(403, 'FILE_UNREADABLE', 'Workspace file cannot be read.');
    if (code === 'ELOOP') throw new FileServiceError(400, 'UNSAFE_PATH', 'Symbolic links are not served.');
    throw error;
  }
}

export async function listWorkspaceFiles(workspaceDir: string): Promise<WorkspaceFile[]> {
  const root = await plainDirectory(path.resolve(workspaceDir));
  const files: WorkspaceFile[] = [];
  let visited = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 12 || files.length >= MAX_LIST_FILES || visited >= MAX_LIST_ENTRIES) return;
    const target = path.join(root, relative);
    try {
      const directory = await lstat(target);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return;
      const canonical = await realpath(target);
      if (canonical !== root && !canonical.startsWith(root + path.sep)) return;
      for await (const entry of await opendir(target)) {
        if (++visited > MAX_LIST_ENTRIES || files.length >= MAX_LIST_FILES) break;
        const child = relative ? relative + '/' + entry.name : entry.name;
        try { validatePath(child); } catch { continue; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(child, depth + 1); continue; }
        if (!entry.isFile()) continue;
        try {
          const file = await safeFile(root, child);
          const info = await file.handle.stat();
          await file.handle.close();
          files.push({ path: child, name: entry.name, size: info.size, mime: mimeFor(entry.name), modifiedAt: info.mtime.toISOString() });
        } catch { /* A tool may remove or replace files during listing; skip unreadable entries. */ }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  await walk('', 0);
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
}

interface UploadReceipt { requestId: string; attachment: Attachment }

async function receiptDirectories(workspaceDir: string, stateDir: string): Promise<{ receipts: string; completed: string; staging: string }> {
  const workspace = await plainDirectory(path.resolve(workspaceDir));
  const state = await plainDirectory(path.resolve(stateDir), true);
  if (state === workspace || state.startsWith(workspace + path.sep)) {
    throw new FileServiceError(500, 'INVALID_STORAGE', 'Application state must be outside the workspace.');
  }
  const receipts = await plainDirectory(path.join(state, 'upload-receipts'), true);
  const completed = await plainDirectory(path.join(receipts, 'completed'), true);
  const staging = await plainDirectory(path.join(state, 'upload-staging'), true);
  return { receipts, completed, staging };
}

async function readReceipt<T>(filename: string): Promise<T> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid upload receipt.');
    return JSON.parse(await handle.readFile('utf8')) as T;
  } finally { await handle.close(); }
}

function sameAttachment(a: Attachment, b: Attachment): boolean {
  return a.path === b.path && a.name === b.name && a.size === b.size && a.mime === b.mime;
}

export async function validateAttachments(workspaceDir: string, attachments: Attachment[], stateDir = defaultStateDir(workspaceDir)): Promise<Attachment[]> {
  if (!Array.isArray(attachments) || attachments.length > MAX_FILES) {
    throw new FileServiceError(400, 'INVALID_ATTACHMENT', 'Provide at most 128 completed uploaded-file references.');
  }
  if (attachments.length === 0) return [];
  const directories = await receiptDirectories(workspaceDir, stateDir);
  const seen = new Set<string>();
  const result: Attachment[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') throw new FileServiceError(400, 'INVALID_ATTACHMENT', 'Invalid uploaded-file reference.');
    const relative = validatePath(attachment.path);
    const parts = relative.split('/');
    if (parts.length !== 3 || parts[0] !== 'uploads' || !UUID.test(parts[1]!) || seen.has(relative)) {
      throw new FileServiceError(400, 'INVALID_ATTACHMENT', 'Attachment must be a unique completed upload.');
    }
    seen.add(relative);
    try {
      const receipt = await readReceipt<UploadReceipt>(path.join(directories.receipts, parts[1]! + '.json'));
      if (!UUID.test(receipt.requestId) || !sameAttachment(receipt.attachment, attachment)) throw new Error('Receipt does not match.');
      const completed = await readReceipt<Attachment[]>(path.join(directories.completed, receipt.requestId + '.json'));
      if (!Array.isArray(completed) || !completed.some(item => sameAttachment(item, receipt.attachment))) throw new Error('Upload is incomplete.');
      const file = await safeFile(workspaceDir, relative);
      const size = file.size;
      await file.handle.close();
      if (size !== receipt.attachment.size) throw new Error('Uploaded file changed size.');
      result.push({ ...receipt.attachment });
    } catch (error) {
      if (error instanceof FileServiceError && error.code === 'UNSAFE_PATH') throw error;
      throw new FileServiceError(400, 'INVALID_ATTACHMENT', 'Attachment upload is incomplete, missing, changed or invalid.');
    }
  }
  return result;
}

function filenameForUpload(name: string): string {
  if (!name || name === '.' || name === '..' || PRIVATE_NAMES.has(name) || name === '.env' || name.startsWith('.env.') ||
      /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 240) {
    throw new FileServiceError(400, 'INVALID_FILENAME', 'Uploaded filenames must be simple names of at most 240 UTF-8 bytes.');
  }
  return name;
}

function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof FileServiceError) { reply.code(error.statusCode).send({ code: error.code, message: error.message }); return; }
  const code = (error as { code?: string }).code;
  if (['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_PARTS_LIMIT', 'FST_FIELDS_LIMIT'].includes(code ?? '')) {
    reply.code(413).send({ code: 'UPLOAD_LIMIT', message: 'Uploads allow 25 MiB per file, 100 MiB total and at most 128 files.' });
    return;
  }
  if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || (error instanceof Error && /multipart|boundary|unexpected end|terminated early|premature close|malformed/i.test(error.message))) {
    reply.code(400).send({ code: 'INVALID_UPLOAD', message: 'Provide a complete multipart file upload.' }); return;
  }
  reply.log.error(error);
  reply.code(500).send({ code: 'FILE_ERROR', message: 'The file operation could not be completed.' });
}

function disposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function registerFileRoutes(app: FastifyInstance, workspaceDir: string, stateDir = defaultStateDir(workspaceDir)): Promise<void> {
  await ensureWorkspace(workspaceDir);
  const directories = await receiptDirectories(workspaceDir, stateDir);
  await app.register(multipart, { preservePath: true, limits: { fileSize: FILE_BYTES, files: MAX_FILES, fields: 0, parts: MAX_FILES }, throwFileSizeLimit: true });

  app.get('/api/files', async (_request, reply) => {
    try { return await listWorkspaceFiles(workspaceDir); } catch (error) { sendError(reply, error); }
  });

  app.post('/api/files/upload', async (request, reply) => {
    const requestId = randomUUID();
    const staged = path.join(directories.staging, requestId);
    const files: Attachment[] = [];
    const published: string[] = [];
    const receipts: string[] = [];
    const completed = path.join(directories.completed, requestId + '.json');
    let total = 0;
    let inspectChunk: ((chunk: Buffer) => void) | undefined;
    let inspectEnd: (() => void) | undefined;
    let inspectAbort: (() => void) | undefined;
    let activePart: Readable | undefined;
    try {
      await plainDirectory(directories.staging);
      await mkdir(staged, { mode: 0o700 });
      // Multipart treats a missing terminal boundary inconsistently across versions.
      // Verify the actual final boundary independently, before publishing receipts.
      const contentType = request.headers['content-type'] ?? '';
      const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
      if (!boundary) throw new FileServiceError(400, 'INVALID_UPLOAD', 'Provide a multipart upload with a boundary.');
      const finalBoundary = Buffer.from(`\r\n--${boundary[1] ?? boundary[2]}--`);
      let tail = Buffer.alloc(0);
      let finished = false;
      let failIncomplete!: (error: Error) => void;
      const incomplete = new Promise<never>((_resolve, reject) => { failIncomplete = reject; });
      void incomplete.catch(() => {});
      inspectChunk = chunk => {
        const combined = Buffer.concat([tail, chunk]);
        if (combined.includes(finalBoundary)) finished = true;
        tail = combined.subarray(Math.max(0, combined.length - finalBoundary.length));
      };
      inspectEnd = () => { if (!finished) failIncomplete(new FileServiceError(400, 'INVALID_UPLOAD', 'Multipart upload did not finish.')); };
      inspectAbort = () => failIncomplete(new FileServiceError(400, 'INVALID_UPLOAD', 'Multipart upload was interrupted.'));
      request.raw.on('data', inspectChunk);
      request.raw.once('end', inspectEnd);
      request.raw.once('aborted', inspectAbort);
      request.raw.once('error', inspectAbort);
      const parts = request.parts()[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([parts.next(), incomplete]);
        if (next.done) break;
        const part = next.value;
        if (part.type !== 'file') throw new FileServiceError(400, 'INVALID_UPLOAD', 'Only file parts are accepted.');
        activePart = part.file;
        const name = filenameForUpload(part.filename);
        const id = randomUUID();
        const directory = path.join(staged, id);
        await mkdir(directory, { mode: 0o700 });
        let size = 0;
        const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          total += chunk.length;
          if (size > FILE_BYTES || total > UPLOAD_BYTES) callback(new FileServiceError(413, 'UPLOAD_LIMIT', 'Upload exceeds the 25 MiB file or 100 MiB request limit.'));
          else callback(null, chunk);
        } });
        const output = createWriteStream(path.join(directory, name), { flags: 'wx', mode: 0o600 });
        const controller = new AbortController();
        const writing = pipeline(part.file, counter, output, { signal: controller.signal });
        try { await Promise.race([writing, incomplete]); }
        catch (error) { controller.abort(); part.file.destroy(); counter.destroy(); output.destroy(); await writing.catch(() => {}); throw error; }
        if (part.file.truncated) throw new FileServiceError(413, 'UPLOAD_LIMIT', 'A file exceeds the 25 MiB limit.');
        activePart = undefined;
        files.push({ path: `uploads/${id}/${name}`, name, size, mime: mimeFor(name) });
      }
      if (!finished) throw new FileServiceError(400, 'INVALID_UPLOAD', 'Multipart upload did not finish.');
      if (files.length === 0) throw new FileServiceError(400, 'INVALID_UPLOAD', 'Choose at least one file to upload.');
      const root = await plainDirectory(path.resolve(workspaceDir));
      const uploads = await plainDirectory(path.join(root, 'uploads'));
      for (const file of files) {
        const id = file.path.split('/')[1]!;
        await plainDirectory(uploads);
        const destination = path.join(uploads, id);
        await rename(path.join(staged, id), destination);
        published.push(destination);
        const receipt = path.join(directories.receipts, id + '.json');
        await writeFile(receipt, JSON.stringify({ requestId, attachment: file } satisfies UploadReceipt), { flag: 'wx', mode: 0o600 });
        receipts.push(receipt);
      }
      // This final marker makes the entire upload visible to message validation at once.
      const temporary = path.join(staged, 'completed.json');
      await writeFile(temporary, JSON.stringify(files), { flag: 'wx', mode: 0o600 });
      await plainDirectory(directories.completed);
      await rename(temporary, completed);
      return { files };
    } catch (error) {
      activePart?.destroy();
      request.raw.unpipe();
      request.raw.resume();
      await Promise.allSettled([...published.map(directory => rm(directory, { recursive: true, force: true })),
        ...receipts.map(receipt => rm(receipt, { force: true })), rm(completed, { force: true }), rm(staged, { recursive: true, force: true })]);
      sendError(reply, error);
    } finally {
      if (inspectChunk) request.raw.removeListener('data', inspectChunk);
      if (inspectEnd) request.raw.removeListener('end', inspectEnd);
      if (inspectAbort) { request.raw.removeListener('aborted', inspectAbort); request.raw.removeListener('error', inspectAbort); }
      await rm(staged, { recursive: true, force: true });
    }
  });

  app.get<{ Querystring: { path?: string } }>('/api/files/preview', async (request, reply) => {
    let handle: FileHandle | undefined;
    try {
      const file = await safeFile(workspaceDir, request.query.path);
      handle = file.handle;
      const mime = mimeFor(file.relative);
      if (OFFICE_TYPES.has(mime)) {
        if(file.size > FILE_BYTES) throw new FileServiceError(413, 'PREVIEW_LIMIT', 'Office previews support files up to 25 MiB. Download this file to open it.');
        return {kind: 'office', format: path.extname(file.relative).slice(1).toLowerCase(), mime, url: `/api/files/content?path=${encodeURIComponent(file.relative)}`};
      }
      if (BINARY_TYPES.has(mime)) throw new FileServiceError(415, 'BINARY_PREVIEW', 'This file cannot be previewed as text. Open its supported preview or download it.');
      const buffer = Buffer.alloc(Math.min(file.size, PREVIEW_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.some(value => value < 32 && ![9, 10, 13].includes(value))) throw new FileServiceError(415, 'BINARY_PREVIEW', 'Binary files cannot be previewed as text.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: file.size > bytesRead }); }
      catch { throw new FileServiceError(415, 'BINARY_PREVIEW', 'Text previews require UTF-8 encoded files.'); }
      return { kind: 'text', text, truncated: file.size > bytesRead, mime };
    } catch (error) { sendError(reply, error); }
    finally { await handle?.close(); }
  });

  for (const kind of ['content', 'download'] as const) {
    app.get<{ Querystring: { path?: string } }>(`/api/files/${kind}`, async (request, reply) => {
      let handle: FileHandle | undefined;
      try {
        const file = await safeFile(workspaceDir, request.query.path);
        handle = file.handle;
        const mime = mimeFor(file.relative);
        if (kind === 'content' && !INLINE_TYPES.has(mime) && !OFFICE_TYPES.has(mime)) throw new FileServiceError(415, 'UNSUPPORTED_PREVIEW', 'This format does not have an in-app preview. Download the file to open it.');
        if (kind === 'content' && OFFICE_TYPES.has(mime) && file.size > FILE_BYTES) throw new FileServiceError(413, 'PREVIEW_LIMIT', 'Office previews support files up to 25 MiB. Download this file to open it.');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
        reply.header('Cache-Control', 'no-store');
        reply.header('Content-Disposition', disposition(kind === 'content' && !OFFICE_TYPES.has(mime) ? 'inline' : 'attachment', path.basename(file.relative)));
        reply.header('Content-Length', file.size);
        reply.type(kind === 'content' ? mime : 'application/octet-stream');
        if (file.size === 0) { await handle.close(); handle = undefined; return reply.send(Buffer.alloc(0)); }
        const stream = handle.createReadStream({ start: 0, end: file.size - 1 });
        handle = undefined; // The stream now owns the descriptor and closes it on completion or disconnect.
        return reply.send(stream);
      } catch (error) { await handle?.close(); sendError(reply, error); }
    });
  }
}
