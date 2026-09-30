// Ollama (https://github.com/ollama/ollama/blob/main/docs/api.md):
// GET /api/tags lists models, POST /api/chat chats (NDJSON when streaming).
// Structured output uses `format: <JSON schema>`.

const { BaseProvider, joinUrl, request, requestJson, lines, callId, parseArgs, ProviderError } = require('./provider.cjs');

function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: String(m.content ?? ''), tool_name: m.toolName };
    const out = { role: m.role, content: String(m.content ?? '') };
    if (m.toolCalls?.length) out.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } }));
    return out;
  });
}

class OllamaProvider extends BaseProvider {
  constructor(config, opts) {
    super({ ...config, baseUrl: config.baseUrl || 'http://localhost:11434' }, opts);
  }

  authHeaders() {
    return { ...this.headers, ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async listModels() {
    const j = await requestJson(joinUrl(this.baseUrl, '/api/tags'), { headers: this.authHeaders(), timeoutMs: 15000 });
    return (j.models ?? []).map((m) => ({ id: m.model ?? m.name, name: m.name ?? m.model, size: m.size }));
  }

  async chat(req, { onToken, signal } = {}) {
    const body = {
      model: req.model,
      messages: toOllamaMessages(req.messages),
      stream: !!onToken,
      options: {},
    };
    if (req.temperature !== undefined) body.options.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.json) body.format = req.json.schema ?? 'json';
    if (!req.model) throw new ProviderError('Choose a model first.');

    const { res, done } = await request(joinUrl(this.baseUrl, '/api/chat'), {
      method: 'POST',
      headers: this.authHeaders(),
      body,
      signal,
      timeoutMs: this.timeoutMs,
    });
    try {
      if (!onToken) {
        const j = await res.json();
        return this.response(j.message, j);
      }
      let content = '';
      const toolCalls = [];
      let last = {};
      for await (const line of lines(res)) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.error) throw new ProviderError(String(j.error));
        const piece = j.message?.content ?? '';
        if (piece) {
          content += piece;
          onToken(piece);
        }
        for (const c of j.message?.tool_calls ?? []) toolCalls.push({ id: callId(), name: c.function?.name, arguments: parseArgs(c.function?.arguments) });
        last = j;
      }
      return { content, toolCalls, model: last.model ?? req.model, usage: usage(last) };
    } finally {
      done();
    }
  }

  response(message = {}, j = {}) {
    return {
      content: message.content ?? '',
      toolCalls: (message.tool_calls ?? []).map((c) => ({ id: callId(), name: c.function?.name, arguments: parseArgs(c.function?.arguments) })),
      model: j.model,
      usage: usage(j),
    };
  }
}

const usage = (j) => (j?.prompt_eval_count !== undefined ? { inputTokens: j.prompt_eval_count, outputTokens: j.eval_count } : undefined);

module.exports = { OllamaProvider };
