import test from 'node:test';
import assert from 'node:assert/strict';
import { applyKdpPenTemplate, kdpPenTemplateFor } from '../src/services/kdpPenTemplateService.js';
import { generateKdpPacket } from '../src/services/kdpListingService.js';

const basePacket = {
  format: 'ebook',
  title: 'Fallback Title',
  description_html: 'Fallback description',
  keywords: [],
  categories_suggested: [],
  warnings: ['Review before publishing.'],
  marketing_validation: {}
};

test('loads the Ana Rourke packet template by pen key', () => {
  const template = kdpPenTemplateFor({ key: 'ana-rourke', display_name: 'Ana Rourke' });
  assert.equal(template.priceUsd, 2.99);
  assert.equal(template.kinkKeywordRules.length, 7);
});

test('locks Ana packet fields and derives dark category and priority keywords from project metadata', () => {
  const packet = applyKdpPenTemplate({
    packet: basePacket,
    penName: { key: 'ana-rourke', display_name: 'Ana Rourke' },
    manuscriptBrief: {
      project_metadata: {
        title: 'A Dangerous Arrangement',
        heatLevel: 'all',
        tropes: ['strangers', 'enemies-to-lovers', 'dark-romance'],
        kinkProfile: ['Boss/authority figure'],
        cncPresent: true
      },
      kdp_blurb: 'She made one dangerous bargain.\n\nHe intends to collect.'
    }
  });

  assert.equal(packet.title, 'A Dangerous Arrangement');
  assert.equal(packet.price_usd, 2.99);
  assert.equal(packet.ku_enrolled, true);
  assert.equal(packet.adult_content, true);
  assert.equal(packet.ai_disclosure.ai_generated, true);
  assert.equal(packet.keywords.length, 7);
  assert.equal(packet.keywords[0], 'M/F erotica short story');
  assert.equal(packet.keywords[1], 'dark romance erotica');
  assert.equal(packet.keywords[5], 'forbidden boss romance steamy');
  assert.equal(packet.categories_suggested[0].path, 'Romance > Contemporary');
  assert.equal(packet.categories_suggested[1].path, 'Romance > Dark Romance');
  assert.match(packet.description_html, /She made one dangerous bargain/);
  assert.match(packet.description_html, /adult readers 18\+/);
  assert.match(packet.author_bio, /heat without the wait/);
});

test('uses Romantic and safe fallback keywords when Ana metadata has no dark or mapped profile', () => {
  const packet = applyKdpPenTemplate({
    packet: basePacket,
    penName: { display_name: 'Ana Rourke' },
    manuscriptBrief: {
      project_metadata: {
        heatLevel: 'explicit',
        tropes: ['forced proximity'],
        kinkProfile: ['custom profile']
      }
    }
  });

  assert.equal(packet.categories_suggested[0].path, 'Romance > Contemporary');
  assert.equal(packet.categories_suggested[1].path, 'Romance > Alpha Male');
  assert.equal(packet.keywords[1], 'steamy M/F erotica romance');
  assert.equal(packet.keywords[5], 'steamy adult romance explicit');
});

test('does not apply Ana rules to another pen name', () => {
  assert.equal(applyKdpPenTemplate({
    packet: basePacket,
    penName: { key: 'sage-halcyon', display_name: 'Sage Halcyon' }
  }), null);
});

test('Ana template constrains a Claude-generated packet instead of bypassing the LLM', async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  let calls = 0;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  delete process.env.ANTHROPIC_API_KEY;
  const generatedPacket = {
    ...basePacket,
    title: 'Wrong Generated Title',
    description_html: '<b>A sharper Claude hook.</b><br><br>She knows the bargain will cost her.',
    description_options: [
      { approach: 'emotional', description_html: 'Emotional option', rationale: 'Emotion' },
      { approach: 'high-concept', description_html: 'Concept option', rationale: 'Hook' },
      { approach: 'trope-forward', description_html: 'Trope option', rationale: 'Reader promise' }
    ],
    keywords: ['wrong keyword'],
    categories_suggested: [{ path: 'Kindle Store > Children', rating: 'Easy', rationale: 'Wrong' }],
    price_usd: 9.99,
    category_strategy: { summary: 'Generated strategy', no_ads_plan: ['Generated action'] },
    marketing_validation: { status: 'Claude reviewed' },
    warnings: ['Review before publishing.']
  };
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        model: 'anthropic/claude-sonnet-4.6',
        choices: [{ message: { content: JSON.stringify(generatedPacket) } }]
      })
    };
  };

  try {
    const result = await generateKdpPacket({
      penName: { key: 'ana-rourke', display_name: 'Ana Rourke' },
      genreConfig: {},
      book: { title: 'A Dangerous Arrangement' },
      listing: { title: 'A Dangerous Arrangement', blurbDraft: 'A rough description to improve.' },
      manuscriptBrief: {
        project_metadata: {
          title: 'A Dangerous Arrangement',
          tropes: ['dark-romance'],
          kinkProfile: ['Boss/authority figure']
        }
      }
    });

    assert.equal(calls, 2);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.packet.title, 'A Dangerous Arrangement');
    assert.equal(result.packet.price_usd, 2.99);
    assert.equal(result.packet.keywords[0], 'M/F erotica short story');
    assert.equal(result.packet.categories_suggested[0].path, 'Romance > Contemporary');
    assert.equal(result.packet.categories_suggested[1].path, 'Romance > Dark Romance');
    assert.equal(result.packet.description_options.length, 3);
    assert.match(result.packet.description_html, /A sharper Claude hook/);
    assert.match(result.packet.description_html, /adult readers 18\+/);
    assert.doesNotMatch(result.packet.description_html, /A rough description to improve/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenRouterKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalAnthropicKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }
});
