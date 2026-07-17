import test from 'node:test';
import assert from 'node:assert/strict';
import { royaltySheetMode, royaltyUnitBreakdown } from '../src/services/royaltyImportService.js';

test('uses Combined Sales as the paid-sale source and skips duplicate detail sheets', () => {
  assert.equal(royaltySheetMode('Combined Sales'), 'paid-sales');
  assert.equal(royaltySheetMode('eBook Royalty'), 'skip');
  assert.equal(royaltySheetMode('Paperback Royalty'), 'skip');
  assert.equal(royaltySheetMode('eBook Orders Placed'), 'skip');
});

test('tracks only free downloads from Orders Processed', () => {
  assert.deepEqual(
    royaltyUnitBreakdown({ sourceSheet: 'Orders Processed', paidUnits: 4, freeUnits: 27 }),
    { mode: 'free-downloads', paid: 0, free: 27, skip: false }
  );
  assert.equal(royaltyUnitBreakdown({ sourceSheet: 'Orders Processed', paidUnits: 4, freeUnits: 0 }).skip, true);
});

test('keeps paid and free units separate for a generic report', () => {
  assert.deepEqual(
    royaltyUnitBreakdown({ sourceSheet: '', netUnits: 3, paidUnits: 4, freeUnits: 12 }),
    { mode: 'generic', paid: 3, free: 12, skip: false }
  );
});
