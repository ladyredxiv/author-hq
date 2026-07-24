import test from 'node:test';
import assert from 'node:assert/strict';
import { applyKdpPenTemplate, kdpPenTemplateFor } from '../src/services/kdpPenTemplateService.js';

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
  assert.match(packet.categories_suggested[1].path, /> Dark$/);
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

  assert.match(packet.categories_suggested[1].path, /> Romantic$/);
  assert.equal(packet.keywords[1], 'steamy M/F erotica romance');
  assert.equal(packet.keywords[5], 'steamy adult romance explicit');
});

test('does not apply Ana rules to another pen name', () => {
  assert.equal(applyKdpPenTemplate({
    packet: basePacket,
    penName: { key: 'sage-halcyon', display_name: 'Sage Halcyon' }
  }), null);
});
