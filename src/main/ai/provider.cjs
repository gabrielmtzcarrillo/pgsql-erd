// Common pieces of the LLM providers.
//
// interface LlmProvider {
//   id, name, type, baseUrl
//   listModels(): Promise<{ id, name }[]>
//   chat(request, { onToken, signal }): Promise<ChatResponse>
//   stream(request, onToken, { signal }): Promise<ChatResponse>
// }
//
// ChatRequest = {
//   model, messages: [{ role: 'system'|'user'|'assistant'|'tool', content,
//                       toolCalls?: [{ id, name, arguments }], toolCallId?, toolName? }],
//   temperature?, tools?: [{ name, description, parameters }],
//   json?: { name, schema },   // structured output
// }
// ChatResponse = { content, toolCalls: [{ id, name, arguments }], usage?, model }

class ProviderError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^f[cd][0-9a-f]{2}:/i.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.lan') ||
      host.endsWith('.internal')
    );
  } catch {
    return false;
  }
}

const joinUrl = (base, p) => `${String(base).replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;

// fetch with a timeout that also honours an outer AbortSignal.
async function request(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason ?? new Error('Cancelled'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.error?.message ?? j.error ?? j.message ?? text;
      } catch {
        // not JSON
      }
      throw new ProviderError(`${res.status} ${res.statusText}${msg ? `: ${String(msg).slice(0, 500)}` : ''}`, { status: res.status, body: text });
    }
    return { res, done: () => clearTimeout(timer) };
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    if (err instanceof ProviderError) throw err;
    if (ctrl.signal.aborted) throw new ProviderError(String(ctrl.signal.reason?.message ?? 'Cancelled'));
    throw new ProviderError(`Could not reach ${new URL(url).origin}: ${err.cause?.code ?? err.message}`);
  }
}

async function requestJson(url, opts) {
  const { res, done } = await request(url, opts);
  try {
    return await res.json();
  } finally {
    done();
  }
}

// Yields lines of a streamed response body.
async function* lines(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

// Server-sent events: yields the data of each event.
async function* sse(res) {
  let data = [];
  for await (const line of lines(res)) {
    if (line === '') {
      if (data.length) yield data.join('\n');
      data = [];
    } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) yield data.join('\n');
}

let callSeq = 0;
const callId = () => `call_${Date.now().toString(36)}_${++callSeq}`;

function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: String(args) };
  }
}

// Errors that mean "this model/server doesn't do tools" or "doesn't do
// JSON schema output", so the caller can retry without them.
const isToolsUnsupported = (err) => err instanceof ProviderError && err.status >= 400 && err.status < 500 && /tool/i.test(err.message);
const isFormatUnsupported = (err) =>
  err instanceof ProviderError && err.status >= 400 && err.status < 500 && /(response_format|json_schema|format|guided)/i.test(err.message);

class BaseProvider {
  constructor(config, { apiKey } = {}) {
    this.id = config.id;
    this.name = config.name || config.id;
    this.type = config.type;
    this.baseUrl = config.baseUrl;
    this.apiKey = apiKey || null;
    this.headers = config.headers ?? {};
    this.timeoutMs = config.timeoutMs ?? 300000;
  }

  get isLocal() {
    return isLocalUrl(this.baseUrl);
  }

  stream(req, onToken, opts = {}) {
    return this.chat(req, { ...opts, onToken });
  }
}

module.exports = {
  BaseProvider,
  ProviderError,
  isLocalUrl,
  joinUrl,
  request,
  requestJson,
  lines,
  sse,
  callId,
  parseArgs,
  isToolsUnsupported,
  isFormatUnsupported,
};
