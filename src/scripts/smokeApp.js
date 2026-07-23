import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'author-hq-app-smoke-'));
process.env.DATABASE_PATH = path.join(tempRoot, 'author-hq.sqlite');
process.env.AUTHOR_HQ_SETTINGS_PATH = path.join(tempRoot, 'local-settings.json');
let handle;

try {
  const { startServer } = await import('../server.js');
  handle = await startServer({ port: 0, host: '127.0.0.1' });
  await expectPage(handle.url, '/', 'Command Center');
  await expectPage(handle.url, '/', 'Claim Credits');
  await expectPage(handle.url, '/settings', 'Data Safety');
  await expectPage(handle.url, '/subscriptions', 'Monthly Set Aside');
  await expectPage(handle.url, '/kdp-listings', 'Analyze Chapter Folder');
  await expectPage(handle.url, '/kdp-listings', 'data-kdp-generation-form');
  await expectPage(handle.url, '/kdp-listings', 'Claude is building your KDP packet...');
  await expectPage(handle.url, '/newsletter', 'Start a Newsletter Workspace');

  const newsletterSave = await fetch(`${handle.url}/newsletter/projects`, {
    method: 'POST',
    body: new URLSearchParams({ penNameId: '1', title: 'Smoke Newsletter Room', topic: 'Behind the scenes' }),
    redirect: 'manual'
  });
  if (newsletterSave.status !== 302) throw new Error(`Newsletter workspace save returned ${newsletterSave.status}.`);
  const newsletterLocation = newsletterSave.headers.get('location');
  if (!newsletterLocation) throw new Error('Newsletter workspace did not return a location.');
  await expectPage(handle.url, '/newsletter', `<a href="${newsletterLocation}"><strong>Smoke Newsletter Room</strong></a>`);
  await expectPage(handle.url, newsletterLocation, 'Smoke Newsletter Room');
  await expectPage(handle.url, newsletterLocation, 'Claude is thinking...');
  const newsletterDraftSave = await fetch(`${handle.url}${newsletterLocation}/draft`, { method: 'POST', redirect: 'manual' });
  if (newsletterDraftSave.status !== 302) throw new Error(`Newsletter draft shaping returned ${newsletterDraftSave.status}.`);
  await expectPage(handle.url, newsletterLocation, 'Live preview');
  await expectPage(handle.url, newsletterLocation, 'data-preview-size="mobile"');

  const body = new URLSearchParams({
    service: 'Smoke Test Service',
    category: 'Software',
    monthlyCost: '120',
    billingCycle: 'Yearly',
    renewalDate: '2026-12-01',
    paymentMethod: 'Credit Card',
    active: 'on',
    notes: 'Temporary smoke-test row'
  });
  const save = await fetch(`${handle.url}/subscriptions`, { method: 'POST', body, redirect: 'manual' });
  if (save.status !== 302) throw new Error(`Subscription save returned ${save.status}.`);
  await expectPage(handle.url, '/subscriptions', 'Smoke Test Service');
  const { sqlite: smokeSqlite } = await import('../db/index.js');
  const smokeSubscription = smokeSqlite.prepare("SELECT id FROM subscriptions WHERE service = 'Smoke Test Service'").get();
  const expenseSave = await fetch(`${handle.url}/expenses`, {
    method: 'POST',
    body: new URLSearchParams({
      date: new Date().toISOString().slice(0, 10),
      vendor: 'Smoke Test Service',
      amount: '120',
      category: 'Software',
      subscriptionId: String(smokeSubscription.id),
      recurring: 'on'
    }),
    redirect: 'manual'
  });
  if (expenseSave.status !== 302) throw new Error(`Linked expense save returned ${expenseSave.status}.`);
  await expectPage(handle.url, '/subscriptions', 'Charge logged');
  await expectPage(handle.url, '/subscriptions', 'Matched');

  const bookBody = new URLSearchParams({
    title: 'Published Words Smoke Test',
    series: '',
    wordCount: '100000',
    status: 'Published',
    plannedRelease: '',
    actualRelease: '2026-01-01',
    notes: 'Temporary smoke-test book'
  });
  const bookSave = await fetch(`${handle.url}/books`, { method: 'POST', body: bookBody, redirect: 'manual' });
  if (bookSave.status !== 302) throw new Error(`Book save returned ${bookSave.status}.`);
  const preorderBody = new URLSearchParams({
    title: 'Preorder Smoke Test',
    wordCount: '75000',
    status: 'Pre-order Live',
    plannedRelease: '2026-12-01',
    notes: 'Must not count as a live book'
  });
  const preorderSave = await fetch(`${handle.url}/books`, { method: 'POST', body: preorderBody, redirect: 'manual' });
  if (preorderSave.status !== 302) throw new Error(`Pre-order book save returned ${preorderSave.status}.`);
  await expectPage(handle.url, '/books', 'Active Pipeline');
  await expectPage(handle.url, '/books?add=1', 'id="add-book" open');
  await expectPage(handle.url, '/books', 'Preorder Smoke Test');
  await expectPage(handle.url, '/books?view=published', 'Published Words Smoke Test');
  await expectPage(handle.url, '/books?view=published', '1 shown');
  await expectPage(handle.url, '/books?q=Preorder', '1 shown');
  const publishedBook = smokeSqlite.prepare("SELECT id FROM books WHERE title = 'Published Words Smoke Test'").get();
  smokeSqlite.prepare(`
    INSERT INTO brain_documents (file_path, file_name, extension, title, book_id, tags, snippet, size_bytes, modified_at)
    VALUES (?, 'chapter-01.md', 'md', 'Chapter 01 Draft', ?, '["draft"]', 'Smoke chapter', 100, CURRENT_TIMESTAMP)
  `).run(path.join(tempRoot, 'published-words-smoke', 'chapter-01.md'), publishedBook.id);
  const archiveSave = await fetch(`${handle.url}/brain/archive-completed-chapters`, { method: 'POST', redirect: 'manual' });
  if (archiveSave.status !== 200) throw new Error(`Completed chapter archive returned ${archiveSave.status}.`);
  await expectPageNot(handle.url, '/brain', 'Chapter 01 Draft');
  await expectPage(handle.url, '/brain?includeArchived=1', 'Chapter 01 Draft');
  await expectPage(handle.url, '/brain?includeArchived=1', 'Restore');
  const challengeSave = await fetch(`${handle.url}/goals/published-words-challenge`, { method: 'POST', redirect: 'manual' });
  if (challengeSave.status !== 302) throw new Error(`Published words challenge returned ${challengeSave.status}.`);
  await expectPage(handle.url, '/goals', '10.0%');
  await expectPage(handle.url, '/goals', '100,000 of 1,000,000 published words');
  await expectPage(handle.url, '/', 'data-testid="live-books-count">1</strong>');
  console.log('Dashboard, Settings, newsletter workspace, subscriptions, and published-words goal workflow passed.');
} finally {
  if (handle?.close) await handle.close();
  const { sqlite } = await import('../db/index.js').catch(() => ({}));
  if (sqlite?.open) sqlite.close();
  if (tempRoot.startsWith(os.tmpdir())) fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function expectPage(baseUrl, pathname, expectedText) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const html = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}.`);
  if (!html.includes(expectedText)) throw new Error(`${pathname} did not contain ${expectedText}.`);
}

async function expectPageNot(baseUrl, pathname, unexpectedText) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const html = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}.`);
  if (html.includes(unexpectedText)) throw new Error(`${pathname} unexpectedly contained ${unexpectedText}.`);
}
