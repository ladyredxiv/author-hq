import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml } from '../utils.js';

export function applyKdpPenTemplate({ packet, penName, listing = {}, manuscriptBrief = null, preserveGeneratedCopy = false }) {
  const template = kdpPenTemplateFor(penName);
  if (!template) return null;

  const project = manuscriptBrief?.project_metadata || {};
  const tropes = normalizedList(project.tropes || manuscriptBrief?.tropes);
  const categories = enforceCategoryPolicy(packet.categories_suggested, template.categoryPolicy, project, tropes);
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
    description_options: packet.description_options || [],
    keywords: packet.keywords || [],
    keyword_sets: packet.keyword_sets || [],
    keyword_notes: packet.keyword_notes || '',
    categories_suggested: categories,
    category_strategy: packet.category_strategy || {},
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
      operational_defaults_applied: true,
      creative_metadata_generated_by_claude: true
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

function enforceCategoryPolicy(categories, policy = {}, project = {}, tropes = []) {
  const disallowed = normalizedList(policy.disallowedTerms);
  const desiredCount = Number(policy.count || 3);
  const primaryFamily = String(policy.primaryFamily || 'Romance').toLowerCase();
  const generated = (Array.isArray(categories) ? categories : [])
    .map((category) => typeof category === 'string' ? { path: category } : { ...category })
    .filter((category) => category.path && !disallowed.some((term) => String(category.path).toLowerCase().includes(term)));
  const primaryIndex = generated.findIndex((category) => String(category.path).toLowerCase().startsWith(`${primaryFamily} >`));
  if (primaryIndex > 0) generated.unshift(generated.splice(primaryIndex, 1)[0]);

  const darkProject = truthy(project.cncPresent ?? project.cnc_present) ||
    String(project.heatLevel || project.heat_level || '').trim().toLowerCase() === 'dark' ||
    tropes.some((trope) => ['dark-romance', 'dark romance'].includes(trope));
  const fallbacks = [...(policy.fallbacks || [])];
  if (darkProject) {
    const darkIndex = fallbacks.findIndex((path) => String(path).toLowerCase().includes('dark romance'));
    if (darkIndex > 0) fallbacks.splice(1, 0, fallbacks.splice(darkIndex, 1)[0]);
  }
  if (primaryIndex < 0 && fallbacks.length) {
    generated.unshift({
      path: fallbacks[0],
      rating: 'Unrated',
      rationale: 'Romance-first fallback; verify the live KDP category picker.'
    });
  }
  for (const path of fallbacks) {
    if (generated.length >= desiredCount) break;
    if (!generated.some((category) => String(category.path).toLowerCase() === String(path).toLowerCase())) {
      generated.push({
        path,
        rating: 'Unrated',
        rationale: 'Fallback used because Claude returned fewer than three category suggestions; verify before publishing.'
      });
    }
  }
  return generated.slice(0, desiredCount);
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
