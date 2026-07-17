export function money(value) {
  return Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function number(value) {
  return Number(value || 0);
}

export function todayIso() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

export function parseMoney(value) {
  return Number(String(value || '').replace(/[$,]/g, '')) || 0;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

export function billingMonthlyEquivalent(amount, cycle) {
  const value = parseMoney(amount);
  const normalized = String(cycle || 'Monthly').toLowerCase();
  if (normalized.includes('year') || normalized.includes('annual')) return value / 12;
  if (normalized.includes('quarter')) return value / 3;
  if (normalized.includes('week')) return (value * 52) / 12;
  if (normalized.includes('one')) return 0;
  return value;
}

export function adMetrics(row) {
  const spend = number(row.spend);
  const revenue = number(row.revenue);
  const clicks = number(row.clicks);
  const conversions = number(row.conversions);
  return {
    roi: spend > 0 ? (revenue - spend) / spend : 0,
    acos: revenue > 0 ? spend / revenue : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    conversionRate: clicks > 0 ? conversions / clicks : 0
  };
}
