import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface SandboxOptions {
  workspaceDir: string;
  image: string;
  commandTimeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface DockerRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onOutput?: (delta: string) => void;
  stdin?: string;
}

/** Injection is for tests only; production always starts the Docker CLI. */
export type DockerRunner = (args: string[], options: DockerRunOptions) => Promise<CommandResult>;

export class SandboxError extends Error {
  constructor(public readonly code: string, message: string, public readonly partial?: CommandResult) {
    super(message);
    this.name = 'SandboxError';
  }
}

export const runDocker: DockerRunner = (args, options) => new Promise((fulfill, reject) => {
  if (options.signal?.aborted) {
    reject(new SandboxError('COMMAND_ABORTED', 'The operation was cancelled.'));
    return;
  }
  // Never use a host shell. Only Docker receives the shell command as an argument.
  const child = spawn('docker', args, { stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let captured = 0;
  let truncated = false;
  let settled = false;
  const result = (exitCode: number): CommandResult => ({
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    exitCode,
    truncated,
  });
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  };
  const fail = (code: string, message: string) => {
    if (settled) return;
    settled = true;
    cleanup();
    child.kill('SIGKILL');
    reject(new SandboxError(code, message, result(-1)));
  };
  const abort = () => fail('COMMAND_ABORTED', 'The operation was cancelled.');
  const timer = setTimeout(() => fail('COMMAND_TIMEOUT', `The command exceeded its ${options.timeoutMs} ms time limit.`), options.timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (settled) return;
    const remaining = Math.max(0, options.maxOutputBytes - captured);
    const kept = chunk.subarray(0, remaining);
    if (kept.byteLength < chunk.byteLength) truncated = true;
    captured += kept.byteLength;
    (stream === 'stdout' ? stdout : stderr).push(kept);
    if (kept.byteLength > 0) {
      const delta = decoders[stream].decode(kept, { stream: true });
      if (delta) options.onOutput?.(delta);
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
  child.stdin?.on('error', () => { /* Early container exit can close stdin. The exit status is returned below. */ });
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  child.once('error', (error) => fail('DOCKER_UNAVAILABLE', `Could not start Docker: ${error.message}`));
  child.once('close', (code) => {
    if (settled) return;
    settled = true;
    cleanup();
    for (const decoder of Object.values(decoders)) {
      const tail = decoder.decode();
      if (tail) options.onOutput?.(tail);
    }
    fulfill(result(code ?? 1));
  });
  // Cover cancellation between the initial check and listener registration.
  if (options.signal?.aborted) abort();
});

export interface ExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (delta: string) => void;
  /** Image transfer uses a separate, bounded budget; shell commands use the default. */
  maxOutputBytes?: number;
  stdin?: string;
}

/** Workflow authority remains on the host; only explicit asset directories are mounted. */
export interface SandboxLayout {
  mounts: { source: string; target: string; readOnly?: boolean }[];
  outputDir: string;
  scratchDir?: string;
  /** Application-owned workflow path constants, never credentials. */
  environment?: Record<string,string>;
}

export class Sandbox {
  private disposed = false;
  private disposal?: Promise<void>;
  private unwatchCancellation?: () => void;

  constructor(public readonly name: string, private readonly options: SandboxOptions, private readonly runner: DockerRunner = runDocker) {}

  watchCancellation(signal: AbortSignal): void {
    const abort = () => { void this.dispose().catch(() => { /* The owner awaits dispose and records cleanup failures. */ }); };
    signal.addEventListener('abort', abort, { once: true });
    this.unwatchCancellation = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }

  async exec(command: string, options: ExecOptions = {}): Promise<CommandResult> {
    if (this.disposed) throw new SandboxError('SANDBOX_STOPPED', 'The run container has already stopped. Start a new run.');
    if (options.signal?.aborted) {
      await this.dispose();
      throw new SandboxError('COMMAND_ABORTED', 'The operation was cancelled and its run container was removed.');
    }
    try {
      return await this.runner(['exec', ...(options.stdin === undefined ? [] : ['--interactive']), '--workdir', '/workspace', this.name, 'bash', '--noprofile', '--norc', '-c', command], {
        timeoutMs: Math.min(options.timeoutMs ?? this.options.commandTimeoutMs, this.options.commandTimeoutMs),
        maxOutputBytes: options.maxOutputBytes ?? this.options.maxOutputBytes,
        signal: options.signal,
        onOutput: options.onOutput,
        stdin: options.stdin,
      });
    } catch (error) {
      if (error instanceof SandboxError && (error.code === 'COMMAND_ABORTED' || error.code === 'COMMAND_TIMEOUT')) {
        // Killing docker exec alone would leave shell children in the container.
        try { await this.dispose(); } catch (cleanupError) {
          throw new SandboxError('SANDBOX_CLEANUP_FAILED', `${error.message} Container removal failed: ${errorMessage(cleanupError)}`, error.partial);
        }
        throw new SandboxError(error.code, `${error.message} The run container was removed, including background processes.`, error.partial);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unwatchCancellation?.();
    if (!this.disposal) {
      this.disposal = this.runner(['rm', '--force', this.name], { timeoutMs: 15_000, maxOutputBytes: 8_192 }).then((result) => {
        if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
          throw new SandboxError('SANDBOX_CLEANUP_FAILED', `Could not remove run container: ${result.stderr || result.stdout}`);
        }
      });
    }
    await this.disposal;
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class SandboxManager {
  private readonly workspaceDir: string;
  private readonly workspaceLabel: string;
  private readonly applicationLabel = 'office-agent.managed=true';

  constructor(private readonly options: SandboxOptions, private readonly runner: DockerRunner = runDocker) {
    this.workspaceDir = resolve(options.workspaceDir);
    this.workspaceLabel = `office-agent.workspace=${createHash('sha256').update(this.workspaceDir).digest('hex').slice(0, 20)}`;
    if (!Number.isSafeInteger(options.commandTimeoutMs) || options.commandTimeoutMs < 100 || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 256) {
      throw new Error('Sandbox commandTimeoutMs must be at least 100 and maxOutputBytes at least 256.');
    }
  }

  async readiness(): Promise<{ ready: boolean; error?: string }> {
    try {
      const info = await this.runner(['info', '--format', '{{json .ServerVersion}}'], { timeoutMs: 10_000, maxOutputBytes: 8_192 });
      if (info.exitCode !== 0) return { ready: false, error: `Docker is unavailable: ${info.stderr || info.stdout}` };
      const inspect = await this.runner(['image', 'inspect', this.options.image], { timeoutMs: 10_000, maxOutputBytes: 8_192 });
      if (inspect.exitCode !== 0) return { ready: false, error: `Sandbox image ${this.options.image} is unavailable. Run npm run sandbox:build. ${inspect.stderr}` };
      return { ready: true };
    } catch (error) { return { ready: false, error: errorMessage(error) }; }
  }

  async create(runId: string, signal: AbortSignal): Promise<Sandbox> {
    if (signal.aborted) throw new SandboxError('COMMAND_ABORTED', 'The run was cancelled before starting its container.');
    await mkdir(this.workspaceDir, { recursive: true });
    const workspace = await realpath(this.workspaceDir);
    const name = `office-agent-${runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28) || 'run'}-${randomUUID().slice(0, 12)}`.toLowerCase();
    const sandbox = new Sandbox(name, this.options, this.runner);
    const hostUid = process.getuid?.() ?? 1000;
    const hostGid = process.getgid?.() ?? 1000;
    const uid = hostUid === 0 ? 1000 : hostUid;
    const gid = hostUid === 0 ? 1000 : hostGid;
    try {
      const result = await this.runner([
        'run', '--detach', '--pull=never', '--name', name,
        '--label', this.applicationLabel, '--label', this.workspaceLabel,
        '--mount', `type=bind,source=${workspace},target=/workspace`,
        '--user', `${uid}:${gid}`, '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1',
        '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true',
        '--pids-limit', '128', '--memory', '1g', '--cpus', '1', '--init',
        '--workdir', '/workspace', this.options.image, 'sleep', 'infinity',
      ], { timeoutMs: 30_000, maxOutputBytes: 8_192, signal });
      if (result.exitCode !== 0) throw new SandboxError('SANDBOX_START_FAILED', `Could not create run container: ${result.stderr || result.stdout}`);
      if (signal.aborted) throw new SandboxError('COMMAND_ABORTED', 'The run was cancelled while starting its container.');
      sandbox.watchCancellation(signal);
      return sandbox;
    } catch (error) {
      // A cancelled docker run can still have created its container in the daemon.
      try { await sandbox.dispose(); } catch (cleanupError) {
        throw new SandboxError('SANDBOX_CLEANUP_FAILED', `${errorMessage(error)} Container removal also failed: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
  }

  async createIsolated(runId: string, signal: AbortSignal, layout: SandboxLayout): Promise<Sandbox> {
    if (signal.aborted) throw new SandboxError('COMMAND_ABORTED', 'The task was cancelled before starting its container.');
    const targets = new Set<string>();
    const mounts: string[] = [];
    const environment:string[]=[];
    for(const [key,value] of Object.entries(layout.environment??{})){
      if(!/^WORKFLOW_[A-Z_]+$/.test(key)||value.includes('\0'))throw new SandboxError('INVALID_ENVIRONMENT','Only application-owned workflow environment variables are accepted.');
      environment.push('--env',`${key}=${value}`);
    }
    for (const mount of layout.mounts) {
      if (!/^\/workspace\/(?:package|inputs|references|preceding)(?:\/[a-zA-Z0-9_.-]+)*$/.test(mount.target) || mount.target.split('/').includes('..') || targets.has(mount.target)) {
        throw new SandboxError('INVALID_MOUNT', 'Task assets must use unique package, inputs, references or preceding mounts.');
      }
      if (mount.readOnly === false) throw new SandboxError('INVALID_MOUNT', 'Task assets must be mounted read-only.');
      targets.add(mount.target);
      const source = await realpath(mount.source);
      if (source.includes(',')) throw new SandboxError('INVALID_MOUNT', 'Mount paths cannot contain commas.');
      mounts.push('--mount', `type=bind,source=${source},target=${mount.target},readonly`);
    }
    for (const [directory, target] of [[layout.outputDir, '/workspace/output'], [layout.scratchDir, '/workspace/scratch']] as const) {
      if (!directory) continue;
      await mkdir(directory, { recursive: true });
      const source = await realpath(directory);
      if (source.includes(',')) throw new SandboxError('INVALID_MOUNT', 'Mount paths cannot contain commas.');
      mounts.push('--mount', `type=bind,source=${source},target=${target}`);
    }
    const name = `office-agent-${runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28) || 'task'}-${randomUUID().slice(0, 12)}`.toLowerCase();
    const sandbox = new Sandbox(name, this.options, this.runner);
    const hostUid = process.getuid?.() ?? 1000;
    const uid = hostUid === 0 ? 1000 : hostUid;
    const gid = hostUid === 0 ? 1000 : (process.getgid?.() ?? 1000);
    try {
      const result = await this.runner([
        'run', '--detach', '--pull=never', '--name', name,
        '--label', this.applicationLabel, '--label', this.workspaceLabel,
        '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=128m,mode=1777', '--tmpfs', '/workspace:rw,size=64m,mode=0777',
        ...mounts, '--user', `${uid}:${gid}`, '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1', ...environment,
        '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '1g', '--cpus', '1', '--ulimit', 'fsize=26214400:26214400', '--init',
        '--workdir', '/workspace', this.options.image, 'sleep', 'infinity',
      ], { timeoutMs: 30_000, maxOutputBytes: 8_192, signal });
      if (result.exitCode !== 0) throw new SandboxError('SANDBOX_START_FAILED', `Could not create task container: ${result.stderr || result.stdout}`);
      if (signal.aborted) throw new SandboxError('COMMAND_ABORTED', 'The task was cancelled while starting its container.');
      sandbox.watchCancellation(signal);
      return sandbox;
    } catch (error) {
      try { await sandbox.dispose(); } catch (cleanupError) {
        throw new SandboxError('SANDBOX_CLEANUP_FAILED', `${errorMessage(error)} Container removal also failed: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
  }

  async cleanupStale(): Promise<void> {
    const result = await this.runner(['ps', '--all', '--quiet', '--filter', `label=${this.applicationLabel}`, '--filter', `label=${this.workspaceLabel}`], { timeoutMs: 10_000, maxOutputBytes: 65_536 });
    if (result.exitCode !== 0) throw new SandboxError('DOCKER_UNAVAILABLE', `Cannot inspect stale run containers: ${result.stderr || result.stdout}`);
    const ids = result.stdout.trim().split(/\s+/).filter((id) => /^[a-f0-9]{12,64}$/i.test(id));
    for (const id of ids) await new Sandbox(id, this.options, this.runner).dispose();
  }
}
