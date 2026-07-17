import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAdultKdpCategories, isAdultKdpCategory } from '../src/services/kdpCategoryRules.js';

test('filters youth-facing KDP categories', () => {
  const categories = [
    'Romance > Science Fiction Romance',
    'Teen & Young Adult > Romance',
    "Children's Books > Science Fiction"
  ];
  assert.deepEqual(filterAdultKdpCategories(categories), ['Romance > Science Fiction Romance']);
});

test('accepts adult category objects', () => {
  assert.equal(isAdultKdpCategory({ path: 'Horror > Occult' }), true);
  assert.equal(isAdultKdpCategory({ path: 'Middle Grade > Horror' }), false);
});
