import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml } from '../utils.js';

export function applyKdpPenTemplate({ packet, penName, listing = {}, manuscriptBrief = null, preserveGeneratedCopy = false }) {
  const template = kdpPenTemplateFor(penName);
  if (!template) return null;

  const project = manuscriptBrief?.project_metadata || {};
  const tropes = normalizedList(project.tropes || manuscriptBrief?.tropes);
  const kinkProfile = normalizedList(project.kinkProfile || project.kink_profile);
  const tropeKeyword = keywordFromRules(tropes, template.tropeKeywordRules, template.defaultTropeKeyword);
  const kinkKeyword = keywordFromRules(kinkProfile.slice(0, 1), template.kinkKeywordRules, template.defaultKinkKeyword);
  const keywords = [
    template.fixedKeywords?.['1'],
    tropeKeyword,
    template.fixedKeywords?.['3'],
    template.fixedKeywords?.['4'],
    template.fixedKeywords?.['5'],
    kinkKeyword,
    template.fixedKeywords?.['7']
  ].map((value) => String(value || '').slice(0, 50));
  const categoryTwo = anaCategoryTwo(template, project, tropes);
  const categories = [
    {
      path: template.categories.fixed,
      rating: 'Unrated',
      rationale: 'Required primary Ana Rourke Romance category.'
    },
    {
      path: categoryTwo,
      rating: 'Unrated',
      rationale: categoryTwo === template.categories.dark
        ? 'Dark Romance shelf selected from the project heat and trope metadata.'
        : 'Alpha Male Romance shelf selected for the standard Ana Rourke reader promise.'
    }
  ];
  const sourceBlurb = preserveGeneratedCopy
    ? ''
    : String(manuscriptBrief?.kdp_blurb || listing.blurbDraft || '').trim();
  const description = appendDescriptionFooter(
    sourceBlurb ? plainTextToKdpHtml(sourceBlurb) : packet.description_html,
    template.descriptionFooter
  );
  const warnings = [
    ...(packet.warnings || []),
    'Ana Rourke locked packet template applied.',
    !manuscriptBrief?.project_metadata ? 'No project.json metadata was detected; Romantic and default dynamic keywords were used where needed.' : '',
    !manuscriptBrief?.kdp_blurb ? 'No sessions/kdp-blurb.md was detected; review the fallback description carefully.' : '',
    'Create or use Ana Rourke\'s separate Author Central account after the first title is published.'
  ].filter(Boolean);

  return {
    ...packet,
    template_key: 'ana-rourke',
    format: template.format || 'ebook',
    title: String(project.title || listing.title || packet.title || 'Untitled Book'),
    description_html: description,
    description_options: preserveGeneratedCopy ? packet.description_options || [] : [],
    keywords,
    keyword_sets: [{
      label: 'Ana Rourke required slots',
      keywords,
      rationale: 'Evergreen slots are fixed; trope and kink slots come from project.json.'
    }],
    keyword_notes: 'Fields 1, 3, 4, 5, and 7 are fixed. Field 2 follows trope priority; field 6 uses the primary kink profile.',
    categories_suggested: categories,
    category_strategy: {
      summary: 'Use Romance > Contemporary first, then Alpha Male or Dark Romance based on the project metadata.',
      no_ads_plan: [
        'Keep all seven keyword fields aligned to the short, explicit M/F reader promise.',
        'Use KDP Select and consistent weekly catalog releases as the discovery engine.'
      ],
      avoid: 'Do not deliberately select Erotica or youth-facing categories, anatomical keyword language, competitor names, or unrelated low-competition shelves.',
      manual_review: 'Verify both category paths in the live KDP picker before publishing.'
    },
    price_usd: Number(template.priceUsd),
    royalty_note: '$2.99 is within the 70% ebook royalty band. Do not launch below $2.99 or above $3.99 for this short-fiction template.',
    ku_enrolled: Boolean(template.kuEnrolled),
    adult_content: Boolean(template.adultContent),
    ai_disclosure: {
      ai_generated: Boolean(template.aiGenerated),
      ai_assisted: Boolean(template.aiAssisted)
    },
    reading_age: template.readingAge || '18+',
    author_bio: template.authorBio || '',
    warnings: [...new Set(warnings)],
    marketing_validation: {
      ...(packet.marketing_validation || {}),
      template: 'Ana Rourke',
      project_metadata_used: Boolean(manuscriptBrief?.project_metadata),
      supplied_blurb_used: Boolean(manuscriptBrief?.kdp_blurb),
      fixed_fields_locked: true
    }
  };
}

export function kdpPenTemplateFor(penName) {
  const key = String(penName?.key || penName?.display_name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return loadTemplates()[key] || null;
}

function anaCategoryTwo(template, project, tropes) {
  const heat = String(project.heatLevel || project.heat_level || '').trim().toLowerCase();
  const darkTrigger = truthy(project.cncPresent ?? project.cnc_present) ||
    tropes.some((trope) => ['dark-romance', 'dark romance'].includes(trope));
  if (heat === 'dark' || darkTrigger) return template.categories.dark;
  return template.categories.romantic;
}

function keywordFromRules(values, rules = [], fallback = '') {
  for (const rule of rules) {
    const matches = normalizedList(rule.matches);
    if (values.some((value) => matches.some((match) => value === match || value.includes(match)))) {
      return rule.keyword;
    }
  }
  return fallback;
}

function normalizedList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map((item) => typeof item === 'object' && item ? item.value || item.primary || item.name || '' : item)
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

function plainTextToKdpHtml(value) {
  return escapeHtml(String(value || '').trim())
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, '<br>'))
    .join('<br><br>');
}

function appendDescriptionFooter(description, footer) {
  const safeFooter = escapeHtml(footer || '');
  const current = String(description || '').trim();
  if (current.includes(safeFooter) || current.includes(String(footer || ''))) return current;
  return [current, `<i>${safeFooter}</i>`].filter(Boolean).join('<br><br>');
}

function truthy(value) {
  return value === true || value === 1 || ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

let templates;

function loadTemplates() {
  if (templates) return templates;
  const candidates = [
    path.resolve(process.cwd(), 'data', 'kdp-pen-templates.json'),
    process.resourcesPath ? path.resolve(process.resourcesPath, 'data', 'kdp-pen-templates.json') : ''
  ].filter(Boolean);
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  templates = source ? JSON.parse(fs.readFileSync(source, 'utf8')) : {};
  return templates;
}
