import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Sandbox, SandboxError, SandboxManager, type CommandResult, type DockerRunner } from '../server/sandbox.js';
import { executeTool, toolDefinitions } from '../server/tools.js';

const result = (stdout = '', exitCode = 0, stderr = '', truncated = false): CommandResult => ({ stdout, stderr, exitCode, truncated });
const defaults = { workspaceDir: '/tmp/office-agent-unit-tests', image: 'office-agent-sandbox:test', commandTimeoutMs: 1000, maxOutputBytes: 4096 };
const signal = () => new AbortController().signal;

test('exactly four strict function tools are registered', () => {
  assert.deepEqual(toolDefinitions.map((tool) => tool.name), ['read', 'write', 'edit', 'bash']);
  for (const tool of toolDefinitions) {
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters!.additionalProperties, false);
    assert.deepEqual(new Set(tool.parameters!.required as string[]), new Set(Object.keys(tool.parameters!.properties as object)));
  }
});

test('readiness requires both the Docker daemon and the prebuilt image', async () => {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => { calls.push(args); return args[0] === 'info' ? result('27.0') : result('', 1, 'No such image'); };
  const state = await new SandboxManager(defaults, runner).readiness();
  assert.equal(state.ready, false);
  assert.match(state.error!, /sandbox:build/);
  assert.equal(calls.length, 2);
  const unavailable = await new SandboxManager(defaults, async () => { throw new SandboxError('DOCKER_UNAVAILABLE', 'Docker is absent'); }).readiness();
  assert.deepEqual(unavailable, { ready: false, error: 'Docker is absent' });
});

test('container creation mounts only workspace and applies bounds without credentials', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'office-agent-sandbox-test-'));
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => { calls.push(args); return result('container-id'); };
  try {
    const manager = new SandboxManager({ ...defaults, workspaceDir: folder }, runner);
    const first = await manager.create('same/run', signal());
    const second = await manager.create('same/run', signal());
    assert.notEqual(first.name, second.name);
    const create = calls[0];
    assert.equal(create.filter((item) => item === '--mount').length, 1);
    assert.match(create[create.indexOf('--mount') + 1], /target=\/workspace$/);
    assert.ok(create.includes('--cap-drop=ALL'));
    assert.ok(create.includes('no-new-privileges:true'));
    for (const flag of ['--pids-limit', '--memory', '--cpus', '--user', '--init']) assert.ok(create.includes(flag));
    assert.ok(!create.some((item) => /docker\.sock|AZURE|\.env|agent-state/.test(item)));
    await first.dispose();
    await first.dispose();
    assert.equal(calls.filter((call) => call[0] === 'rm').length, 1);
    await second.dispose();
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('cancelled or timed-out commands dispose the entire container', async () => {
  for (const code of ['COMMAND_ABORTED', 'COMMAND_TIMEOUT']) {
    const calls: string[][] = [];
    const sandbox = new Sandbox('office-agent-test', defaults, async (args) => {
      calls.push(args);
      if (args[0] === 'exec') throw new SandboxError(code, 'Stopped', result('partial'));
      return result();
    });
    await assert.rejects(sandbox.exec('sleep 10', { signal: signal() }), (error: unknown) => error instanceof SandboxError && error.code === code && error.partial?.stdout === 'partial');
    assert.deepEqual(calls[1], ['rm', '--force', 'office-agent-test']);
    await assert.rejects(sandbox.exec('touch anything'), (error: unknown) => error instanceof SandboxError && error.code === 'SANDBOX_STOPPED');
  }
});

test('already cancelled container creation does not start a process', async () => {
  const abort = new AbortController(); abort.abort();
  let calls = 0;
  const manager = new SandboxManager(defaults, async () => { calls++; return result(); });
  await assert.rejects(manager.create('cancelled', abort.signal), (error: unknown) => error instanceof SandboxError && error.code === 'COMMAND_ABORTED');
  assert.equal(calls, 0);
});

test('run cancellation removes an idle container while the model is thinking', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'office-agent-cancel-test-'));
  const calls: string[][] = [];
  const abort = new AbortController();
  try {
    const manager = new SandboxManager({ ...defaults, workspaceDir: folder }, async (args) => { calls.push(args); return result(); });
    const sandbox = await manager.create('idle', abort.signal);
    abort.abort();
    await sandbox.dispose();
    assert.deepEqual(calls.map((args) => args[0]), ['run', 'rm']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('stale cleanup selects only this application workspace and ignores unexpected IDs', async () => {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => { calls.push(args); return args[0] === 'ps' ? result('aabbccddeeff\nnot-a-container\n') : result(); };
  await new SandboxManager(defaults, runner).cleanupStale();
  assert.ok(calls[0].includes('label=office-agent.managed=true'));
  assert.ok(calls[0].some((arg) => arg.startsWith('label=office-agent.workspace=')));
  assert.deepEqual(calls[1], ['rm', '--force', 'aabbccddeeff']);
  assert.equal(calls.length, 2);
});

test('malformed and unknown tool arguments never reach Docker', async () => {
  let calls = 0;
  const sandbox = new Sandbox('test', defaults, async () => { calls++; return result(); });
  for (const [name, args] of [['read', '{'], ['read', '{"path":"x","limit":0}'], ['write', '{"path":"x","content":3}'], ['edit', '{"path":"x","oldText":"","newText":"a"}'], ['bash', '{"command":"true","extra":true}'], ['delete', '{}']]) {
    const output = await executeTool(sandbox, name, args, { signal: signal(), maxOutputBytes: 4096 });
    assert.equal(output.ok, false);
    assert.match(output.error!.code, /INVALID_ARGUMENTS|UNKNOWN_TOOL/);
  }
  assert.equal(calls, 0);
});

test('writes pipe unmodified large content through Docker stdin', async () => {
  const content = "quotes ' \" $(touch /tmp/wrong) `uname`\n".repeat(10_000);
  let input: unknown;
  const sandbox = new Sandbox('test', defaults, async (args, options) => {
    assert.ok(args.includes('--interactive'));
    assert.equal(args.at(-1), 'python /opt/office-agent/tool-helper.py write');
    input = JSON.parse(options.stdin!);
    return result('{"ok":true,"output":"Wrote file."}');
  });
  const output = await executeTool(sandbox, 'write', JSON.stringify({ path: '/workspace/outputs/nested/file.txt', content }), { signal: signal(), maxOutputBytes: 4096 });
  assert.equal(output.ok, true);
  assert.deepEqual(input, { path: '/workspace/outputs/nested/file.txt', content, maxOutputBytes: 4096 });
});

test('structured file failures and image results are passed back to the model', async () => {
  const missing = { ok: false, output: '', error: { code: 'MATCH_NOT_FOUND', message: 'Read the file first.' } };
  const image = { ok: true, output: 'Image 2 × 2.', images: [{ mime: 'image/png', data: 'YWJj' }] };
  for (const response of [missing, image]) {
    const sandbox = new Sandbox('test', defaults, async (_args, options) => {
      assert.ok(options.maxOutputBytes >= 8 * 1024 * 1024);
      return result(JSON.stringify(response));
    });
    assert.deepEqual(await executeTool(sandbox, 'read', '{"path":"/workspace/test"}', { signal: signal(), maxOutputBytes: 4096 }), response);
  }
});

test('bash failures preserve output, stream hooks, timeout bounds and truncation', async () => {
  const deltas: string[] = [];
  const sandbox = new Sandbox('test', defaults, async (args, options) => {
    assert.equal(args[0], 'exec');
    assert.equal(args.at(-1), 'bad command');
    assert.equal(options.timeoutMs, defaults.commandTimeoutMs);
    assert.equal(options.maxOutputBytes, 1024);
    options.onOutput?.('progress');
    return result('out', 42, 'err', true);
  });
  const output = await executeTool(sandbox, 'bash', '{"command":"bad command","timeoutMs":600000}', { signal: signal(), maxOutputBytes: 1024, onOutput: (value) => deltas.push(value) });
  assert.equal(output.ok, false);
  assert.equal(output.error?.code, 'COMMAND_FAILED');
  assert.match(output.error!.message, /42.*truncated/);
  assert.equal(output.output, 'out\nerr');
  assert.deepEqual(deltas, ['progress']);
});

test('bash output and truncation notes stay within one combined byte budget', async () => {
  const sandbox = new Sandbox('test', defaults, async () => result('é'.repeat(256), 0, 'stderr', true));
  const output = await executeTool(sandbox, 'bash', '{"command":"noisy"}', { signal: signal(), maxOutputBytes: 256 });
  assert.ok(Buffer.byteLength(output.output) <= 256);
  assert.ok(!output.output.includes('\uFFFD'));
  assert.match(output.output, /truncated/);
});
