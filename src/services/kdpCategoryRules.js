const excludedAudiencePatterns = [
  /\bteen\s*&\s*young adult\b/i,
  /\byoung adult\b/i,
  /\bmiddle grade\b/i,
  /\bchildren'?s?\b/i,
  /\bjuvenile\b/i,
  /\bya\b/i
];

export const adultKdpCategoryWarning = 'Author HQ excludes YA, middle grade, juvenile, and children categories for this setup. Use adult-facing categories only.';

export function isAdultKdpCategory(category) {
  const path = typeof category === 'string' ? category : category?.path;
  if (!path) return false;
  return !excludedAudiencePatterns.some((pattern) => pattern.test(String(path)));
}

export function filterAdultKdpCategories(categories = []) {
  return categories.filter(isAdultKdpCategory);
}
