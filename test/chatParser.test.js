import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogText } from '../src/services/chatParser.js';

test('parses subscription changes for existing-service updates', () => {
  const parsed = parseLogText('Change Claude Pro to $25 yearly, renews July 15');
  assert.equal(parsed.type, 'subscription');
  assert.equal(parsed.service, 'Claude Pro');
  assert.equal(parsed.monthlyCost, 25);
  assert.equal(parsed.billingCycle, 'Yearly');
  assert.equal(parsed.active, true);
});

test('parses weekly recaps before the expense fallback', () => {
  const parsed = parseLogText('Weekly summary: finished copyedits and scheduled posts');
  assert.equal(parsed.type, 'weekly-summary');
  assert.match(parsed.summary, /finished copyedits/i);
});

test('parses open loops as life tasks', () => {
  const parsed = parseLogText('Task: claim co-teaching credits tomorrow');
  assert.equal(parsed.type, 'life-task');
  assert.equal(parsed.status, 'Open');
  assert.ok(parsed.dueDate);
});

test('recognizes known book status updates', () => {
  const parsed = parseLogText("Night's Own is now Published", { books: [{ title: "Night's Own" }] });
  assert.equal(parsed.type, 'book');
  assert.equal(parsed.title, "Night's Own");
  assert.equal(parsed.status, 'Published');
});

test('parses a published-book word count update', () => {
  const parsed = parseLogText("Night's Own word count is 72,500 words", { books: [{ title: "Night's Own" }] });
  assert.equal(parsed.type, 'book');
  assert.equal(parsed.title, "Night's Own");
  assert.equal(parsed.wordCount, 72500);
});
