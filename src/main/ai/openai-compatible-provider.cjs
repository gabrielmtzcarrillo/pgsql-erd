// OpenAI-compatible Chat Completions API: vLLM, LM Studio, llama.cpp server,
// LocalAI, OpenRouter and others. GET /models, POST /chat/completions
// (server-sent events when streaming).

const { BaseProvider, joinUrl, request, requestJson, sse, callId, parseArgs, ProviderError } = require('./provider.cjs');

function toOpenAiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    const out = { role: m.role, content: m.content ?? '' };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
      if (!out.content) out.content = null;
    }
    return out;
  });
}

class OpenAICompatibleProvider extends BaseProvider {
  constructor(config, opts) {
    super({ ...config, baseUrl: config.baseUrl || 'http://localhost:8000/v1' }, opts);
  }

  authHeaders() {
    return { ...this.headers, ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async listModels() {
    const j = await requestJson(joinUrl(this.baseUrl, '/models'), { headers: this.authHeaders(), timeoutMs: 15000 });
    return (j.data ?? j.models ?? []).map((m) => ({ id: m.id ?? m.name, name: m.id ?? m.name })).sort((a, b) => a.id.localeCompare(b.id));
  }

  body(req, stream) {
    const body = { model: req.model, messages: toOpenAiMessages(req.messages), stream };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    if (req.json) {
      body.response_format = req.json.schema
        ? { type: 'json_schema', json_schema: { name: req.json.name ?? 'result', schema: req.json.schema, strict: false } }
        : { type: 'json_object' };
    }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  async chat(req, { onToken, signal } = {}) {
    if (!req.model) throw new ProviderError('Choose a model first.');
    const stream = !!onToken;
    const { res, done } = await request(joinUrl(this.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: this.authHeaders(),
      body: this.body(req, stream),
      signal,
      timeoutMs: this.timeoutMs,
    });
    try {
      if (!stream) {
        const j = await res.json();
        const msg = j.choices?.[0]?.message ?? {};
        return {
          content: msg.content ?? '',
          toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id ?? callId(), name: c.function?.name, arguments: parseArgs(c.function?.arguments) })),
          model: j.model,
          usage: usage(j.usage),
        };
      }
      let content = '';
      const calls = new Map(); // index -> { id, name, args }
      let model = req.model;
      let u;
      for await (const data of sse(res)) {
        if (data === '[DONE]') break;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new ProviderError(String(j.error.message ?? j.error));
        model = j.model ?? model;
        if (j.usage) u = usage(j.usage);
        const delta = j.choices?.[0]?.delta ?? {};
        if (delta.content) {
          content += delta.content;
          onToken(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const key = tc.index ?? calls.size;
          const cur = calls.get(key) ?? { id: tc.id, name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(key, cur);
        }
      }
      const toolCalls = [...calls.values()].map((c) => ({ id: c.id ?? callId(), name: c.name, arguments: parseArgs(c.args) }));
      return { content, toolCalls, model, usage: u };
    } finally {
      done();
    }
  }
}

const usage = (u) => (u ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens } : undefined);

module.exports = { OpenAICompatibleProvider, toOpenAiMessages };
