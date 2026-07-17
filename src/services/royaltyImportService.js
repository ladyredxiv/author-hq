const duplicateDetailSheets = new Set([
  'ebook royalty',
  'paperback royalty',
  'hardcover royalty',
  'ebook orders placed'
]);

export function royaltySheetMode(sourceSheet) {
  const sheet = String(sourceSheet || '').trim().toLowerCase();
  if (!sheet) return 'generic';
  if (sheet === 'combined sales') return 'paid-sales';
  if (sheet === 'orders processed') return 'free-downloads';
  if (sheet === 'kenp read') return 'kenp';
  if (duplicateDetailSheets.has(sheet)) return 'skip';
  if (sheet === 'summary' || sheet === 'report definitions') return 'skip';
  return 'generic';
}

export function royaltyUnitBreakdown({ sourceSheet, netUnits = 0, paidUnits = 0, freeUnits = 0 }) {
  const mode = royaltySheetMode(sourceSheet);
  if (mode === 'skip') return { mode, paid: 0, free: 0, skip: true };
  if (mode === 'free-downloads') {
    return { mode, paid: 0, free: Number(freeUnits) || 0, skip: !(Number(freeUnits) > 0) };
  }
  if (mode === 'kenp') return { mode, paid: 0, free: 0, skip: false };
  const paid = Number(netUnits) || Number(paidUnits) || 0;
  return { mode, paid, free: Number(freeUnits) || 0, skip: false };
}
