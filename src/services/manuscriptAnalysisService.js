import { generateWithLlm } from './llmClient.js';
import { parseJson } from '../utils.js';

const chunkSize = 42000;
const maxChunks = 16;

export async function analyzeManuscript({ text, book, penName, genreConfig, sourceName }) {
  const chunks = selectChunks(splitText(text, chunkSize), maxChunks);
  const chunkAnalyses = [];
  for (let index = 0; index < chunks.length; index += 3) {
    const batch = chunks.slice(index, index + 3);
    const results = await Promise.all(batch.map((chunk, offset) => analyzeChunk({
      chunk,
      index: index + offset,
      total: chunks.length,
      title: book?.title || sourceName
    })));
    chunkAnalyses.push(...results);
  }

  const system = `You are a rigorous fiction manuscript analyst preparing an evidence-based marketing brief. Separate what the manuscript proves from positioning suggestions. Return valid JSON only. Never invent tropes, relationship promises, endings, awards, reviews, or comparison titles.`;
  const prompt = `Consolidate these sequential manuscript analyses into one spoiler-aware marketing brief.

Book: ${book?.title || sourceName}
Pen name: ${penName?.display_name || 'Unassigned'}
Pen brand: ${penName?.brand_details || '{}'}
Existing genre configuration: ${JSON.stringify({
    voice: genreConfig?.voice_description || '',
    targetAudience: genreConfig?.target_audience || '',
    coreTropes: parseJson(genreConfig?.core_tropes, [])
  })}

Return this JSON shape exactly:
{
  "summary":"spoiler-light story summary",
  "positioning":{"primary":"","alternate":"","confidence":"high|medium|low","evidence":""},
  "genres":[{"value":"","confidence":"high|medium|low","evidence":""}],
  "tropes":[{"value":"","confidence":"high|medium|low","evidence":""}],
  "protagonists":"",
  "setting":"",
  "conflict":"",
  "stakes":"",
  "emotional_promise":{"value":"","confidence":"high|medium|low","evidence":""},
  "tone":{"value":"","confidence":"high|medium|low","evidence":""},
  "heat_darkness":{"value":"","confidence":"high|medium|low","evidence":""},
  "ending_type":{"value":"HEA|HFN|no HEA|not applicable|unclear","confidence":"high|medium|low","evidence":""},
  "target_reader":{"value":"","confidence":"high|medium|low","evidence":""},
  "differentiators":[""],
  "searchable_concepts":[""],
  "sensitive_elements":[""],
  "spoiler_boundary":"",
  "recommended_emphasis":"",
  "avoid_promises":[""],
  "uncertainties":["questions requiring author judgment"]
}

Chunk analyses:
${JSON.stringify(chunkAnalyses)}`;
  const result = await generateWithLlm({ system, prompt, maxTokens: 2800, timeoutMs: 90000 });
  if (result.provider !== 'claude') throw new Error('Add your Claude API key in Settings before analyzing a manuscript.');
  const brief = parseClaudeJson(result.text);
  if (!brief) throw new Error('Claude returned an unreadable manuscript brief. Please try the analysis again.');
  return {
    brief,
    provider: result.provider,
    chunksAnalyzed: chunks.length,
    coverage: splitText(text, chunkSize).length > maxChunks ? 'sampled across full manuscript' : 'full manuscript'
  };
}

export function effectiveManuscriptBrief(row) {
  const analysis = parseJson(row?.analysis_json, {});
  const review = parseJson(row?.review_json, {});
  return {
    ...analysis,
    ...review,
    source: {
      analysisId: row?.id,
      sourceName: row?.source_name,
      wordCount: row?.word_count,
      analyzedAt: row?.updated_at
    }
  };
}

async function analyzeChunk({ chunk, index, total, title }) {
  const system = 'Analyze fiction manuscript excerpts faithfully. Return valid JSON only. Do not write marketing copy yet and do not invent missing context.';
  const prompt = `Book: ${title}
Manuscript section ${index + 1} of ${total}.

Extract only evidence visible in this section. Return JSON with:
plot_events, characters, relationship_arc, setting, genre_signals, tropes, tone, heat_darkness, content_elements, ending_signals, hooks, searchable_concepts, and evidence.
Avoid quoting more than a short phrase. Mark ambiguity rather than guessing.

MANUSCRIPT SECTION:
${chunk}`;
  const result = await generateWithLlm({ system, prompt, maxTokens: 1100, timeoutMs: 90000 });
  if (result.provider !== 'claude') throw new Error('Add your Claude API key in Settings before analyzing a manuscript.');
  return parseClaudeJson(result.text) || { section: index + 1, analysis_error: 'Unreadable chunk analysis' };
}

function splitText(text, size) {
  const paragraphs = String(text || '').split(/\n{2,}/);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) {
      chunks.push(current);
      current = '';
    }
    if (paragraph.length > size) {
      for (let index = 0; index < paragraph.length; index += size) chunks.push(paragraph.slice(index, index + size));
    } else {
      current += `${current ? '\n\n' : ''}${paragraph}`;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

function selectChunks(chunks, limit) {
  if (chunks.length <= limit) return chunks;
  const indexes = new Set();
  for (let index = 0; index < limit; index += 1) {
    indexes.add(Math.round((index * (chunks.length - 1)) / (limit - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((index) => chunks[index]);
}

function parseClaudeJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/```json|```/gi, '').trim());
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
