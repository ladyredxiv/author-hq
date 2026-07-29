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
  assert.equal(template.categoryPolicy.count, 3);
  assert.equal(template.fixedKeywords, undefined);
});

test('locks Ana operational fields while preserving creative keywords and three Romance-first categories', () => {
  const creativeKeywords = [
    'obsessive CEO office romance',
    'forbidden workplace power dynamic',
    'morally gray billionaire romance',
    'assistant boss steamy short read',
    'possessive hero corporate romance',
    'high heat enemies to lovers',
    'dangerous contract romance'
  ];
  const packet = applyKdpPenTemplate({
    packet: {
      ...basePacket,
      keywords: creativeKeywords,
      keyword_sets: [{ label: 'Primary', keywords: creativeKeywords, rationale: 'Book-specific terms' }],
      keyword_notes: 'Book-specific Claude strategy.',
      categories_suggested: [
        { path: 'Mystery, Thriller & Suspense > Psychological', rating: 'Competitive', rationale: 'Tension crossover' },
        { path: 'Romance > Workplace Romance', rating: 'Fortress', rationale: 'Primary reader fit' },
        { path: 'Literature & Fiction > Erotica', rating: 'Fortress', rationale: 'Must be removed' }
      ]
    },
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
  assert.deepEqual(packet.keywords, creativeKeywords);
  assert.equal(packet.keyword_sets[0].label, 'Primary');
  assert.equal(packet.categories_suggested.length, 3);
  assert.equal(packet.categories_suggested[0].path, 'Romance > Workplace Romance');
  assert.equal(packet.categories_suggested[1].path, 'Mystery, Thriller & Suspense > Psychological');
  assert.equal(packet.categories_suggested[2].path, 'Romance > Contemporary');
  assert.equal(packet.categories_suggested.some((category) => category.path.includes('Erotica')), false);
  assert.match(packet.description_html, /She made one dangerous bargain/);
  assert.match(packet.description_html, /adult readers 18\+/);
  assert.match(packet.author_bio, /heat without the wait/);
});

test('fills missing Ana categories without replacing Claude keywords', () => {
  const packet = applyKdpPenTemplate({
    packet: {
      ...basePacket,
      keywords: ['specific forced proximity romance'],
      categories_suggested: [{ path: 'Romance > Workplace Romance', rating: 'Fortress', rationale: 'Book fit' }]
    },
    penName: { display_name: 'Ana Rourke' },
    manuscriptBrief: {
      project_metadata: {
        heatLevel: 'explicit',
        tropes: ['forced proximity'],
        kinkProfile: ['custom profile']
      }
    }
  });

  assert.equal(packet.categories_suggested.length, 3);
  assert.equal(packet.categories_suggested[0].path, 'Romance > Workplace Romance');
  assert.equal(packet.keywords[0], 'specific forced proximity romance');
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
    keywords: [
      'obsessive CEO office romance',
      'forbidden workplace power dynamic',
      'morally gray billionaire romance',
      'assistant boss steamy short read',
      'possessive hero corporate romance',
      'high heat enemies to lovers',
      'dangerous contract romance'
    ],
    keyword_sets: [{
      label: 'Primary',
      keywords: ['obsessive CEO office romance'],
      rationale: 'Specific to this book'
    }],
    keyword_notes: 'Targets the book-specific workplace and power dynamic.',
    categories_suggested: [
      { path: 'Business & Money > Management & Leadership', rating: 'Competitive', rationale: 'Corporate crossover' },
      { path: 'Romance > Workplace Romance', rating: 'Fortress', rationale: 'Primary reader fit' }
    ],
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
    assert.equal(result.packet.keywords[0], 'obsessive CEO office romance');
    assert.equal(result.packet.keywords.length, 7);
    assert.equal(result.packet.categories_suggested.length, 3);
    assert.equal(result.packet.categories_suggested[0].path, 'Romance > Workplace Romance');
    assert.equal(result.packet.categories_suggested[1].path, 'Business & Money > Management & Leadership');
    assert.equal(result.packet.categories_suggested[2].path, 'Romance > Contemporary');
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
