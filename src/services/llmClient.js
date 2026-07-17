import { getSetting } from '../config.js';

const anthropicApiUrl = 'https://api.anthropic.com/v1/messages';
const openRouterApiUrl = 'https://openrouter.ai/api/v1/chat/completions';
const defaultClaudeModel = 'claude-sonnet-4-5';

export async function generateWithLlm({ system, prompt, messages, maxTokens = 1600, timeoutMs = 60000, providerPreference = 'anthropic', model }) {
  const conversation = normalizeMessages(messages, prompt);
  const openRouterKey = getSetting('OPENROUTER_API_KEY');
  const apiKey = getSetting('ANTHROPIC_API_KEY');
  if (providerPreference === 'openrouter_first' && openRouterKey) {
    return requestOpenRouter({ apiKey: openRouterKey, system, messages: conversation, maxTokens, timeoutMs, model });
  }
  if (!apiKey && openRouterKey) {
    return requestOpenRouter({ apiKey: openRouterKey, system, messages: conversation, maxTokens, timeoutMs, model });
  }
  if (!apiKey) {
    return {
      provider: 'prompt_only',
      text: `${system}\n\n${conversation.map((message) => `${message.role}: ${message.content}`).join('\n\n')}`
    };
  }

  const anthropicModel = String(model || '').startsWith('anthropic/') ? undefined : model;
  const response = await requestClaude({ apiKey, system, messages: conversation, maxTokens, timeoutMs, model: anthropicModel });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API returned ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();

  return { provider: 'claude', text: text || JSON.stringify(data) };
}

async function requestClaude({ apiKey, system, messages, maxTokens, timeoutMs, model }) {
  const retryStatuses = new Set([429, 500, 502, 503, 529]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(anthropicApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model || process.env.CLAUDE_MODEL || defaultClaudeModel,
          max_tokens: maxTokens,
          system,
          messages
        }),
        signal: controller.signal
      });
      if (!retryStatuses.has(response.status) || attempt === 2) return response;
      await response.text();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`Claude took longer than ${Math.round(timeoutMs / 1000)} seconds to respond. Please try again.`);
      if (attempt === 2) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await delay(1000 * (2 ** attempt));
  }
  throw new Error('Claude did not respond after several attempts.');
}

async function requestOpenRouter({ apiKey, system, messages, maxTokens, timeoutMs, model }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(openRouterApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://author-hq.local',
        'X-Title': 'Author HQ'
      },
      body: JSON.stringify({
        model: model || 'anthropic/claude-sonnet-4.6',
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages],
        provider: { data_collection: 'deny', zdr: true }
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter returned ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    return { provider: 'openrouter', text: text || JSON.stringify(data), model: data.model || model };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`OpenRouter took longer than ${Math.round(timeoutMs / 1000)} seconds to respond. Please try again.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMessages(messages, prompt) {
  const source = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: prompt || '' }];
  return source
    .filter((message) => ['user', 'assistant'].includes(message?.role) && String(message?.content || '').trim())
    .map((message) => ({ role: message.role, content: String(message.content).trim() }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
