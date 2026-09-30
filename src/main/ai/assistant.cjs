// The assistant: builds the context the user allowed, calls the chosen
// provider (streaming tokens to the window), runs tool calls within the
// assistant's permissions, and records each request in the audit log.
// Also answers ai.chat() / ai.structured() calls from scripts.

const { availableTools, executeTool } = require('./ai-tools.cjs');
const { isToolsUnsupported } = require('./provider.cjs');
const { structured } = require('./structured.cjs');

const MAX_TOOL_ROUNDS = 8;
const MIN_INTERVAL_MS = 1000;

class Assistant {
  // services: { schemaFor(windowId, diagramSchema), connected(windowId), readOnly(windowId, fn),
  //             checkScript(schema, source), listScripts(windowId), runSaved(windowId, path, opts) }
  constructor({ shared, providers, services, audit }) {
    this.shared = shared;
    this.providers = providers;
    this.services = services;
    this.audit = audit;
    this.inFlight = new Map(); // windowId -> { requestId, controller }
    this.lastRequest = new Map(); // windowId -> time
  }

  cancel(windowId) {
    this.inFlight.get(windowId)?.controller.abort(new Error('Cancelled'));
  }

  async listModels(providerId) {
    return this.providers.get(providerId).listModels();
  }

  // req: { requestId, providerId, model, history, prompt, selection, contextOptions,
  //        permissions, shareRows, useTools, script, validationErrors, diagramSchema }
  async chat(windowId, req, emit) {
    if (this.inFlight.has(windowId)) throw new Error('The assistant is still answering the previous request.');
    const since = Date.now() - (this.lastRequest.get(windowId) ?? 0);
    if (since < MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - since));
    const controller = new AbortController();
    this.inFlight.set(windowId, { requestId: req.requestId, controller });
    this.lastRequest.set(windowId, Date.now());
    try {
      return await this.converse(windowId, req, emit, controller.signal);
    } finally {
      this.inFlight.delete(windowId);
    }
  }

  async converse(windowId, req, emit, signal) {
    const { shared } = this;
    const provider = this.providers.get(req.providerId);
    const permissions = shared.normalizeAiPermissions(req.permissions);
    const connected = this.services.connected(windowId);
    const schema = await this.services.schemaFor(windowId, req.diagramSchema);
    const options = { ...shared.DEFAULT_CONTEXT_OPTIONS, ...(req.contextOptions ?? {}) };
    // Row data may go to a remote provider only when the user said so.
    const rowsAllowed = permissions.readData && connected && (provider.isLocal || req.shareRows === true);
    const selection = [...new Set([...(req.selection ?? []), ...shared.tablesInText(schema, req.prompt)])];

    let context = { text: 'The assistant may not read the database schema.', tables: [] };
    if (permissions.readSchema) {
      context = shared.buildContext(schema, selection, options, { script: req.script, validationErrors: req.validationErrors });
    }
    let sharedRows = false;
    if (options.rowSamples) {
      if (!permissions.readData) throw new Error('Row samples need the "Read rows" permission.');
      if (!connected) throw new Error('Row samples need a database connection.');
      if (!rowsAllowed) throw new Error(`${provider.name} is a remote provider: confirm sharing row data with it first.`);
      const samples = [];
      for (const id of context.tables.slice(0, 6)) {
        const t = shared.findTable(schema, id);
        const rows = await this.services.readOnly(windowId, (c) =>
          c.query(`SELECT * FROM "${t.schema.replace(/"/g, '""')}"."${t.name.replace(/"/g, '""')}" LIMIT 5`).then((r) => r.rows)
        );
        samples.push(`${t.id}:\n${JSON.stringify(rows, null, 1)}`);
      }
      if (samples.length) {
        context.text += `\n\nSAMPLE ROWS\n${samples.join('\n\n')}`;
        sharedRows = true;
      }
    }

    const tctx = {
      windowId,
      shared,
      schema,
      permissions,
      connected,
      rowsAllowed,
      services: this.services,
      emit,
      sharedRows: false,
    };
    let tools = req.useTools ? availableTools(tctx) : [];
    const messages = [
      { role: 'system', content: `${shared.assistantSystemPrompt({ tools: tools.length > 0 })}\n\n# Context\n${context.text}` },
      ...(req.history ?? []).slice(-20).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
      { role: 'user', content: String(req.prompt ?? '') },
    ];
    emit({ type: 'context', tables: context.tables, rowData: sharedRows, local: provider.isLocal, tools: tools.map((t) => t.name) });

    const usedTools = [];
    let final = null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let res;
      try {
        res = await provider.chat(
          { model: req.model, messages, temperature: req.temperature ?? 0.2, tools: round < MAX_TOOL_ROUNDS ? tools : [] },
          { onToken: (text) => emit({ type: 'token', text }), signal }
        );
      } catch (err) {
        if (tools.length && isToolsUnsupported(err)) {
          emit({ type: 'notice', text: `${req.model} doesn't support tool calling; answering from the provided context only.` });
          tools = [];
          round--;
          continue;
        }
        throw err;
      }
      if (!res.toolCalls?.length) {
        final = res;
        break;
      }
      messages.push({ role: 'assistant', content: res.content ?? '', toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        emit({ type: 'tool', name: call.name, args: call.arguments });
        usedTools.push(call.name);
        let result;
        let ok = true;
        try {
          result = await executeTool(tctx, call.name, call.arguments);
        } catch (err) {
          ok = false;
          result = `Error: ${err.message}`;
        }
        emit({ type: 'tool-result', name: call.name, ok, preview: String(result).slice(0, 300) });
        messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: String(result) });
      }
    }
    sharedRows ||= tctx.sharedRows;
    this.audit?.log(sharedRows ? 'ai-query-with-row-data' : 'ai-query', {
      windowId,
      provider: provider.id,
      local: provider.isLocal,
      model: req.model,
      tables: context.tables,
      tools: usedTools,
      rowData: sharedRows,
    });
    return { content: final?.content ?? '', usage: final?.usage, model: final?.model ?? req.model, rowData: sharedRows };
  }

  // ai.chat() and ai.structured() from a running script.
  // A script may send rows to a remote provider only when the user agreed
  // to it for this run (shareData).
  async scriptCall({ providerId, model, shareData = false, schema, signal }, msg) {
    if (!providerId || !model) throw new Error('Choose an AI provider and model in the Assistant panel first.');
    const provider = this.providers.get(providerId);
    if (!provider.isLocal && !shareData) throw new Error(`${provider.name} is a remote provider: allow sending data to it when you run the script.`);
    this.audit?.log('ai-script-call', { provider: provider.id, local: provider.isLocal, model, kind: msg.kind });
    if (msg.kind === 'chat') {
      const o = msg.options ?? {};
      const res = await provider.chat(
        {
          model,
          temperature: o.temperature,
          messages: [...(o.system ? [{ role: 'system', content: String(o.system) }] : []), { role: 'user', content: msg.prompt }],
        },
        { signal }
      );
      return res.content;
    }
    if (msg.kind === 'structured') {
      const o = msg.options ?? {};
      const { value } = await structured({
        provider,
        model,
        shared: this.shared,
        schema,
        prompt: o.prompt,
        jsonSchema: o.schema,
        table: o.table,
        retries: Math.min(5, Math.max(0, o.retries ?? 2)),
        temperature: o.temperature ?? 0.7,
        signal,
      });
      return value;
    }
    throw new Error(`Unknown AI call: ${msg.kind}`);
  }
}

module.exports = { Assistant };
