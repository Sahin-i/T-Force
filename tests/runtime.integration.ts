import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Response, ResponseInputItem } from 'openai/resources/responses/responses';
import { AgentHarness } from '../server/agent.js';
import { config } from '../server/config.js';
import { HarnessError } from '../server/errors.js';
import type { ModelClient } from '../server/model.js';
import { runDocker, SandboxManager } from '../server/sandbox.js';
import { ConversationStore } from '../server/store.js';

const completed = (output: unknown[]): Response => ({ id: randomUUID(), object: 'response', status: 'completed', output, usage: null }) as unknown as Response;
const command = (id: string, text: string, timeoutMs: number | null = null) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'bash', arguments: JSON.stringify({ command: text, timeoutMs }), status: 'completed' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}
const pause = (duration: number) => new Promise(resolve => setTimeout(resolve, duration));

async function fixture(t: test.TestContext, model: ModelClient, overrides: Partial<typeof config> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'office-runtime-docker-'));
  const cfg = { ...config, workspaceDir: path.join(directory, 'workspace'), stateDir: path.join(directory, 'state'), maxRunMs: 20_000, ...overrides };
  await fs.mkdir(path.join(cfg.workspaceDir, 'outputs'), { recursive: true });
  const store = new ConversationStore(cfg.stateDir);
  await store.init();
  const sandboxes = new SandboxManager({ workspaceDir: cfg.workspaceDir, image: cfg.sandboxImage, commandTimeoutMs: 10_000, maxOutputBytes: 4096 });
  const readiness = await sandboxes.readiness();
  assert.equal(readiness.ready, true, readiness.error);
  const harness = new AgentHarness(cfg, store, sandboxes, () => model);
  t.after(async () => { await harness.shutdown(); await sandboxes.cleanupStale(); await fs.rm(directory, { recursive: true, force: true }); });
  return { cfg, harness, store, chat: await store.create() };
}

async function settled(harness: AgentHarness, store: ConversationStore, id: string) {
  for (let i = 0; i < 1000; i++) {
    if (!harness.activeRun) return store.getRun(id);
    await pause(10);
  }
  throw new Error('Docker harness did not finish');
}

async function assertContainerGone(name: string | undefined) {
  assert.ok(name, 'The harness must have created a real container');
  const inspected = await runDocker(['inspect', name], { timeoutMs: 10_000, maxOutputBytes: 4096 });
  assert.notEqual(inspected.exitCode, 0, 'Terminal runs must remove the container');
  assert.match(inspected.stderr, /no such/i);
}

async function assertWriterStopped(filename: string) {
  const before = await fs.readFile(filename, 'utf8');
  assert.ok(before.includes('tick'));
  await pause(450);
  assert.equal(await fs.readFile(filename, 'utf8'), before, 'Background writer continued after the run ended');
}

const writer = '(while true; do echo tick >> /workspace/outputs/background.txt; sleep 0.05; done) >/dev/null 2>&1 & disown; while [ ! -s /workspace/outputs/background.txt ]; do sleep 0.01; done; echo ready';

test('real Docker harness cancellation during model wait stops background writes and preserves tool results', { skip: process.env.RUN_DOCKER_TESTS !== '1', timeout: 30_000 }, async t => {
  const thinking = deferred();
  let requests = 0;
  const model: ModelClient = { respond: async (_input, _tools, signal) => {
    if (++requests === 1) return completed([command('writer', writer)]);
    thinking.resolve();
    return new Promise<Response>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); });
  } };
  const { cfg, harness, store, chat } = await fixture(t, model);
  const id = await harness.submit(chat.id, 'Start the fixture writer, then wait.', []);
  await thinking.promise;
  await assert.rejects(harness.submit(chat.id, 'Overlapping run', []), { code: 'BUSY' });
  await harness.abort(id);
  const run = store.getRun(id);
  assert.equal(run.status, 'stopped');
  assert.equal(run.tools[0].status, 'completed');
  assert.equal(requests, 2);
  await assertWriterStopped(path.join(cfg.workspaceDir, 'outputs/background.txt'));
  await assertContainerGone(run.containerName);
  const restored = new ConversationStore(cfg.stateDir);
  await restored.init();
  assert.equal(restored.getRun(id).status, 'stopped');
  assert.equal(restored.get(chat.id).input.filter(item => item.type === 'function_call_output').length, 1);
});

test('real Docker foreground cancellation removes foreground and detached processes together', { skip: process.env.RUN_DOCKER_TESTS !== '1', timeout: 30_000 }, async t => {
  const started = deferred();
  const { cfg, harness, store, chat } = await fixture(t, { respond: async () => completed([command('foreground', `${writer}; sleep 60`)]) });
  const id = await harness.submit(chat.id, 'Run a foreground command and detached writer.', []);
  const unsubscribe = store.subscribe(id, event => { if (event.type === 'tool_output' && String(event.data.delta).includes('ready')) started.resolve(); });
  t.after(unsubscribe);
  await started.promise;
  await harness.abort(id);
  const run = store.getRun(id);
  assert.equal(run.status, 'stopped');
  assert.equal(run.tools[0].status, 'uncertain');
  assert.match(JSON.stringify(store.get(chat.id).input.at(-1)), /INTERRUPTED/);
  await assertWriterStopped(path.join(cfg.workspaceDir, 'outputs/background.txt'));
  await assertContainerGone(run.containerName);
});

test('real Docker model failure never repeats a completed mutation and removes background workers', { skip: process.env.RUN_DOCKER_TESTS !== '1', timeout: 30_000 }, async t => {
  let requests = 0;
  let continuation: ResponseInputItem[] = [];
  const model: ModelClient = { respond: async input => {
    continuation = structuredClone(input);
    if (++requests === 1) return completed([command('mutation', `echo changed >> /workspace/outputs/mutation.txt; ${writer}`)]);
    throw new HarnessError('RATE_LIMIT', 'Controlled model failure after successful mutation.');
  } };
  const { cfg, harness, store, chat } = await fixture(t, model);
  const id = await harness.submit(chat.id, 'Execute the fixture mutation once.', []);
  const run = await settled(harness, store, id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error?.code, 'RATE_LIMIT');
  assert.equal(run.tools[0].status, 'completed');
  assert.equal(requests, 2);
  assert.equal(await fs.readFile(path.join(cfg.workspaceDir, 'outputs/mutation.txt'), 'utf8'), 'changed\n');
  assert.equal(continuation.filter(item => item.type === 'function_call_output' && item.call_id === 'mutation').length, 1);
  await assertWriterStopped(path.join(cfg.workspaceDir, 'outputs/background.txt'));
  await assertContainerGone(run.containerName);
});

test('real Docker tool timeout persists its failure and stops the detached writer', { skip: process.env.RUN_DOCKER_TESTS !== '1', timeout: 30_000 }, async t => {
  const { cfg, harness, store, chat } = await fixture(t, { respond: async () => completed([command('timeout', `${writer}; sleep 60`, 350)]) });
  const id = await harness.submit(chat.id, 'Exercise command timeout.', []);
  const run = await settled(harness, store, id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error?.code, 'COMMAND_TIMEOUT');
  assert.equal(run.tools[0].status, 'failed');
  assert.match(JSON.stringify(store.get(chat.id).input.at(-1)), /COMMAND_TIMEOUT/);
  await assertWriterStopped(path.join(cfg.workspaceDir, 'outputs/background.txt'));
  await assertContainerGone(run.containerName);
});

test('real Docker run duration limit cancels model wait and removes its detached writer', { skip: process.env.RUN_DOCKER_TESTS !== '1', timeout: 30_000 }, async t => {
  let requests = 0;
  let modelAborted = false;
  const model: ModelClient = { respond: async (_input, _tools, signal) => {
    if (++requests === 1) return completed([command('duration_writer', writer)]);
    return new Promise<Response>((_resolve, reject) => { signal.addEventListener('abort', () => { modelAborted = true; reject(signal.reason); }, { once: true }); if (signal.aborted) reject(signal.reason); });
  } };
  const { cfg, harness, store, chat } = await fixture(t, model, { maxRunMs: 2500 });
  const id = await harness.submit(chat.id, 'Exercise the complete run duration limit.', []);
  const run = await settled(harness, store, id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error?.code, 'RUN_DURATION_LIMIT');
  assert.equal(requests, 2);
  assert.equal(modelAborted, true);
  assert.equal(run.tools[0].status, 'completed');
  await assertWriterStopped(path.join(cfg.workspaceDir, 'outputs/background.txt'));
  await assertContainerGone(run.containerName);
});
