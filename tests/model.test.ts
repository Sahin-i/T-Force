import OpenAI from 'openai';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Response, ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses.js';
import { config } from '../server/config.js';
import { AzureModelClient, azureBaseUrl, retryDelay } from '../server/model.js';
import { toolDefinitions } from '../server/tools.js';

const settings = { ...config, endpoint: 'https://example-resource.openai.azure.com/', apiKey: 'test-only-key', model: 'gpt-6-luna', modelRetries: 1 };
const completed = (status: 'completed' | 'incomplete' | 'failed' = 'completed'): Response => ({ id: 'resp_test', object: 'response', status, output: [], usage: null, error: status === 'failed' ? { code: 'server_error', message: 'Provider failed' } : null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null }) as unknown as Response;
type Create = (body: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<AsyncIterable<ResponseStreamEvent>>;
function mockModel(create: Create, overrides: Partial<typeof settings> = {}) {
  const model = new AzureModelClient({ ...settings, ...overrides });
  (model as unknown as { client: { responses: { create: unknown } } }).client.responses.create = (body: Record<string, unknown>, options: {signal?:AbortSignal}) => ({withResponse:async()=>({data:await create(body,options),response:{headers:new Headers()}})});
  return model;
}
async function* terminal(status: 'completed' | 'incomplete' | 'failed' = 'completed'): AsyncGenerator<ResponseStreamEvent> {
  yield { type: `response.${status}`, response: completed(status), sequence_number: 0 } as ResponseStreamEvent;
}

test('Azure v1 base URL is explicit and rejects insecure endpoints', () => {
  assert.equal(azureBaseUrl(settings.endpoint), 'https://example-resource.openai.azure.com/openai/v1/');
  assert.equal(azureBaseUrl(`${settings.endpoint}openai/deployments/legacy?api-version=old`), 'https://example-resource.openai.azure.com/openai/v1/');
  assert.throws(() => azureBaseUrl('http://example.com'), { code: 'AZURE_CONFIG' });
  assert.throws(() => azureBaseUrl(''), { code: 'AZURE_CONFIG' });
});

test('Responses request preserves canonical items and requests encrypted stateless reasoning', async () => {
  const input: ResponseInputItem[] = [
    { role: 'user', content: [{ type: 'input_text', text: 'Inspect a file.' }] },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-encrypted-provider-state' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"/workspace/input.txt","offset":null,"limit":null}', status: 'completed' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true,"output":"actual file"}' },
  ];
  let captured: Record<string, unknown> | undefined;
  const abort = new AbortController();
  const events: string[] = [];
  const model = mockModel(async (body, options) => { captured = body; assert.equal(options.signal, abort.signal); return terminal(); });
  const response = await model.respond(input, toolDefinitions, abort.signal, async (event) => { events.push(event.type); });
  assert.equal(response.status, 'completed');
  assert.equal(captured?.model, 'gpt-6-luna');
  assert.ok(String(captured?.instructions).includes(`/workspace/${settings.databasePath}`));
  assert.match(String(captured?.instructions),/mode=rw/);
  assert.equal(captured?.store, false);
  assert.equal(captured?.stream, true);
  assert.equal(captured?.parallel_tool_calls, false);
  assert.equal(captured?.truncation, 'disabled');
  assert.deepEqual(captured?.reasoning, { effort: 'medium' });
  assert.deepEqual(captured?.include, ['reasoning.encrypted_content']);
  assert.deepEqual(captured?.input, input);
  assert.equal((captured?.tools as unknown[]).length, 4);
  assert.deepEqual(events, ['response.completed']);
});

test('bounded retry retries only model request before any observed provider output', async () => {
  let calls = 0;
  const input: ResponseInputItem[] = [{ role: 'user', content: 'Continue.' }];
  const seen: unknown[] = [];
  const model = mockModel(async (body) => {
    seen.push(body.input);
    if (++calls === 1) throw Object.assign(new Error('Transient'), { status: 503 });
    return terminal();
  });
  assert.equal((await model.respond(input, toolDefinitions, new AbortController().signal, async () => {})).status, 'completed');
  assert.equal(calls, 2);
  assert.deepEqual(seen, [input, input]);
});

test('output observed before a transient stream failure prevents a retry', async () => {
  let calls = 0;
  const model = mockModel(async () => {
    calls++;
    return (async function* () {
      yield { type: 'response.output_text.delta', item_id: 'msg', output_index: 0, content_index: 0, delta: 'Partial text', logprobs: [], sequence_number: 1 } as ResponseStreamEvent;
      throw Object.assign(new Error('Broken connection after output'), { status: 503 });
    })();
  });
  const deltas: string[] = [];
  await assert.rejects(model.respond([], toolDefinitions, new AbortController().signal, async (event) => { if (event.type === 'response.output_text.delta') deltas.push(event.delta); }), /Broken connection after output/);
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ['Partial text']);
});

test('failed and incomplete provider terminal states remain explicit', async () => {
  for (const status of ['failed', 'incomplete'] as const) {
    const model = mockModel(async () => terminal(status));
    const response = await model.respond([], toolDefinitions, new AbortController().signal, async () => {});
    assert.equal(response.status, status);
    if (status === 'failed') assert.equal(response.error?.message, 'Provider failed');
    else assert.equal(response.incomplete_details?.reason, 'max_output_tokens');
  }
});

test('missing terminal response and nontransient failures surface clearly without retries', async () => {
  const noTerminal = mockModel(async () => (async function* () {})());
  await assert.rejects(noTerminal.respond([], toolDefinitions, new AbortController().signal, async () => {}), { code: 'MODEL_STREAM_INTERRUPTED' });
  let requests = 0;
  for (const [status, code] of [[401, 'AZURE_AUTH'], [404, 'MISSING_DEPLOYMENT'], [429, 'RATE_LIMIT']] as const) {
    const model = mockModel(async () => { requests++; throw Object.assign(new Error('Provider error'), { status }); }, { modelRetries: 0 });
    await assert.rejects(model.respond([], toolDefinitions, new AbortController().signal, async () => {}), { code });
  }
  assert.equal(requests, 3);
});

test('stop cancels a retry delay without another provider request', async () => {
  const abort = new AbortController();
  let calls = 0;
  const model = mockModel(async () => { calls++; throw Object.assign(new Error('Rate limit'), { status: 429 }); });
  const pending = model.respond([], toolDefinitions, abort.signal, async () => {});
  setTimeout(() => abort.abort(new Error('Stopped by user')), 15);
  await assert.rejects(pending, /Stopped by user/);
  assert.equal(calls, 1);
});

test('Azure streaming errors are rate-limit failures and provider delay is honored', async () => {
  assert.equal(retryDelay({status:429,headers:new Headers({'retry-after-ms':'70000','retry-after':'70'})},0),70250);
  assert.equal(retryDelay({status:429,headers:new Headers({'x-ratelimit-reset-requests':'118'})},0),118250);
  const model=mockModel(async()=> (async function*(){yield {type:'error',code:'rate_limit_exceeded',message:'Request rate limit reached',param:null,sequence_number:0} as ResponseStreamEvent;})(),{modelRetries:0});
  await assert.rejects(model.respond([],toolDefinitions,new AbortController().signal,async()=>{}),{code:'RATE_LIMIT'});
});

test('SDK rate-limit exception without HTTP status is normalized and remains bounded',async()=>{
 const model=mockModel(async()=>{throw Object.assign(new Error('Your requests have exceeded request rate limit.'),{code:'429'});},{modelRetries:0});
 await assert.rejects(model.respond([],toolDefinitions,new AbortController().signal,async()=>{}),{code:'RATE_LIMIT'});
});

test('successful responses pace the next call using Azure remaining-request/reset headers',async()=>{
 let requests=0;const settingsOverride={...settings,endpoint:'https://paced-example.openai.azure.com/'};
 const model=new AzureModelClient(settingsOverride);
 (model as unknown as {client:{responses:{create:unknown}}}).client.responses.create=()=>({withResponse:async()=>({data:terminal(),response:{headers:new Headers({'x-ratelimit-remaining-requests':'0','x-ratelimit-reset-requests':'0.001'})}})});
 await model.respond([],toolDefinitions,new AbortController().signal,async()=>{});
 const start=Date.now();let announced=0;
 await model.respond([],toolDefinitions,new AbortController().signal,async()=>{},async delay=>{announced=delay;requests++;});
 assert.equal(requests,1);assert.ok(announced>=200);assert.ok(Date.now()-start>=200);
});

test('actual SDK connection-timeout classes retry before output despite their Error name',async()=>{
 let calls=0;const model=mockModel(async()=>{if(++calls===1)throw new OpenAI.APIConnectionTimeoutError();return terminal();});
 await model.respond([],toolDefinitions,new AbortController().signal,async()=>{});assert.equal(calls,2);
 const failed=mockModel(async()=>{throw new OpenAI.APIConnectionTimeoutError();},{modelRetries:0});
 await assert.rejects(failed.respond([],toolDefinitions,new AbortController().signal,async()=>{}),{code:'MODEL_TIMEOUT'});
});
