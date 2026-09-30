// AI provider configuration (independent of projects) and API keys.
//
// Providers are stored in <userData>/ai-providers.json without secrets:
//   { "providers": [{ "id": "local-ollama", "name": "Ollama", "type": "ollama", "baseUrl": "http://localhost:11434" }] }
// API keys are encrypted with the operating system's credential store
// (Electron safeStorage: Keychain, DPAPI, libsecret/kwallet) into
// <userData>/ai-keys.json. When no secure store is available keys are kept
// in memory for the session only. Keys never leave the main process.

const fs = require('node:fs');
const path = require('node:path');
const { OllamaProvider } = require('./ollama-provider.cjs');
const { OpenAICompatibleProvider } = require('./openai-compatible-provider.cjs');
const { OpenAIProvider } = require('./openai-provider.cjs');
const { isLocalUrl } = require('./provider.cjs');

const TYPES = {
  ollama: { label: 'Ollama', cls: OllamaProvider, defaultUrl: 'http://localhost:11434' },
  'openai-compatible': { label: 'OpenAI-compatible (vLLM, LM Studio, llama.cpp…)', cls: OpenAICompatibleProvider, defaultUrl: 'http://localhost:8000/v1' },
  openai: { label: 'OpenAI', cls: OpenAIProvider, defaultUrl: 'https://api.openai.com/v1' },
};

const DEFAULT_PROVIDERS = [
  { id: 'local-ollama', name: 'Ollama (local)', type: 'ollama', baseUrl: 'http://localhost:11434' },
  { id: 'local-vllm', name: 'vLLM (local)', type: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' },
  { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1' },
];

// crypto: { available(): boolean, encrypt(text): Buffer, decrypt(Buffer): string }
class ProviderManager {
  constructor({ dir, crypto = null, env = process.env }) {
    this.dir = dir;
    this.crypto = crypto;
    this.env = env;
    this.memoryKeys = new Map();
    this.providers = this.loadProviders();
  }

  get configFile() {
    return path.join(this.dir, 'ai-providers.json');
  }

  get keysFile() {
    return path.join(this.dir, 'ai-keys.json');
  }

  loadProviders() {
    try {
      const j = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      if (Array.isArray(j.providers)) return j.providers.filter((p) => TYPES[p.type] && p.id).map(clean);
    } catch {
      // first run or unreadable: use the defaults
    }
    return DEFAULT_PROVIDERS.map((p) => ({ ...p }));
  }

  saveProviders() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.configFile, `${JSON.stringify({ providers: this.providers }, null, 2)}\n`);
  }

  secureStorage() {
    return !!this.crypto?.available();
  }

  readKeys() {
    try {
      return JSON.parse(fs.readFileSync(this.keysFile, 'utf8'));
    } catch {
      return {};
    }
  }

  getKey(id) {
    if (this.memoryKeys.has(id)) return this.memoryKeys.get(id);
    const stored = this.readKeys()[id];
    if (stored && this.secureStorage()) {
      try {
        return this.crypto.decrypt(Buffer.from(stored, 'base64'));
      } catch {
        return null;
      }
    }
    const p = this.providers.find((x) => x.id === id);
    if (p?.type === 'openai' && this.env.OPENAI_API_KEY) return this.env.OPENAI_API_KEY;
    return null;
  }

  // key: string to set, '' or null to remove.
  setKey(id, key) {
    const keys = this.readKeys();
    this.memoryKeys.delete(id);
    delete keys[id];
    if (key) {
      if (this.secureStorage()) keys[id] = this.crypto.encrypt(key).toString('base64');
      else this.memoryKeys.set(id, key);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.keysFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  }

  // What the renderer may see: no keys, only whether one is set.
  list() {
    return {
      types: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { label: v.label, defaultUrl: v.defaultUrl }])),
      secureStorage: this.secureStorage(),
      providers: this.providers.map((p) => ({
        ...p,
        baseUrl: p.baseUrl || TYPES[p.type].defaultUrl,
        hasKey: !!this.getKey(p.id),
        local: isLocalUrl(p.baseUrl || TYPES[p.type].defaultUrl),
      })),
    };
  }

  upsert(config, key) {
    const p = clean(config);
    if (!TYPES[p.type]) throw new Error(`Unknown provider type: ${p.type}`);
    if (!p.id) p.id = uniqueId(this.providers, p.name || p.type);
    if (p.baseUrl) new URL(p.baseUrl); // throws on an invalid URL
    const i = this.providers.findIndex((x) => x.id === p.id);
    if (i === -1) this.providers.push(p);
    else this.providers[i] = p;
    this.saveProviders();
    if (key !== undefined) this.setKey(p.id, key);
    return p.id;
  }

  remove(id) {
    this.providers = this.providers.filter((p) => p.id !== id);
    this.saveProviders();
    this.setKey(id, null);
  }

  get(id) {
    const config = this.providers.find((p) => p.id === id);
    if (!config) throw new Error(`Unknown AI provider: ${id || '(none)'}. Choose one in AI settings.`);
    const { cls } = TYPES[config.type];
    return new cls(config, { apiKey: this.getKey(id) });
  }
}

function clean(p) {
  const out = { id: String(p.id ?? '').trim(), name: String(p.name ?? '').trim(), type: String(p.type ?? '') };
  if (p.baseUrl) out.baseUrl = String(p.baseUrl).trim();
  if (p.headers && typeof p.headers === 'object') out.headers = p.headers;
  return out;
}

function uniqueId(list, name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
  let id = base;
  for (let i = 2; list.some((p) => p.id === id); i++) id = `${base}-${i}`;
  return id;
}

module.exports = { ProviderManager, TYPES, DEFAULT_PROVIDERS };
