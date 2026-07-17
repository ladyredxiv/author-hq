import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveManuscriptBrief } from '../src/services/manuscriptAnalysisService.js';

test('author review overrides inferred manuscript positioning', () => {
  const row = {
    id: 7,
    source_name: 'novel.docx',
    word_count: 70000,
    updated_at: '2026-07-11',
    analysis_json: JSON.stringify({
      positioning: { primary: 'Fantasy-first', confidence: 'medium' },
      tropes: [{ value: 'found family', confidence: 'high' }],
      summary: 'An inferred summary.'
    }),
    review_json: JSON.stringify({
      positioning: { primary: 'Romance-first', confidence: 'author confirmed' },
      reviewer_notes: 'Lead with the relationship.'
    })
  };
  const brief = effectiveManuscriptBrief(row);
  assert.equal(brief.positioning.primary, 'Romance-first');
  assert.equal(brief.summary, 'An inferred summary.');
  assert.equal(brief.source.analysisId, 7);
});
