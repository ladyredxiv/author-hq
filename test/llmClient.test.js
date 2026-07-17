import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWithLlm } from '../src/services/llmClient.js';

test('OpenRouter newsletter chat sends multi-turn Claude messages with privacy routing', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let request;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: 'Let us find the angle.' } }] })
    };
  };
  try {
    const result = await generateWithLlm({
      system: 'Newsletter partner',
      messages: [{ role: 'user', content: 'I have a release next week.' }],
      providerPreference: 'openrouter_first',
      model: 'anthropic/claude-haiku-4.5'
    });
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.text, 'Let us find the angle.');
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.body.model, 'anthropic/claude-haiku-4.5');
    assert.deepEqual(request.body.provider, { data_collection: 'deny', zdr: true });
    assert.deepEqual(request.body.messages.map((message) => message.role), ['system', 'user']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});
