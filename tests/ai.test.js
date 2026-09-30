// AI providers against a local mock server speaking the Ollama and
// OpenAI-compatible protocols; structured output validation; the
// assistant's tool loop and permission gates.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OllamaProvider } = require('../src/main/ai/ollama-provider.cjs');
const { OpenAICompatibleProvider } = require('../src/main/ai/openai-compatible-provider.cjs');
const { OpenAIProvider } = require('../src/main/ai/openai-provider.cjs');
const { ProviderManager } = require('../src/main/ai/provider-manager.cjs');
const { structured } = require('../src/main/ai/structured.cjs');
const { Assistant } = require('../src/main/ai/assistant.cjs');
const { isLocalUrl } = require('../src/main/ai/provider.cjs');

let server;
let base;
let shared;
const requests = [];
// Replies queued per test: functions (body, res) => void.
const queue = [];

before(async () => {
  shared = await require('../src/main/shared.cjs').loadShared();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      if (req.url === '/api/tags') return json(res, { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 1 }] });
      if (req.url === '/v1/models') return json(res, { data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'text-embedding-3-small' }] });
      const next = queue.shift();
      if (!next) return json(res, { error: 'no reply queued' }, 500);
      next(parsed, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// One NDJSON line. Built by concatenation: CodeQL's extractor fails to parse
// deeply nested object literals inside a template substitution.
const ndjson = (obj) => JSON.stringify(obj) + '\n';

const ollamaReply = (message) => (_b, res) => json(res, { model: 'qwen3:8b', message: { role: 'assistant', ...message }, done: true, prompt_eval_count: 5, eval_count: 7 });
const openaiReply = (message) => (_b, res) => json(res, { model: 'a-model', choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });

test('ollama: lists models and chats', async () => {
  const p = new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: base });
  assert.deepEqual((await p.listModels()).map((m) => m.id), ['qwen3:8b']);
  queue.push(ollamaReply({ content: 'hello' }));
  const r = await p.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }], temperature: 0.1 });
  assert.equal(r.content, 'hello');
  assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 7 });
  const sent = requests.at(-1).body;
  assert.equal(sent.stream, false);
  assert.equal(sent.options.temperature, 0.1);
});

test('ollama: streams NDJSON tokens and tool calls', async () => {
  const p = new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: base });
  queue.push((_b, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(ndjson({ message: { content: 'Hel' } }));
    res.write(ndjson({ message: { content: 'lo', tool_calls: [{ function: { name: 'get_table', arguments: { name: 'x' } } }] } }));
    res.end(ndjson({ message: { content: '' }, done: true, eval_count: 2 }));
  });
  const tokens = [];
  const r = await p.stream({ model: 'm', messages: [], tools: [{ name: 'get_table', description: 'd', parameters: {} }] }, (t) => tokens.push(t));
  assert.deepEqual(tokens, ['Hel', 'lo']);
  assert.equal(r.content, 'Hello');
  assert.equal(r.toolCalls[0].name, 'get_table');
  assert.deepEqual(r.toolCalls[0].arguments, { name: 'x' });
  assert.equal(requests.at(-1).body.tools[0].function.name, 'get_table');
});

test('ollama: structured output uses the format field', async () => {
  const p = new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: base });
  queue.push(ollamaReply({ content: '{"a":1}' }));
  await p.chat({ model: 'm', messages: [], json: { schema: { type: 'object' } } });
  assert.deepEqual(requests.at(-1).body.format, { type: 'object' });
});

test('openai-compatible: models, auth header, tool messages', async () => {
  const p = new OpenAICompatibleProvider({ id: 'v', type: 'openai-compatible', baseUrl: `${base}/v1` }, { apiKey: 'sk-test' });
  assert.deepEqual((await p.listModels()).map((m) => m.id), ['a-model', 'b-model', 'text-embedding-3-small']);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer sk-test');
  queue.push(openaiReply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_schema', arguments: '{}' } }] }));
  const r = await p.chat({
    model: 'a-model',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'get_table', arguments: { name: 't' } }] },
      { role: 'tool', toolCallId: 'c0', content: 'result' },
    ],
    json: { name: 'x', schema: { type: 'object' } },
  });
  assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'get_schema', arguments: {} }]);
  const sent = requests.at(-1).body;
  assert.equal(sent.messages[1].tool_calls[0].function.arguments, '{"name":"t"}');
  assert.equal(sent.messages[2].tool_call_id, 'c0');
  assert.equal(sent.response_format.type, 'json_schema');
});

test('openai-compatible: streams server-sent events with tool call deltas', async () => {
  const p = new OpenAICompatibleProvider({ id: 'v', type: 'openai-compatible', baseUrl: `${base}/v1` });
  queue.push((_b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    ev({ choices: [{ delta: { content: 'A' } }] });
    ev({ choices: [{ delta: { content: 'B' } }] });
    ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x1', function: { name: 'get_', arguments: '{"na' } }] } }] });
    ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'table', arguments: 'me":"t"}' } }] } }] });
    ev({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    res.end('data: [DONE]\n\n');
  });
  const tokens = [];
  const r = await p.chat({ model: 'm', messages: [] }, { onToken: (t) => tokens.push(t) });
  assert.equal(tokens.join(''), 'AB');
  assert.deepEqual(r.toolCalls, [{ id: 'x1', name: 'get_table', arguments: { name: 't' } }]);
  assert.deepEqual(r.usage, { inputTokens: 1, outputTokens: 2 });
});

test('provider errors carry the server message', async () => {
  const p = new OpenAICompatibleProvider({ id: 'v', type: 'openai-compatible', baseUrl: `${base}/v1` });
  queue.push((_b, res) => json(res, { error: { message: 'model not found' } }, 404));
  await assert.rejects(p.chat({ model: 'zzz', messages: [] }), /404.*model not found/);
  const dead = new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(dead.listModels(), /Could not reach/);
});

test('openai provider requires a key and hides non-chat models', async () => {
  const noKey = new OpenAIProvider({ id: 'oa', type: 'openai', baseUrl: `${base}/v1` });
  await assert.rejects(noKey.listModels(), /API key/);
  const p = new OpenAIProvider({ id: 'oa', type: 'openai', baseUrl: `${base}/v1` }, { apiKey: 'k' });
  assert.deepEqual((await p.listModels()).map((m) => m.id), ['a-model', 'b-model']);
  assert.equal(p.isLocal, true);
  assert.equal(new OpenAIProvider({ id: 'oa', type: 'openai' }).isLocal, false);
});

test('local URL detection', () => {
  assert.ok(isLocalUrl('http://localhost:11434'));
  assert.ok(isLocalUrl('http://192.168.1.50:8000/v1'));
  assert.ok(isLocalUrl('http://10.0.0.2'));
  assert.ok(!isLocalUrl('https://api.openai.com/v1'));
  assert.ok(!isLocalUrl('http://172.32.0.1'));
});

test('provider manager keeps keys out of the config and the renderer view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgerd-ai-'));
  const crypto = {
    available: () => true,
    encrypt: (t) => Buffer.from(`enc:${t}`),
    decrypt: (b) => b.toString().replace(/^enc:/, ''),
  };
  const m = new ProviderManager({ dir, crypto, env: {} });
  assert.deepEqual(m.list().providers.map((p) => p.id), ['local-ollama', 'local-vllm', 'openai']);
  const id = m.upsert({ name: 'Lab vLLM', type: 'openai-compatible', baseUrl: 'http://192.168.1.50:8000/v1' }, 'secret-key');
  assert.equal(id, 'lab-vllm');
  const config = fs.readFileSync(path.join(dir, 'ai-providers.json'), 'utf8');
  assert.ok(!config.includes('secret-key'));
  assert.ok(!fs.readFileSync(path.join(dir, 'ai-keys.json'), 'utf8').includes('secret-key'));
  const view = m.list().providers.find((p) => p.id === id);
  assert.equal(view.hasKey, true);
  assert.equal(view.local, true);
  assert.ok(!JSON.stringify(m.list()).includes('secret-key'));
  assert.equal(new ProviderManager({ dir, crypto }).get(id).apiKey, 'secret-key');
  // Without secure storage keys stay in memory only.
  const insecure = new ProviderManager({ dir, crypto: { available: () => false }, env: {} });
  insecure.setKey('openai', 'k2');
  assert.equal(insecure.getKey('openai'), 'k2');
  assert.ok(!fs.readFileSync(path.join(dir, 'ai-keys.json'), 'utf8').includes('k2'));
  assert.equal(new ProviderManager({ dir, crypto: null, env: { OPENAI_API_KEY: 'env' } }).getKey('openai'), 'env');
  m.remove(id);
  assert.ok(!m.list().providers.some((p) => p.id === id));
});

// A minimal schema for structured / assistant tests.
function schema() {
  return shared.schemaFromCatalog({
    tables: [
      { oid: 1, schema: 'public', name: 'area', description: 'Departments' },
      { oid: 2, schema: 'public', name: 'employee', description: null },
    ],
    columns: [
      { oid: 1, attnum: 1, name: 'id', type: 'integer', notnull: true, default: "nextval('area_id_seq'::regclass)", serial: true },
      { oid: 1, attnum: 2, name: 'name', type: 'character varying(20)', notnull: true },
      { oid: 2, attnum: 1, name: 'id', type: 'bigint', notnull: true, identity: 'a' },
      { oid: 2, attnum: 2, name: 'full_name', type: 'text', notnull: true },
      { oid: 2, attnum: 3, name: 'area_id', type: 'integer', notnull: true },
      { oid: 2, attnum: 4, name: 'active', type: 'boolean', notnull: true, default: 'true' },
    ],
    constraints: [
      { oid: 1, name: 'area_pkey', type: 'p', cols: [1] },
      { oid: 2, name: 'employee_pkey', type: 'p', cols: [1] },
      { oid: 2, name: 'employee_area_fkey', type: 'f', cols: [3], ref_oid: 1, ref_cols: [1], confupdtype: 'a', confdeltype: 'r' },
    ],
    checks: [{ oid: 2, name: 'name_len', definition: 'CHECK (length(full_name) > 1)' }],
  });
}

test('structured output: validated against the table, with retries', async () => {
  const p = new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: base });
  queue.push(ollamaReply({ content: 'Sure! {"full_name": 12}' }));
  queue.push(ollamaReply({ content: '```json\n{"full_name": "Ana López", "active": true}\n```' }));
  const r = await structured({ provider: p, model: 'm', shared, schema: schema(), table: 'employee', prompt: 'an employee' });
  assert.deepEqual(r.value, { full_name: 'Ana López', active: true });
  assert.equal(r.attempts, 2);
  const retry = requests.at(-1).body.messages.at(-1).content;
  assert.match(retry, /full_name: expected string, got integer/);
  // The table's schema leaves out the identity and foreign key columns.
  assert.deepEqual(Object.keys(requests.at(-1).body.format.properties), ['full_name', 'active']);
});

test('structured output gives up with the validation errors', async () => {
  const p = new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: base });
  for (let i = 0; i < 2; i++) queue.push(ollamaReply({ content: 'not json' }));
  await assert.rejects(
    structured({ provider: p, model: 'm', shared, schema: schema(), jsonSchema: { type: 'object' }, prompt: 'x', retries: 1 }),
    /did not return valid data after 2 attempts/
  );
});

function assistant({ connected = false, rows = [] } = {}) {
  const log = [];
  const providers = {
    get: (id) =>
      id === 'remote'
        ? new OpenAICompatibleProvider({ id: 'remote', type: 'openai-compatible', baseUrl: 'https://llm.example.com/v1' })
        : new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: base }),
  };
  const services = {
    schemaFor: async () => schema(),
    connected: () => connected,
    readOnly: async (_w, fn) => fn({ query: async (sql) => ({ rows, sql }) }),
    checkScript: () => [],
    listScripts: async () => [],
    runSaved: async () => ({ status: 'rolled back', rowsRead: 0, inserts: 0, updates: 0, deletes: 0, validations: [], messages: [] }),
  };
  return { a: new Assistant({ shared, providers, services, audit: { log: (e, d) => log.push({ e, ...d }) } }), log };
}

test('assistant: context, tool loop and proposals', async () => {
  const { a, log } = assistant();
  queue.push(ollamaReply({ content: '', tool_calls: [{ function: { name: 'get_table', arguments: { name: 'area' } } }] }));
  queue.push(ollamaReply({ content: '', tool_calls: [{ function: { name: 'create_script', arguments: { name: 'Areas check', type: 'validator', source: 'validate("x", async () => {});' } } }] }));
  queue.push(ollamaReply({ content: 'Done: I proposed a validator.' }));
  const events = [];
  const r = await a.chat(1, { requestId: 'q1', providerId: 'o', model: 'm', prompt: 'Check employee rows', useTools: true, permissions: {} }, (e) => events.push(e));
  assert.equal(r.content, 'Done: I proposed a validator.');
  const first = requests.at(-3).body;
  assert.match(first.messages[0].content, /TABLE public\.employee/);
  assert.match(first.messages[0].content, /TABLE public\.area -- Departments/); // related table
  // Default permissions: no row or query tools.
  const toolNames = first.tools.map((t) => t.function.name);
  assert.ok(toolNames.includes('get_table') && toolNames.includes('create_script'));
  assert.ok(!toolNames.includes('run_readonly_query') && !toolNames.includes('get_sample_rows'));
  assert.match(requests.at(-2).body.messages.at(-1).content, /TABLE public\.area/);
  const proposal = events.find((e) => e.type === 'proposal').proposal;
  assert.equal(proposal.action, 'create');
  assert.equal(proposal.type, 'validator');
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.name), ['get_table', 'create_script']);
  assert.equal(log.at(-1).e, 'ai-query');
  assert.equal(log.at(-1).rowData, false);
});

test('assistant: retries without tools when the model has none', async () => {
  const { a } = assistant();
  queue.push((_b, res) => json(res, { error: 'registry.ollama.ai/library/m does not support tools' }, 400));
  queue.push(ollamaReply({ content: 'plain answer' }));
  const events = [];
  const r = await a.chat(2, { requestId: 'q2', providerId: 'o', model: 'm', prompt: 'hi', useTools: true }, (e) => events.push(e));
  assert.equal(r.content, 'plain answer');
  assert.ok(events.some((e) => e.type === 'notice'));
  assert.equal(requests.at(-1).body.tools, undefined);
});

test('assistant: row data needs permission, a connection and consent for remote providers', async () => {
  const { a } = assistant({ connected: true, rows: [{ id: 1, name: 'Finance' }] });
  const req = { requestId: 'q3', providerId: 'remote', model: 'm', prompt: 'area', contextOptions: { rowSamples: true } };
  await assert.rejects(a.chat(3, req, () => {}), /Read rows/);
  await assert.rejects(a.chat(3, { ...req, permissions: { readData: true } }, () => {}), /remote provider/);
  const { a: local, log } = assistant({ connected: true, rows: [{ id: 1, name: 'Finance' }] });
  queue.push(ollamaReply({ content: 'ok' }));
  await local.chat(4, { ...req, providerId: 'o', permissions: { readData: true } }, () => {});
  assert.match(requests.at(-1).body.messages[0].content, /SAMPLE ROWS[\s\S]*Finance/);
  assert.equal(log.at(-1).e, 'ai-query-with-row-data');
});

test('assistant: tools refuse writes', async () => {
  const { executeTool } = require('../src/main/ai/ai-tools.cjs');
  const ctx = { windowId: 1, shared, schema: schema(), permissions: shared.normalizeAiPermissions({ executeSelect: true, readData: true, executeWrites: true }), connected: true, rowsAllowed: true, services: { readOnly: async () => [] }, emit: () => {} };
  assert.equal(ctx.permissions.executeWrites, false);
  assert.match(await executeTool(ctx, 'run_readonly_query', { sql: 'DELETE FROM area' }), /Refused/);
  assert.match(await executeTool(ctx, 'run_readonly_query', { sql: 'SELECT 1; SELECT 2' }), /Refused/);
  await assert.rejects(executeTool({ ...ctx, permissions: shared.normalizeAiPermissions({}) }, 'run_readonly_query', { sql: 'SELECT 1' }), /not allowed/);
});
