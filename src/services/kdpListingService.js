import { generateWithLlm } from './llmClient.js';
import { escapeHtml, parseJson } from '../utils.js';
import { adultKdpCategoryWarning, filterAdultKdpCategories } from './kdpCategoryRules.js';

export async function generateKdpPacket({ penName, genreConfig, book, listing, categoryRows = [], manuscriptBrief = null }) {
  const config = normalizeConfig(genreConfig);
  const title = listing.title || book?.title || 'Untitled Book';
  const subtitle = listing.subtitle || '';
  const warnings = [
    'Description is a draft - review before pasting into KDP.',
    'Confirm AI disclosure before publishing.',
    'Categories are suggestions only; verify live KDP dropdown/category availability before publishing.',
    adultKdpCategoryWarning
  ];
  if (config.status === 'draft') warnings.push('This pen name KDP genre config is still marked draft.');
  if ((config.categoryStrategyNotes || '').toLowerCase().includes('open question')) warnings.push(config.categoryStrategyNotes);
  if (title.length + (subtitle ? subtitle.length + 3 : 0) > 200) warnings.push('KDP title + subtitle limit is 200 characters; shorten before publishing.');

  const fallback = fallbackPacket({ penName, config, book, listing, categoryRows, warnings, manuscriptBrief });
  const prompt = buildPrompt({ penName, config, book, listing, categoryRows, fallback, manuscriptBrief });
  const system = `You are a senior fiction metadata copywriter specializing in ethical, conversion-focused Amazon KDP listings. Write specific copy that communicates reader promise, emotional stakes, subgenre, and differentiating hooks. Return only valid JSON matching the requested schema. Never invent plot facts, tropes, relationship outcomes, awards, reviews, bestseller claims, or named competitor comparisons.`;

  try {
    const result = await generateWithLlm({ system, prompt, maxTokens: 3600, timeoutMs: 90000 });
    if (result.provider !== 'claude') return { provider: result.provider, packet: fallback, prompt: result.text };
    const parsed = parsePacketJson(result.text);
    const candidate = sanitizePacket({ ...fallback, ...parsed, warnings: mergeWarnings(warnings, parsed?.warnings) });
    const validated = await validateAndOptimizePacket({ candidate, manuscriptBrief, penName, listing });
    return {
      provider: result.provider,
      packet: sanitizePacket(validated || candidate)
    };
  } catch (error) {
    return {
      provider: 'fallback',
      packet: { ...fallback, warnings: mergeWarnings(warnings, [`Claude generation failed: ${error.message}`]) }
    };
  }
}

export function packetToFlatText(packet) {
  const lines = [
    `Format: ${packet.format}`,
    `Title: ${packet.title}`,
    `Subtitle: ${packet.subtitle || ''}`,
    '',
    'Description HTML:',
    packet.description_html || '',
    '',
    'Description options:',
    ...(packet.description_options || []).flatMap((option, index) => [
      `${index + 1}. ${option.approach}`,
      option.description_html || '',
      option.rationale ? `Why: ${option.rationale}` : '',
      ''
    ]),
    'Keywords:',
    ...(packet.keywords || []).map((keyword, index) => `${index + 1}. ${keyword}`),
    '',
    `Keyword notes: ${packet.keyword_notes || ''}`,
    '',
    'Alternate keyword sets:',
    ...(packet.keyword_sets || []).flatMap((set) => [
      `${set.label}: ${(set.keywords || []).join(' | ')}`,
      set.rationale || ''
    ]),
    '',
    'Suggested categories:',
    ...(packet.categories_suggested || []).map((category, index) => `${index + 1}. ${category.path} [${category.rating || 'Unrated'}] - ${category.rationale || ''}`),
    '',
    'Category strategy:',
    packet.category_strategy?.summary || '',
    ...(packet.category_strategy?.no_ads_plan || []).map((item) => `- ${item}`),
    '',
    `Price USD: ${packet.price_usd}`,
    `Royalty note: ${packet.royalty_note || ''}`,
    `KDP Select / KU: ${packet.ku_enrolled ? 'Yes' : 'No'}`,
    `AI generated: ${packet.ai_disclosure?.ai_generated ? 'Yes' : 'No'}`,
    `AI assisted: ${packet.ai_disclosure?.ai_assisted ? 'Yes' : 'No'}`,
    `Language: ${packet.language || 'English'}`,
    `Reading age: ${packet.reading_age || '18+'}`,
    `Publication rights: ${packet.publication_rights || ''}`,
    '',
    'Warnings:',
    ...(packet.warnings || []).map((warning) => `- ${warning}`),
    '',
    'Marketing validation:',
    JSON.stringify(packet.marketing_validation || {}, null, 2),
    '',
    'Manual steps remaining:',
    '1. Log into KDP and create the title manually.',
    '2. Upload manuscript and cover files.',
    '3. Paste in each generated field.',
    '4. Run the KDP Previewer check.',
    '5. Confirm AI disclosure toggles match this packet.',
    '6. Hit Publish.'
  ];
  return lines.join('\n');
}

function fallbackPacket({ penName, config, book, listing, categoryRows, warnings, manuscriptBrief }) {
  const title = listing.title || book?.title || 'Untitled Book';
  const price = Number(listing.priceUsd || config.defaultPriceUsd || 4.99);
  const categories = suggestedCategories(config, categoryRows);
  const briefTropes = factList(manuscriptBrief?.tropes);
  const briefConcepts = listValue(manuscriptBrief?.searchable_concepts);
  const tropes = briefTropes.length ? briefTropes : config.coreTropes.length ? config.coreTropes : [parseJson(penName?.brand_details, {}).genre || 'fiction'];
  const description = [
    `<b>${escapeHtml(title)}</b>`,
    '',
    escapeHtml(listing.blurbDraft || `A ${parseJson(penName?.brand_details, {}).genre || 'genre fiction'} story from ${penName?.display_name || 'this pen name'}.`),
    '',
    '<i>Review this draft description before publishing.</i>'
  ].join('<br><br>');

  return sanitizePacket({
    format: listing.format || 'ebook',
    title,
    subtitle: listing.subtitle || '',
    series_info: {
      series_name: listing.seriesName || book?.series || '',
      series_number: listing.seriesNumber || ''
    },
    description_html: description,
    keywords: keywordFallback([...briefConcepts, ...config.keywordStarterList], tropes),
    keyword_notes: keywordStrategyNote(config.keywordStarterList),
    categories_suggested: categories,
    category_strategy: categoryStrategy(categories, config, listing),
    price_usd: price,
    royalty_note: price >= 2.99 && price <= 9.99 ? 'Within 70% royalty band.' : 'Outside $2.99-$9.99 70% royalty band; KDP may apply 35% royalty.',
    ku_enrolled: Boolean(Number(listing.kuEnrolled ?? config.defaultKuEnrolled ?? 0)),
    ai_disclosure: {
      ai_generated: Boolean(Number(listing.aiGenerated ?? config.aiGeneratedDefault ?? 0)),
      ai_assisted: Boolean(Number(listing.aiAssisted ?? config.aiAssistedDefault ?? 1))
    },
    language: listing.language || 'English',
    reading_age: listing.readingAge || '18+',
    publication_rights: listing.publicationRights || 'I own the copyright and hold necessary publishing rights',
    warnings,
    description_options: [],
    keyword_sets: [],
    marketing_validation: { status: manuscriptBrief ? 'awaiting Claude validation' : 'manual-input validation only' }
  });
}

function buildPrompt({ penName, config, book, listing, categoryRows, fallback, manuscriptBrief }) {
  return `Generate a KDP listing packet as JSON only.

Required JSON fields:
format, title, subtitle, description_html, description_options, keywords, keyword_sets, keyword_notes, categories_suggested, category_strategy, price_usd, royalty_note, ku_enrolled, ai_disclosure, language, reading_age, publication_rights, marketing_validation, warnings.

Rules:
- Create 3 description_options: emotional, high-concept, and trope-forward. Each object has approach, description_html, and rationale.
- description_html: choose or combine the strongest option into a 180-350 word final description. Use KDP-safe limited HTML only (b, i, br), hook-first structure, specific emotional stakes, no spoilers beyond the supplied spoiler boundary, and a tension/reader-promise ending.
- Avoid generic filler such as "a journey of self-discovery," "nothing is as it seems," and "will change everything" unless the manuscript evidence makes the wording specific.
- Create 2 keyword_sets: primary and alternate. Each object has label, keywords, and rationale.
- keywords: exactly 7 natural search phrases, each under 50 characters. Cover distinct reader intents rather than repeating the same roots. Do not repeat title, series, pen name, category names, competitor names, or unsupported tropes. No bestseller/award claims.
- categories_suggested: up to 3 objects with path, rating, rationale.
- categories_suggested must NOT include YA, Young Adult, Teen, Middle Grade, Juvenile, or Children's categories. Use adult-facing shelves only.
- category_strategy: object with summary and no_ads_plan array. Treat fortress categories as honest reader-fit shelves, not as a failure. Do not recommend misleading categories just because they are easier. Explain how keywords, description positioning, cover promise, KU/series behavior, newsletter/website/social traffic should support discoverability when categories are fortress.
- warnings must include review-before-use and AI disclosure confirmation.

Pen name: ${penName?.display_name || 'Unassigned'}
Pen brand: ${JSON.stringify(parseJson(penName?.brand_details, {}))}
KDP config status: ${config.status}
Voice: ${config.voiceDescription}
Core tropes: ${config.coreTropes.join(', ')}
Target audience: ${config.targetAudience}
Keyword starter list: ${config.keywordStarterList.join(', ')}
Category strategy notes: ${config.categoryStrategyNotes}
Verified category candidates: ${JSON.stringify(config.verifiedCategories)}
Workbook category matches: ${JSON.stringify(categoryRows.slice(0, 12))}

Book record: ${JSON.stringify(book || {})}
Listing inputs: ${JSON.stringify(listing)}
Reviewed manuscript brief (factual boundary; author-reviewed values override other guesses):
${JSON.stringify(manuscriptBrief || { available: false })}

Use this as a fallback shape if any field is underspecified:
${JSON.stringify(fallback, null, 2)}`;
}

async function validateAndOptimizePacket({ candidate, manuscriptBrief, penName, listing }) {
  const system = `You are the final quality-control editor for an Amazon KDP fiction listing. Return valid JSON only. Preserve factual accuracy, strengthen specific marketing language, and remove unsupported promises. The manuscript brief is the factual boundary.`;
  const prompt = `Audit and improve this candidate KDP packet.

Validation requirements:
- Every plot, trope, relationship, tone, heat/darkness, and ending implication must be supported by the manuscript brief or explicit author inputs.
- Keep descriptions spoiler-safe and aligned to the brief's spoiler boundary.
- Select the strongest final description_html while preserving all 3 description_options.
- Final keywords must contain exactly 7 distinct phrases under 50 characters each.
- Keywords should span subgenre, emotional promise, relationship/trope, setting, tone, and distinctive hook where accurate.
- Remove repeated roots when they waste a slot. Do not use title, series, pen name, named competitors, category labels, or unsupported claims.
- Maintain adult-only category restrictions.
- marketing_validation must contain accuracy, spoiler_safety, positioning_strength, keyword_coverage, changes_made array, and warnings array.
- Return the complete packet JSON, not commentary.

Pen name: ${penName?.display_name || 'Unassigned'}
Author inputs: ${JSON.stringify(listing)}
Manuscript brief: ${JSON.stringify(manuscriptBrief || { available: false })}
Candidate packet: ${JSON.stringify(candidate)}`;
  try {
    const result = await generateWithLlm({ system, prompt, maxTokens: 4000, timeoutMs: 90000 });
    if (result.provider !== 'claude') return candidate;
    return parsePacketJson(result.text) || candidate;
  } catch (error) {
    return { ...candidate, warnings: mergeWarnings(candidate.warnings, [`Marketing validation pass failed: ${error.message}`]) };
  }
}

function normalizeConfig(row) {
  return {
    status: row?.status || 'draft',
    voiceDescription: row?.voice_description || '',
    coreTropes: parseJson(row?.core_tropes, []),
    targetAudience: row?.target_audience || '',
    verifiedCategories: parseJson(row?.verified_categories, []),
    keywordStarterList: parseJson(row?.keyword_starter_list, []),
    categoryStrategyNotes: row?.category_strategy_notes || '',
    defaultPriceUsd: Number(row?.default_price_usd || 4.99),
    defaultKuEnrolled: Number(row?.default_ku_enrolled || 0),
    aiGeneratedDefault: Number(row?.ai_generated_default || 0),
    aiAssistedDefault: Number(row?.ai_assisted_default || 1)
  };
}

function suggestedCategories(config, categoryRows) {
  const selected = [];
  for (const category of filterAdultKdpCategories(config.verifiedCategories)) {
    const match = categoryRows.find((row) => pathsSimilar(row.path, category.path));
    const rating = match?.overall_rating || category.rating || 'Unrated';
    selected.push({
      path: match?.path || category.path,
      rating,
      rationale: categoryRationale(category.notes || 'Matches the pen name category strategy.', selected.length, rating)
    });
    if (selected.length === 3) break;
  }
  if (selected.length) return selected;
  return filterAdultKdpCategories(categoryRows).slice(0, 3).map((row) => ({
    path: row.path,
    rating: row.overall_rating || 'Unrated',
    rationale: categoryRationale('Closest local category workbook match.', 0, row.overall_rating)
  }));
}

function keywordFallback(starters, tropes) {
  const combined = [...starters, ...tropes.map((trope) => `${trope} book`)]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const out = [];
  for (const value of combined) {
    const trimmed = value.slice(0, 50);
    if (!out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) out.push(trimmed);
    if (out.length === 7) break;
  }
  while (out.length < 7) out.push(`genre fiction ${out.length + 1}`);
  return out;
}

function parsePacketJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

function sanitizePacket(packet) {
  const safeCategories = filterAdultKdpCategories(packet.categories_suggested || []);
  const removedAudienceCategory = safeCategories.length !== (packet.categories_suggested || []).length;
  const strategy = normalizeCategoryStrategy(packet.category_strategy, safeCategories, packet.keywords || []);
  const fortressOnly = safeCategories.length > 0 && safeCategories.every((category) => isFortress(category.rating));
  return {
    ...packet,
    keywords: (packet.keywords || []).slice(0, 7).map((keyword) => String(keyword).slice(0, 50)),
    description_options: normalizeDescriptionOptions(packet.description_options),
    keyword_sets: normalizeKeywordSets(packet.keyword_sets),
    categories_suggested: safeCategories.slice(0, 3),
    category_strategy: strategy,
    warnings: mergeWarnings(
      packet.warnings?.length ? packet.warnings : ['Review before publishing.'],
      removedAudienceCategory ? ['Removed one or more YA/children category suggestions from this packet.'] : [],
      fortressOnly ? ['All suggested categories are high-competition/fortress. That is acceptable when they are the most honest adult shelves; use keywords and page positioning for niche discoverability.'] : [],
      [adultKdpCategoryWarning]
    )
  };
}

function normalizeDescriptionOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, 3).map((option, index) => ({
    approach: String(option?.approach || ['emotional', 'high-concept', 'trope-forward'][index] || `option-${index + 1}`),
    description_html: String(option?.description_html || ''),
    rationale: String(option?.rationale || '')
  }));
}

function normalizeKeywordSets(sets) {
  if (!Array.isArray(sets)) return [];
  return sets.slice(0, 2).map((set, index) => ({
    label: String(set?.label || (index ? 'Alternate' : 'Primary')),
    keywords: (set?.keywords || []).slice(0, 7).map((keyword) => String(keyword).slice(0, 50)),
    rationale: String(set?.rationale || '')
  }));
}

function factList(value) {
  return listValue(value).map((item) => typeof item === 'object' && item ? item.value || item.primary || '' : String(item || '')).filter(Boolean);
}

function listValue(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function categoryRationale(base, index, rating) {
  const role = ['Primary reader-fit shelf', 'Complementary adult shelf', 'Strategic association shelf'][index] || 'Reader-fit shelf';
  const competition = isFortress(rating)
    ? ' This is high-competition, so it should be chosen for accuracy and reader expectation, not because it is likely to rank easily.'
    : '';
  return `${role}: ${base}${competition}`;
}

function categoryStrategy(categories, config, listing) {
  const allFortress = categories.length > 0 && categories.every((category) => isFortress(category.rating));
  const nicheTerms = [...config.keywordStarterList, ...(config.coreTropes || [])].slice(0, 8);
  return {
    summary: allFortress
      ? 'Accuracy-first strategy: these categories may be fortress/high-competition, but they are still the correct adult reader-fit shelves. Do not swap into misleading easy categories; make discovery happen through keywords, description positioning, cover promise, and warm traffic.'
      : 'Accuracy-first strategy: choose adult categories that honestly match reader expectations, then use keywords and page positioning to carry the niche signal.',
    no_ads_plan: [
      `Use keyword slots to say the specific promise plainly: ${nicheTerms.join(', ') || 'genre-specific reader promise'}.`,
      'Make the first description paragraph name the emotional promise and subgenre, not just the plot.',
      'Keep cover, subtitle, and trope language aligned so cold browsers immediately know what kind of book this is.',
      'Use website/newsletter/social traffic as the launch engine; do not depend on category rank for first discovery.',
      'If this is part of a series, make the series path obvious in back matter, website JSON, and Author Central.'
    ],
    avoid: 'Do not choose YA, middle grade, children, or inaccurate low-competition shelves just to escape fortress categories.',
    manual_review: listing.targetCategories ? 'Manual category override supplied; verify every override is adult-facing and truthful before publishing.' : 'Verify live KDP category availability before publishing.'
  };
}

function normalizeCategoryStrategy(strategy, categories, keywords) {
  if (strategy && typeof strategy === 'object' && strategy.summary) {
    return {
      summary: String(strategy.summary),
      no_ads_plan: Array.isArray(strategy.no_ads_plan) ? strategy.no_ads_plan.map(String) : [],
      avoid: strategy.avoid ? String(strategy.avoid) : 'Do not use misleading categories.',
      manual_review: strategy.manual_review ? String(strategy.manual_review) : 'Verify categories before publishing.'
    };
  }
  return {
    summary: categories.length && categories.every((category) => isFortress(category.rating))
      ? 'Accuracy-first strategy: all suggested categories are fortress/high-competition, so use them as honest reader-fit shelves and rely on metadata plus warm traffic for discovery.'
      : 'Accuracy-first strategy: categories should match reader expectations; keywords and page positioning carry the niche signal.',
    no_ads_plan: [
      `Anchor keyword slots around: ${keywords.slice(0, 5).join(', ') || 'the exact subgenre promise'}.`,
      'Lead the description with the emotional/subgenre promise.',
      'Keep cover, subtitle, and trope language tightly aligned.'
    ],
    avoid: 'Do not choose YA, middle grade, children, or inaccurate low-competition shelves just to escape fortress categories.',
    manual_review: 'Verify live KDP category availability before publishing.'
  };
}

function keywordStrategyNote(starters) {
  return `Use keywords as the niche discoverability layer because accurate adult categories may be fortress/high-competition. Starter phrases: ${starters.slice(0, 7).join(', ') || 'add genre-specific phrases'}.`;
}

function isFortress(value) {
  return String(value || '').trim().toLowerCase() === 'fortress';
}

function mergeWarnings(...sets) {
  return [...new Set(sets.flat().filter(Boolean).map(String))];
}

function pathsSimilar(a, b) {
  return String(a || '').toLowerCase().includes(String(b || '').toLowerCase()) ||
    String(b || '').toLowerCase().includes(String(a || '').toLowerCase());
}
