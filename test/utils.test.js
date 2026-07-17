import test from 'node:test';
import assert from 'node:assert/strict';
import { billingMonthlyEquivalent, parseMoney } from '../src/utils.js';

test('monthly set-aside normalizes common billing cycles', () => {
  assert.equal(billingMonthlyEquivalent(24, 'Monthly'), 24);
  assert.equal(billingMonthlyEquivalent(120, 'Yearly'), 10);
  assert.equal(billingMonthlyEquivalent(30, 'Quarterly'), 10);
  assert.equal(billingMonthlyEquivalent(12, 'One-time'), 0);
});

test('money parser accepts currency formatting', () => {
  assert.equal(parseMoney('$1,234.56'), 1234.56);
  assert.equal(parseMoney(''), 0);
});
