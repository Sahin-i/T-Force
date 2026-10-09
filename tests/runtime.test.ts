import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Response, ResponseInputItem } from 'openai/resources/responses/responses';
import { AgentHarness } from '../server/agent.js';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import type { ModelClient } from '../server/model.js';
import type { SandboxManager } from '../server/sandbox.js';
import { ConversationStore } from '../server/store.js';
import type { Run, RunEvent } from '../shared/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

const response = (output: unknown[]): Response => ({
  id: randomUUID(), object: 'response', status: 'completed', output, usage: null,
}) as unknown as Response;
const call = (id: string) => ({
  type: 'function_call', id: `fc_${id}`, call_id: id,
  name: 'bash', arguments: '{"command":"increment"}', status: 'completed',
});

async function setup(t: test.TestContext, model: ModelClient) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'office-runtime-'));
  const cfg = { ...config, workspaceDir: path.join(directory, 'workspace'), stateDir: path.join(directory, 'state') };
  const store = new ConversationStore(cfg.stateDir);
  let executions = 0;
  const sandbox = { name: 'runtime-fixture', dispose: async () => {}, exec: async () => { executions++; return { stdout: 'done', stderr: '', exitCode: 0, truncated: false }; } };
  const sandboxes = { readiness: async () => ({ ready: true }), create: async () => sandbox, cleanupStale: async () => {} } as unknown as SandboxManager;
  const harness = new AgentHarness(cfg, store, sandboxes, () => model);
  const { app } = await createApp(cfg, { store, sandboxes, harness, skipRecovery: true });
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, store, harness, cfg, executions: () => executions };
}

async function settled(harness: AgentHarness, store: ConversationStore, id: string) {
  for (let i = 0; i < 500; i++) {
    if (!harness.activeRun) return store.getRun(id);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture run did not finish');
}

test('SSE replay overlapping an event persistence flush sends each event once', { timeout: 5000 }, async t => {
  const { app, store } = await setup(t, { respond: async () => response([]) });
  const chat = await store.create();
  const run: Run = { id: randomUUID(), chatId: chat.id, messageId: randomUUID(), status: 'running', startedAt: new Date().toISOString(), model: 'fixture', tools: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  await store.addRun(run);
  const flushing = deferred<void>();
  const release = deferred<void>();
  const subscribed = deferred<void>();
  const originalSave = store.saveRun.bind(store);
  const originalSubscribe = store.subscribe.bind(store);
  let paused = false;
  store.saveRun = async value => {
    if (!paused && store.replay(run.id, 0).some(event => event.type === 'text')) {
      paused = true;
      flushing.resolve();
      await release.promise;
    }
    await originalSave(value);
  };
  store.subscribe = (id, listener) => { const unsubscribe = originalSubscribe(id, listener); subscribed.resolve(); return unsubscribe; };
  const emitting = store.emit(run.id, 'text', { delta: 'Hello' });
  await flushing.promise;
  const connection = app.inject(`/api/runs/${run.id}/events`);
  await subscribed.promise;
  release.resolve();
  await emitting;
  run.status = 'completed';
  await store.emit(run.id, 'status', { status: run.status });
  const result = await connection;
  const events = result.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as RunEvent);
  assert.deepEqual(events.map(event => event.id), [1, 2]);
  assert.equal(events.filter(event => event.type === 'text').length, 1);
});

test('a repeated completed provider call ID never executes a mutation again', async t => {
  let requests = 0;
  const { harness, store, cfg, executions } = await setup(t, { respond: async () => response(++requests <= 2 ? [call('once')] : []) });
  const chat = await store.create();
  const run = await settled(harness, store, await harness.submit(chat.id, 'Change the file once.', []));
  assert.equal(executions(), 1);
  assert.equal(run.status, 'failed');
  assert.equal(run.error?.code, 'DUPLICATE_TOOL_CALL');
  assert.equal(store.get(chat.id).input.filter(item => item.type === 'function_call_output' && item.call_id === 'once').length, 1);
  const restored = new ConversationStore(cfg.stateDir);
  await restored.init();
  assert.equal(restored.get(chat.id).responses.length, 2, 'Rejected provider responses must remain available for diagnosis');
  assert.equal(restored.get(chat.id).input.filter(item => item.type === 'function_call' && item.call_id === 'once').length, 1);
  assert.equal(restored.getRun(run.id).tools.length, 1);
});

test('duplicate provider call IDs in one response are rejected before any mutation', async t => {
  const { harness, store, executions } = await setup(t, { respond: async () => response([call('twice'), { ...call('twice'), id: 'other_provider_item' }]) });
  const chat = await store.create();
  const run = await settled(harness, store, await harness.submit(chat.id, 'Change the file once.', []));
  assert.equal(executions(), 0);
  assert.equal(run.status, 'failed');
  assert.equal(run.error?.code, 'DUPLICATE_TOOL_CALL');
  assert.equal(store.get(chat.id).input.filter(item => item.type === 'function_call').length, 0);
  assert.equal(store.get(chat.id).responses.length, 1);
  assert.equal(run.tools.length, 0);
});

test('previously interrupted provider call IDs cannot be reused to execute another action', async t => {
  const { harness, store, executions } = await setup(t, { respond: async () => response([call('interrupted')]) });
  const chat = await store.create();
  const conversation = store.get(chat.id);
  conversation.input.push(call('interrupted') as ResponseInputItem, { type: 'function_call_output', call_id: 'interrupted', output: '{"ok":false,"error":{"code":"INTERRUPTED"}}' });
  await store.save(conversation);
  const run = await settled(harness, store, await harness.submit(chat.id, 'Continue after an interruption.', []));
  assert.equal(executions(), 0);
  assert.equal(run.error?.code, 'DUPLICATE_TOOL_CALL');
  assert.equal(store.get(chat.id).input.filter(item => item.type === 'function_call_output').length, 1);
});

test('SSE replay already at a terminal event closes without replaying earlier text', async t => {
  const { app, store, harness } = await setup(t, { respond: async () => response([]) });
  const chat = await store.create();
  const run = await settled(harness, store, await harness.submit(chat.id, 'Complete the fixture.', []));
  const lastEventId = store.replay(run.id, 0).at(-1)!.id;
  for (const cursor of [lastEventId, lastEventId + 100]) {
    const result = await app.inject(`/api/runs/${run.id}/events?after=${cursor}`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, ': connected\n\n');
  }
});

test('an SSE cursor ahead of an active run still closes when its terminal event arrives', { timeout: 5000 }, async t => {
  const { app, store } = await setup(t, { respond: async () => response([]) });
  const chat = await store.create();
  const run: Run = { id: randomUUID(), chatId: chat.id, messageId: randomUUID(), status: 'running', startedAt: new Date().toISOString(), model: 'fixture', tools: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  await store.addRun(run);
  const subscribed = deferred<void>();
  const originalSubscribe = store.subscribe.bind(store);
  store.subscribe = (id, listener) => { const unsubscribe = originalSubscribe(id, listener); subscribed.resolve(); return unsubscribe; };
  const connection = app.inject(`/api/runs/${run.id}/events?after=1000`);
  await subscribed.promise;
  await store.emit(run.id, 'text', { delta: 'Filtered by the cursor.' });
  run.status = 'completed';
  await store.emit(run.id, 'status', { status: run.status });
  const result = await connection;
  assert.equal(result.body, ': connected\n\n');
});

test('provider calls without valid IDs fail before canonical append or execution', async t => {
  for (const invalidId of ['', '  ', null, 42]) {
    const { harness, store, executions } = await setup(t, { respond: async () => response([{ ...call('valid'), call_id: invalidId }]) });
    const chat = await store.create();
    const run = await settled(harness, store, await harness.submit(chat.id, 'Do the fixture action.', []));
    assert.equal(run.error?.code, 'MODEL_INVALID_TOOL_CALL');
    assert.equal(executions(), 0);
    assert.equal(run.tools.length, 0);
    assert.equal(store.get(chat.id).input.filter(item => item.type === 'function_call').length, 0);
    assert.equal(store.get(chat.id).responses.length, 1);
  }
});

test('restart recovery preserves completed mutations and fills only unfinished call results', async t => {
  const { store, cfg } = await setup(t, { respond: async () => response([]) });
  const chat = await store.create();
  const conversation = store.get(chat.id);
  conversation.input.push(call('completed') as ResponseInputItem, { type: 'function_call_output', call_id: 'completed', output: '{"ok":true,"output":"done"}' }, call('uncertain') as ResponseInputItem, call('pending') as ResponseInputItem);
  const run: Run = { id: randomUUID(), chatId: chat.id, messageId: randomUUID(), status: 'running', startedAt: new Date().toISOString(), model: 'fixture', tools: [
    { id: 'completed', name: 'bash', arguments: '{}', status: 'completed', output: 'done' },
    { id: 'uncertain', name: 'bash', arguments: '{}', status: 'running' },
    { id: 'pending', name: 'bash', arguments: '{}', status: 'pending' },
  ], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  conversation.chat.messages.push({ id: run.messageId, runId: run.id, role: 'assistant', text: 'Partial result', tools: run.tools, attachments: [], status: 'running', createdAt: run.startedAt });
  await store.save(conversation);
  await store.addRun(run);
  const restored = new ConversationStore(cfg.stateDir);
  await restored.init();
  assert.deepEqual(restored.getRun(run.id).tools.map(tool => tool.status), ['completed', 'uncertain', 'interrupted']);
  const outputs = restored.get(chat.id).input.filter(item => item.type === 'function_call_output');
  assert.equal(outputs.length, 3);
  assert.equal(outputs.filter(item => item.call_id === 'completed').length, 1);
  assert.equal(outputs[0].output, '{"ok":true,"output":"done"}');
  const second = new ConversationStore(cfg.stateDir);
  await second.init();
  assert.deepEqual(second.get(chat.id).input, restored.get(chat.id).input);
  assert.equal(second.replay(run.id, 0).length, 2, 'Repeated startup must not append another interruption');
});
