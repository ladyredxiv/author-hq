import { generateWithLlm } from './llmClient.js';
import { escapeHtml, parseJson } from '../utils.js';
import { adultKdpCategoryWarning, filterAdultKdpCategories } from './kdpCategoryRules.js';
import { applyKdpPenTemplate, kdpPenTemplateFor } from './kdpPenTemplateService.js';

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
  const penTemplate = kdpPenTemplateFor(penName);
  const templatedFallback = applyKdpPenTemplate({ packet: fallback, penName, listing, manuscriptBrief });
  const baseline = sanitizePacket(templatedFallback || fallback);
  const prompt = buildPrompt({ penName, config, book, listing, categoryRows, fallback: baseline, manuscriptBrief, penTemplate });
  const system = `You are a senior fiction metadata copywriter specializing in ethical, conversion-focused Amazon KDP listings. Write specific copy that communicates reader promise, emotional stakes, subgenre, and differentiating hooks. Return only valid JSON matching the requested schema. Never invent plot facts, tropes, relationship outcomes, awards, reviews, bestseller claims, or named competitor comparisons.`;

  try {
    const result = await generateWithLlm({ system, prompt, maxTokens: 6200, timeoutMs: 120000 });
    if (!isLlmProvider(result.provider)) return { provider: result.provider, packet: baseline, prompt: result.text };
    const parsed = parsePacketJson(result.text);
    const candidate = sanitizePacket({
      ...baseline,
      ...parsed,
      warnings: mergeWarnings(
        baseline.warnings,
        parsed?.warnings,
        parsed ? [] : ['Claude\'s first packet response was incomplete; the quality-control pass rebuilt it.']
      )
    });
    const validated = await validateAndOptimizePacket({ candidate, manuscriptBrief, penName, listing });
    const generated = sanitizePacket(validated || candidate);
    const descriptionOptimized = await repairDescriptionIfNeeded({
      packet: generated,
      penName,
      book,
      listing,
      manuscriptBrief
    });
    const locked = penTemplate
      ? applyKdpPenTemplate({ packet: descriptionOptimized, penName, listing, manuscriptBrief, preserveGeneratedCopy: true })
      : descriptionOptimized;
    const keywordOptimized = await repairKeywordConstraints({
      packet: sanitizePacket(locked),
      penName,
      book,
      listing,
      manuscriptBrief
    });
    return {
      provider: result.provider,
      packet: sanitizePacket(keywordOptimized)
    };
  } catch (error) {
    return {
      provider: 'fallback',
      packet: { ...baseline, warnings: mergeWarnings(baseline.warnings, [`Claude generation failed: ${error.message}`]) }
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
    `Adult content: ${packet.adult_content ? 'Yes' : 'No'}`,
    `AI generated: ${packet.ai_disclosure?.ai_generated ? 'Yes' : 'No'}`,
    `AI assisted: ${packet.ai_disclosure?.ai_assisted ? 'Yes' : 'No'}`,
    `Language: ${packet.language || 'English'}`,
    `Reading age: ${packet.reading_age || '18+'}`,
    `Publication rights: ${packet.publication_rights || ''}`,
    '',
    'Author bio:',
    packet.author_bio || '',
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
  const sourceDescription = String(listing.blurbDraft || '').trim();
  const fallbackCopy = descriptionSourceKind(sourceDescription) === 'detailed synopsis'
    ? 'A detailed synopsis was supplied as source material. Claude must transform it into spoiler-safe KDP sales copy before publishing.'
    : sourceDescription || `A ${parseJson(penName?.brand_details, {}).genre || 'genre fiction'} story from ${penName?.display_name || 'this pen name'}.`;
  const description = [
    `<b>${escapeHtml(title)}</b>`,
    '',
    escapeHtml(fallbackCopy),
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

function buildPrompt({ penName, config, book, listing, categoryRows, fallback, manuscriptBrief, penTemplate = null }) {
  const descriptionSource = String(listing.blurbDraft || '').trim();
  const sourceKind = descriptionSourceKind(descriptionSource);
  const listingFacts = { ...listing, blurbDraft: descriptionSource ? `[Provided separately as ${sourceKind}]` : '' };
  const templateRules = penTemplate
    ? `A pen-name template is active. Treat these operational values in the fallback packet as immutable: format, title, price_usd, royalty_note, ku_enrolled, adult_content, ai_disclosure, reading_age, author_bio, and the adult-content footer at the end of description_html. Generate the creative metadata exactly as you would for any other pen name: seven highly specific, book-dependent keyword phrases with no fixed evergreen slots, three book-dependent categories, all three description options, category_strategy, and marketing_validation. The first category must be in the Romance family. Do not deliberately select any category containing "Erotica." Do not reuse generic template keywords when the supplied book details support more precise search language.`
    : 'No pen-name-specific locked template is active.';
  return `Generate a KDP listing packet as JSON only.

Required JSON fields:
format, title, subtitle, description_html, description_options, keywords, keyword_sets, keyword_notes, categories_suggested, category_strategy, price_usd, royalty_note, ku_enrolled, ai_disclosure, language, reading_age, publication_rights, marketing_validation, warnings.

Rules:
- Create 3 description_options: emotional, high-concept, and trope-forward. Each object has approach, description_html, and rationale.
- description_html: choose or combine the strongest option into a 180-350 word final description. Use KDP-safe limited HTML only (b, i, br), hook-first structure, specific emotional stakes, no spoilers beyond the supplied spoiler boundary, and a tension/reader-promise ending.
- The description source may be a detailed synopsis, rough notes, or an existing blurb. Treat it as factual source material, not paste-ready copy. Never reproduce a long synopsis wholesale.
- When the source includes the ending or resolution, use it only to understand the arc. Exclude resolution spoilers, protected identities, final choices, and sequel setup from the sales copy unless the author explicitly identifies them as reader-facing hooks.
- Compress detailed synopsis material into a genuine back-cover pitch: protagonist and desire, destabilizing relationship or conflict, escalating stakes, distinctive promise, and an open tension at the end.
- Avoid generic filler such as "a journey of self-discovery," "nothing is as it seems," and "will change everything" unless the manuscript evidence makes the wording specific.
- Create 2 keyword_sets: primary and alternate. Each object has label, keywords, and rationale. The primary set must exactly match keywords. Each set must independently follow every keyword rule below.
- keywords: exactly 7 natural search phrases, each at most 50 characters. Coordinate all seven slots as one set and use the available character space for useful, book-specific search intent without padding.
- No normalized word may appear in more than one phrase within a set. Do not repeat the same word across slots.
- Do not use words already present in any selected category label. Coordinate categories and keywords so each contributes different discovery language.
- Do not repeat title, series, pen name, competitor names, or unsupported tropes. No bestseller/award claims.
- categories_suggested: up to 3 objects with path, rating, rationale.
- categories_suggested must NOT include YA, Young Adult, Teen, Middle Grade, Juvenile, or Children's categories. Use adult-facing shelves only.
- category_strategy: object with summary and no_ads_plan array. Treat fortress categories as honest reader-fit shelves, not as a failure. Do not recommend misleading categories just because they are easier. Explain how keywords, description positioning, cover promise, KU/series behavior, newsletter/website/social traffic should support discoverability when categories are fortress.
- warnings must include review-before-use and AI disclosure confirmation.
- ${templateRules}

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
Listing inputs: ${JSON.stringify(listingFacts)}
Description source type: ${sourceKind}
DESCRIPTION SOURCE MATERIAL:
${descriptionSource || 'No manual description source supplied.'}
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
- Treat all seven slots as one coordinated vocabulary. No normalized word may appear in more than one keyword phrase.
- No keyword word may appear in any selected category label. Categories and keywords must carry different useful terms.
- Each keyword phrase must be at most 50 characters. Do not use title, series, pen name, named competitors, or unsupported claims.
- Apply the same no-duplicate and no-category-word rules independently to each keyword_set. The primary keyword_set must match the final keywords exactly.
- Maintain adult-only category restrictions.
- marketing_validation must contain accuracy, spoiler_safety, positioning_strength, keyword_coverage, changes_made array, and warnings array.
- Return the complete packet JSON, not commentary.

Pen name: ${penName?.display_name || 'Unassigned'}
Author inputs: ${JSON.stringify(listing)}
Manuscript brief: ${JSON.stringify(manuscriptBrief || { available: false })}
Candidate packet: ${JSON.stringify(candidate)}`;
  try {
    const result = await generateWithLlm({ system, prompt, maxTokens: 6200, timeoutMs: 120000 });
    if (!isLlmProvider(result.provider)) return candidate;
    const parsed = parsePacketJson(result.text);
    return parsed || {
      ...candidate,
      warnings: mergeWarnings(candidate.warnings, ['Claude\'s packet quality-control response was incomplete; focused repair may be required.'])
    };
  } catch (error) {
    return { ...candidate, warnings: mergeWarnings(candidate.warnings, [`Marketing validation pass failed: ${error.message}`]) };
  }
}

async function repairDescriptionIfNeeded({ packet, penName, book, listing, manuscriptBrief }) {
  const source = String(listing?.blurbDraft || '').trim();
  if (!descriptionNeedsRepair(packet, source)) return packet;
  const system = `You are a senior fiction back-cover copywriter. Transform source material into accurate, spoiler-safe Amazon KDP sales copy. Return valid JSON only.`;
  const prompt = `Create the description portion of a KDP packet from the supplied ${descriptionSourceKind(source)}.

Return exactly:
{"description_html":"final 180-350 word KDP description","description_options":[{"approach":"emotional","description_html":"...","rationale":"..."},{"approach":"high-concept","description_html":"...","rationale":"..."},{"approach":"trope-forward","description_html":"...","rationale":"..."}]}

Requirements:
- Transform and compress the source. Do not paste, lightly edit, or summarize it paragraph by paragraph.
- Each option must be genuine sales copy with a hook, clear character/relationship promise, escalating stakes, and an open tension.
- The final description_html must be 180-350 words and select or combine the strongest option.
- Use only KDP-safe b, i, and br tags.
- Preserve factual accuracy while withholding the ending, final solution, protected identities, resolution mechanics, and sequel setup.
- Do not invent tropes, outcomes, quotations, reviews, awards, or competitor comparisons.

Pen name: ${penName?.display_name || 'Unassigned'}
Book record: ${JSON.stringify(book || {})}
Listing facts: ${JSON.stringify({ ...listing, blurbDraft: '[supplied below]' })}
Reviewed manuscript brief: ${JSON.stringify(manuscriptBrief || {})}

SOURCE MATERIAL:
${source || plainTextFromHtml(packet.description_html)}`;
  try {
    const result = await generateWithLlm({ system, prompt, maxTokens: 4200, timeoutMs: 120000 });
    if (!isLlmProvider(result.provider)) {
      return { ...packet, warnings: mergeWarnings(packet.warnings, ['Description still needs Claude transformation; no LLM provider was available for the focused repair.']) };
    }
    const parsed = parsePacketJson(result.text);
    if (!parsed?.description_html || !Array.isArray(parsed.description_options) || parsed.description_options.length < 3) {
      return { ...packet, warnings: mergeWarnings(packet.warnings, ['Claude returned an incomplete focused blurb revision. Regenerate this packet before using the description.']) };
    }
    return sanitizePacket({
      ...packet,
      description_html: parsed.description_html,
      description_options: parsed.description_options,
      warnings: mergeWarnings(packet.warnings, ['Long synopsis/notes were transformed into KDP sales copy; verify spoiler boundaries before publishing.'])
    });
  } catch (error) {
    return { ...packet, warnings: mergeWarnings(packet.warnings, [`Focused blurb generation failed: ${error.message}`]) };
  }
}

export function descriptionNeedsRepair(packet, source = '') {
  const outputWords = wordCount(plainTextFromHtml(packet?.description_html));
  const sourceIsDetailed = descriptionSourceKind(source) === 'detailed synopsis';
  const missingOptions = !Array.isArray(packet?.description_options) || packet.description_options.length < 3;
  return missingOptions || outputWords > 400 || (sourceIsDetailed && (outputWords > 375 || descriptionCopiesSource(packet?.description_html, source)));
}

export function descriptionSourceKind(value) {
  const text = String(value || '').trim();
  return wordCount(text) >= 220 || text.length >= 1400 ? 'detailed synopsis' : text ? 'rough notes or existing blurb' : 'no manual source';
}

function plainTextFromHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function descriptionCopiesSource(description, source) {
  const sourceWords = plainTextFromHtml(source).toLowerCase().split(/\s+/).filter(Boolean);
  const output = plainTextFromHtml(description).toLowerCase();
  if (sourceWords.length < 54 || !output) return false;
  const windowSize = 18;
  const starts = [0, Math.floor(sourceWords.length / 3), Math.floor((sourceWords.length * 2) / 3)];
  return starts.some((start) => output.includes(sourceWords.slice(start, start + windowSize).join(' ')));
}

async function repairKeywordConstraints({ packet, penName, book, listing, manuscriptBrief }) {
  const issues = keywordConstraintIssues(packet);
  if (!issues.length) return packet;
  const system = `You are a precision Amazon KDP keyword editor. Return valid JSON only. Repair keyword metadata without changing the book facts or categories.`;
  const prompt = `Repair only the keyword metadata for this KDP packet.

Return exactly:
{"keywords":["7 phrases"],"keyword_sets":[{"label":"Primary","keywords":["same 7 phrases"],"rationale":"..."},{"label":"Alternate","keywords":["7 alternate phrases"],"rationale":"..."}],"keyword_notes":"..."}

Hard rules for each seven-phrase set:
- Exactly 7 natural, book-specific search phrases.
- Every phrase is 50 characters or fewer.
- No normalized word appears more than once anywhere within the set, including repeated words inside one phrase.
- No word used in the category labels may appear in a keyword phrase.
- Do not use words from the title, series, or pen name.
- Do not use category names, competitor names, vague filler, unsupported tropes, bestseller claims, or keyword stuffing.
- The Primary set must exactly match keywords. The Alternate set must follow the same constraints independently.
- Use distinct search intents across slots: relationship dynamic, character archetype, setting, emotional promise, tone, plot hook, and reading experience where supported.

Current constraint problems:
${issues.map((issue) => `- ${issue}`).join('\n')}

Categories whose words are unavailable:
${(packet.categories_suggested || []).map((category) => `- ${category.path || category}`).join('\n')}

Pen name: ${penName?.display_name || 'Unassigned'}
Book: ${JSON.stringify(book || {})}
Listing inputs: ${JSON.stringify(listing || {})}
Manuscript brief: ${JSON.stringify(manuscriptBrief || {})}
Current keywords: ${JSON.stringify(packet.keywords || [])}
Current keyword sets: ${JSON.stringify(packet.keyword_sets || [])}`;
  try {
    const result = await generateWithLlm({ system, prompt, maxTokens: 2200, timeoutMs: 90000 });
    if (!isLlmProvider(result.provider)) {
      return { ...packet, warnings: mergeWarnings(packet.warnings, [`Keyword constraints still need review: ${issues.join('; ')}`]) };
    }
    const parsed = parsePacketJson(result.text) || {};
    const repaired = sanitizePacket({
      ...packet,
      keywords: parsed.keywords || packet.keywords,
      keyword_sets: parsed.keyword_sets || packet.keyword_sets,
      keyword_notes: parsed.keyword_notes || packet.keyword_notes
    });
    const remaining = keywordConstraintIssues(repaired);
    return remaining.length
      ? { ...repaired, warnings: mergeWarnings(repaired.warnings, [`Claude's keyword repair still needs review: ${remaining.join('; ')}`]) }
      : repaired;
  } catch (error) {
    return { ...packet, warnings: mergeWarnings(packet.warnings, [`Keyword repair failed: ${error.message}`]) };
  }
}

export function keywordConstraintIssues(packet) {
  const categoryWords = new Set(
    (packet.categories_suggested || [])
      .flatMap((category) => keywordWords(category?.path || category))
      .filter((word) => !categoryBoilerplateWords.has(word))
  );
  const sets = [{ label: 'Final keywords', keywords: packet.keywords || [] }];
  (packet.keyword_sets || []).forEach((set, index) => {
    sets.push({ label: set.label || `Keyword set ${index + 1}`, keywords: set.keywords || [] });
  });
  const issues = [];
  for (const set of sets) {
    if (set.keywords.length !== 7) issues.push(`${set.label} has ${set.keywords.length} slots instead of 7`);
    const usedWords = new Set();
    set.keywords.forEach((phrase, index) => {
      const value = String(phrase || '').trim();
      if (!value) issues.push(`${set.label} slot ${index + 1} is empty`);
      if (value.length > 50) issues.push(`${set.label} slot ${index + 1} is ${value.length} characters`);
      for (const word of keywordWords(value)) {
        if (categoryWords.has(word)) issues.push(`${set.label} slot ${index + 1} repeats category word "${word}"`);
        if (usedWords.has(word)) issues.push(`${set.label} repeats word "${word}"`);
        usedWords.add(word);
      }
    });
  }
  return [...new Set(issues)];
}

const categoryBoilerplateWords = new Set(['kindle', 'store', 'ebook', 'ebooks', 'book', 'books', 'literature', 'fiction', 'and', 'the', 'of', 'for', 'in', 'on', 'with', 'to', 'a', 'an']);

function keywordWords(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function isLlmProvider(provider) {
  return provider === 'claude' || provider === 'openrouter';
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
  const source = String(text || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(source);
  } catch {
    const firstBrace = source.indexOf('{');
    const lastBrace = source.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(source.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
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
