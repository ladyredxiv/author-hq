import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractManuscript, extractManuscriptCollection } from '../src/services/manuscriptExtractor.js';

test('extracts plain text and counts words', async () => {
  const result = await extractManuscript(Buffer.from('A sufficiently long manuscript passage. '.repeat(30)), 'story.txt');
  assert.ok(result.wordCount > 100);
  assert.equal(result.extension, '.txt');
});

test('combines chapter folders in natural filename order', async () => {
  const files = [
    { originalname: 'Novel/Chapter 10.md', buffer: Buffer.from('Tenth chapter text. '.repeat(40)) },
    { originalname: 'Novel/Chapter 2.md', buffer: Buffer.from('Second chapter text. '.repeat(40)) }
  ];
  const result = await extractManuscriptCollection(files);
  assert.equal(result.chapterCount, 2);
  assert.ok(result.text.indexOf('Chapter 2.md') < result.text.indexOf('Chapter 10.md'));
});

test('extracts EPUB chapters by spine order', async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package><manifest><item id="c1" href="one.xhtml"/><item id="c2" href="two.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  zip.file('OEBPS/one.xhtml', `<html><body><p>${'First chapter words. '.repeat(40)}</p></body></html>`);
  zip.file('OEBPS/two.xhtml', `<html><body><p>${'Second chapter words. '.repeat(40)}</p></body></html>`);
  const result = await extractManuscript(await zip.generateAsync({ type: 'nodebuffer' }), 'novel.epub');
  assert.ok(result.text.indexOf('First chapter') < result.text.indexOf('Second chapter'));
  assert.ok(result.wordCount > 200);
});
