import test from 'node:test';
import assert from 'node:assert/strict';
import {
  descriptionNeedsRepair,
  descriptionSourceKind,
  generateKdpPacket
} from '../src/services/kdpListingService.js';

const longSynopsis = Array.from({ length: 28 }, (_, index) =>
  `Maren follows evidence through Selvast while Lucrezia protects a buried record and the investigation grows more intimate ${index + 1}.`
).join(' ') + ' Maren publishes the truth, protects Emrys, and Lucrezia chooses to become findable.';

test('recognizes detailed synopses and raw synopsis-shaped descriptions', () => {
  assert.equal(descriptionSourceKind(longSynopsis), 'detailed synopsis');
  assert.equal(descriptionSourceKind('A sharp hook and a few rough notes.'), 'rough notes or existing blurb');
  assert.equal(descriptionNeedsRepair({ description_html: longSynopsis, description_options: [] }, longSynopsis), true);
  assert.equal(descriptionNeedsRepair({
    description_html: longSynopsis,
    description_options: [{}, {}, {}]
  }, longSynopsis), true);
});

test('turns a pasted synopsis into a focused KDP blurb instead of publishing it verbatim', async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  let calls = 0;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  delete process.env.ANTHROPIC_API_KEY;

  const keywords = [
    'investigative journalist ancient predator',
    'archival conspiracy slow burn',
    'haunted city forbidden attraction',
    'institutional secrets sapphic tension',
    'centuries old witness',
    'dangerous source relationship',
    'atmospheric political intrigue'
  ];
  const rawPacket = {
    format: 'ebook',
    title: 'What the Night Keeps',
    subtitle: '',
    description_html: `<b>What the Night Keeps</b><br><br>${longSynopsis}`,
    description_options: [],
    keywords,
    keyword_sets: [],
    categories_suggested: [
      { path: 'Romance > Paranormal', rating: 'Competitive', rationale: 'Reader fit' },
      { path: 'Fantasy > Vampires', rating: 'Competitive', rationale: 'Creature promise' },
      { path: 'Literature & Fiction > LGBTQ+', rating: 'Competitive', rationale: 'Relationship fit' }
    ],
    warnings: []
  };
  const finalBlurb = `<b>She came to expose a system. She never expected its oldest witness to expose her.</b><br><br>
Journalist Maren has followed evidence across the world to Selvast, where the Registry quietly classifies people without consent and buries anyone it cannot explain. Her investigation is professional until she discovers a secret file bearing her own name.<br><br>
Lucrezia has watched the city hide its crimes for centuries. Ancient, predatory, and fiercely self-contained, she possesses the record Maren needs, along with dangerous truths the Registry would do anything to keep forgotten. She has dismissed every journalist who came before. Maren is the first who asks the right questions.<br><br>
Their charged source relationship soon becomes impossible to keep professional. As Maren moves from Selvast's polished offices into its haunted old districts, every answer draws her closer to Lucrezia and deeper into an institution built on silence. Publishing the truth could protect the people the Registry erased, but it could also make Lucrezia visible to enemies who have hunted her kind for generations.<br><br>
To put the truth on the record, Maren must decide how much she is willing to risk, and whether she can protect the woman who has finally chosen to be found.`;
  const repaired = {
    description_html: finalBlurb,
    description_options: [
      { approach: 'emotional', description_html: finalBlurb, rationale: 'Leads with dangerous intimacy.' },
      { approach: 'high-concept', description_html: finalBlurb, rationale: 'Leads with the buried institutional record.' },
      { approach: 'trope-forward', description_html: finalBlurb, rationale: 'Leads with ancient vampire and journalist tension.' }
    ]
  };

  globalThis.fetch = async () => {
    calls += 1;
    const content = JSON.stringify(calls === 3 ? repaired : rawPacket);
    return {
      ok: true,
      json: async () => ({
        model: 'anthropic/claude-sonnet-4.6',
        choices: [{ message: { content } }]
      })
    };
  };

  try {
    const result = await generateKdpPacket({
      penName: { key: 'sage-halcyon', display_name: 'Sage Halcyon' },
      genreConfig: {},
      book: { title: 'What the Night Keeps' },
      listing: { title: 'What the Night Keeps', blurbDraft: longSynopsis }
    });

    assert.equal(calls, 3);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.packet.description_options.length, 3);
    assert.match(result.packet.description_html, /She came to expose a system/);
    assert.doesNotMatch(result.packet.description_html, /Maren publishes the truth/);
    assert.ok(result.packet.description_html.length < longSynopsis.length);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenRouterKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalAnthropicKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }
});
