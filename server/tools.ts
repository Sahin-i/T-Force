import type { FunctionTool } from 'openai/resources/responses/responses.js';
import { z } from 'zod';
import { Sandbox, SandboxError } from './sandbox.js';

const pathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Paths cannot contain NUL.');
const schemas = {
  read: z.object({ path: pathSchema, offset: z.number().int().min(1).max(10_000_000).nullable().optional(), limit: z.number().int().min(1).max(2000).nullable().optional() }).strict(),
  write: z.object({ path: pathSchema, content: z.string().max(16 * 1024 * 1024) }).strict(),
  edit: z.object({ path: pathSchema, oldText: z.string().min(1).max(16 * 1024 * 1024), newText: z.string().max(16 * 1024 * 1024) }).strict(),
  bash: z.object({ command: z.string().min(1).max(256 * 1024), timeoutMs: z.number().int().min(100).max(600_000).nullable().optional() }).strict(),
};

export const toolDefinitions: FunctionTool[] = [
  { type: 'function', name: 'read', description: 'Read a UTF-8 text file or inspect a PNG/JPEG/WebP/GIF image inside /workspace. Text defaults to the first 200 lines; use offset and limit to page. Process DOCX, XLSX, PDF and SQLite with the installed Python libraries through bash.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'File path under /workspace.' }, offset: { type: ['integer', 'null'], minimum: 1, maximum: 10_000_000, description: 'One-based starting line, or null for 1.' }, limit: { type: ['integer', 'null'], minimum: 1, maximum: 2000, description: 'Maximum lines, or null for 200.' } }, required: ['path', 'offset', 'limit'] } },
  { type: 'function', name: 'write', description: 'Create or replace a UTF-8 file inside /workspace, creating parent directories. Files remain shared across chats.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { type: 'function', name: 'edit', description: 'Replace exactly one occurrence of oldText in a UTF-8 file inside /workspace. Missing or multiple matches return an error. Read the file first and include sufficient surrounding text.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] } },
  { type: 'function', name: 'bash', description: 'Execute a bash command in the run Docker container with /workspace as working directory. Node, Python, bash, ripgrep, curl and office libraries are installed. Outbound internet is available. Output and duration are bounded. Cancellation or timeout removes the run container, including background processes.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { command: { type: 'string', minLength: 1 }, timeoutMs: { type: ['integer', 'null'], minimum: 100, maximum: 600_000, description: 'Optional shorter command timeout in milliseconds; null uses the configured limit.' } }, required: ['command', 'timeoutMs'] } },
];

export interface ToolResult {
  ok: boolean;
  output: string;
  images?: { mime: string; data: string }[];
  error?: { code: string; message: string };
}

function failure(code: string, message: string, output = ''): ToolResult { return { ok: false, output, error: { code, message } }; }

function boundedOutput(value: string, maxBytes: number, suffix = ''): string {
  const source = Buffer.from(value);
  const tail = Buffer.from(suffix);
  if (!suffix && source.byteLength <= maxBytes) return value;
  let prefix = source.subarray(0, Math.max(0, maxBytes - tail.byteLength)).toString('utf8');
  // Buffer decoding can add a replacement character if the cut split UTF-8.
  if (prefix.endsWith('\uFFFD')) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

export async function executeTool(sandbox: Sandbox, name: string, argumentsJson: string, options: { signal: AbortSignal; maxOutputBytes: number; onOutput?: (delta: string) => void }): Promise<ToolResult> {
  if (!Object.hasOwn(schemas, name)) return failure('UNKNOWN_TOOL', `Unknown tool: ${name}. Available tools are read, write, edit and bash.`);
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsJson); } catch { return failure('INVALID_ARGUMENTS', 'Tool arguments must be one complete JSON object.'); }
  const validated = schemas[name as keyof typeof schemas].safeParse(parsed);
  if (!validated.success) return failure('INVALID_ARGUMENTS', validated.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
  if (options.signal.aborted) return failure('COMMAND_ABORTED', 'The run was cancelled.');
  try {
    if (name === 'bash') {
      const args = validated.data as z.infer<typeof schemas.bash>;
      const result = await sandbox.exec(args.command, { signal: options.signal, timeoutMs: args.timeoutMs ?? undefined, maxOutputBytes: options.maxOutputBytes, onOutput: options.onOutput });
      const output = boundedOutput([result.stdout, result.stderr].filter(Boolean).join('\n'), options.maxOutputBytes);
      if (result.exitCode !== 0) return failure('COMMAND_FAILED', `Command exited with status ${result.exitCode}.${result.truncated ? ' Output was truncated at the configured byte limit.' : ''}`, output);
      return { ok: true, output: boundedOutput(output, options.maxOutputBytes, result.truncated ? '\n[Output truncated at the configured byte limit.]' : '') };
    }
    const args = { ...validated.data, maxOutputBytes: options.maxOutputBytes };
    // Pipe complete JSON over stdin, avoiding shell interpolation and argv limits.
    const budget = name === 'read' ? Math.max(12 * 1024 * 1024, options.maxOutputBytes * 6 + 8192) : Math.max(65_536, options.maxOutputBytes);
    const result = await sandbox.exec(`python /opt/office-agent/tool-helper.py ${name}`, { signal: options.signal, maxOutputBytes: budget, stdin: JSON.stringify(args) });
    if (result.exitCode !== 0) return failure('FILE_OPERATION_FAILED', `File helper exited with status ${result.exitCode}: ${result.stderr}`, result.stdout);
    if (result.truncated) return failure('OUTPUT_TOO_LARGE', 'The file helper response exceeded the transfer limit. Use a smaller read or image.');
    let response: ToolResult & { truncated?: boolean; totalLines?: number; offset?: number };
    try { response = JSON.parse(result.stdout) as typeof response; } catch { return failure('FILE_OPERATION_FAILED', 'The container returned an invalid file-tool response.', result.stderr); }
    if (typeof response.ok !== 'boolean' || typeof response.output !== 'string') return failure('FILE_OPERATION_FAILED', 'The container returned an invalid file-tool result.');
    response.output = boundedOutput(response.output, options.maxOutputBytes, response.truncated ? `\n[Read truncated; file has ${response.totalLines} lines. Continue with a later offset or use bash.]` : '');
    return response;
  } catch (error) {
    if (error instanceof SandboxError) return failure(error.code, error.message, error.partial ? boundedOutput([error.partial.stdout, error.partial.stderr].filter(Boolean).join('\n'), options.maxOutputBytes) : '');
    return failure('TOOL_FAILED', error instanceof Error ? error.message : String(error));
  }
}
