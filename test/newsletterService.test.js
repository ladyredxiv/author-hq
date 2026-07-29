import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNewsletterFeaturedBook, stripNewsletterImages } from '../src/services/newsletterService.js';

test('removes newsletter image elements while preserving surrounding copy', () => {
  const html = `
    <p>Opening copy</p>
    <picture><source srcset="wide.webp"><img src="cover.jpg" alt="Book cover"></picture>
    <img src="hero.jpg" alt="Hero">
    <svg><image href="art.png"></image></svg>
    <v:fill src="outlook-background.jpg" type="frame" />
    <p>Closing copy</p>
  `;
  const clean = stripNewsletterImages(html);
  assert.match(clean, /Opening copy/);
  assert.match(clean, /Closing copy/);
  assert.doesNotMatch(clean, /<(?:img|picture|svg|image|v:fill)\b/i);
  assert.doesNotMatch(clean, /\.(?:jpg|png|webp)/i);
});

test('removes CSS and attribute background images without removing background colors', () => {
  const html = `
    <table background="texture.png">
      <tr><td style="background-image:url('hero.jpg');background-color:#111010;">Copy</td></tr>
      <tr><td style="background:url(texture.webp) center/cover no-repeat;color:white;">More</td></tr>
    </table>
  `;
  const clean = stripNewsletterImages(html);
  assert.doesNotMatch(clean, /background\s*=/i);
  assert.doesNotMatch(clean, /url\(/i);
  assert.match(clean, /background-color:#111010/);
  assert.match(clean, /Copy/);
  assert.match(clean, /More/);
});

test('newsletter promotion can be explicitly disabled or selected', () => {
  const books = [
    { id: 1, title: 'Backlist', status: 'Published', actual_release: '2026-01-01' },
    { id: 2, title: 'Chosen Book', status: 'Drafting', planned_release: '2026-10-01' }
  ];
  assert.equal(resolveNewsletterFeaturedBook({ books, promotionMode: 'none' }), null);
  assert.equal(resolveNewsletterFeaturedBook({ books, featuredBook: books[1], promotionMode: 'selected' })?.title, 'Chosen Book');
  assert.equal(resolveNewsletterFeaturedBook({ books, featuredBook: { id: 99 }, promotionMode: 'selected' }), null);
});

test('automatic newsletter promotion chooses the nearest upcoming release', () => {
  const books = [
    { id: 1, title: 'Published Book', status: 'Published', actual_release: '2026-06-01' },
    { id: 2, title: 'Later Book', status: 'Drafting', planned_release: '2026-10-01' },
    { id: 3, title: 'Next Book', status: 'Editing', planned_release: '2026-08-15' }
  ];
  const selected = resolveNewsletterFeaturedBook({
    books,
    promotionMode: 'auto',
    referenceDate: new Date('2026-07-29T12:00:00')
  });
  assert.equal(selected?.title, 'Next Book');
});
