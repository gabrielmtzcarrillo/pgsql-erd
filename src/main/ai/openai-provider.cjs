// OpenAI's hosted API: the OpenAI-compatible provider with the official
// endpoint, a required API key, and only chat models in the model list.

const { OpenAICompatibleProvider } = require('./openai-compatible-provider.cjs');
const { ProviderError } = require('./provider.cjs');

const NON_CHAT = /(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|davinci|babbage|sora)/i;

class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config, opts) {
    super({ ...config, baseUrl: config.baseUrl || 'https://api.openai.com/v1' }, opts);
  }

  requireKey() {
    if (!this.apiKey) throw new ProviderError('Add an OpenAI API key in AI settings (or set OPENAI_API_KEY).');
  }

  async listModels() {
    this.requireKey();
    return (await super.listModels()).filter((m) => !NON_CHAT.test(m.id));
  }

  async chat(req, opts) {
    this.requireKey();
    return super.chat(req, opts);
  }
}

module.exports = { OpenAIProvider };
