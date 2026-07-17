import fs from 'node:fs';
import path from 'node:path';

export function publicBookPayload({ sqlite, penNameKeyOrId, websiteDir = '' }) {
  const pen = findPenName(sqlite, penNameKeyOrId);
  if (!pen) throw new Error(`Pen name not found: ${penNameKeyOrId}`);

  const rows = sqlite.prepare(`
    SELECT b.*, p.display_name AS pen_name, l.blurb_draft AS listing_blurb
    FROM books b
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
    LEFT JOIN (
      SELECT book_id, blurb_draft, MAX(updated_at) AS updated_at
      FROM kdp_listings
      WHERE blurb_draft IS NOT NULL AND blurb_draft != ''
      GROUP BY book_id
    ) l ON l.book_id = b.id
    WHERE b.pen_name_id = ?
    ORDER BY COALESCE(b.series, ''), COALESCE(b.series_position, 9999), COALESCE(b.planned_release, b.actual_release, b.updated_at), b.title
  `).all(pen.id);

  const warnings = [];
  const books = rows
    .filter((book) => shouldExportBook(book))
    .map((book) => publicBookRecord(book, websiteDir, warnings));

  return {
    payload: {
      pen_name: pen.display_name,
      generated_at: new Date().toISOString(),
      books
    },
    warnings
  };
}

export function writePublicBookExport({ sqlite, penNameKeyOrId, outFile, websiteDir = '' }) {
  const { payload, warnings } = publicBookPayload({ sqlite, penNameKeyOrId, websiteDir });
  const destination = outFile || (websiteDir ? path.join(websiteDir, 'books.json') : path.resolve(process.cwd(), 'exports', slugify(payload.pen_name), 'books.json'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { destination, payload, warnings };
}

function publicBookRecord(book, websiteDir, warnings) {
  const id = book.public_slug || slugify(book.title);
  const status = publicStatus(book.status);
  const coverImage = book.cover_image || `images/${id}-cover.jpg`;
  if (websiteDir && coverImage && !fs.existsSync(path.join(websiteDir, coverImage))) {
    warnings.push(`Missing cover image for ${book.title}: ${path.join(websiteDir, coverImage)}`);
  }

  const record = {
    id,
    title: book.title,
    blurb: book.blurb || book.listing_blurb || '',
    status: status.value,
    cover_image: coverImage,
    status_label: status.label
  };
  if (book.series) record.series = book.series;
  if (book.series_position) record.series_position = Number(book.series_position);
  if (book.word_count) record.word_count = Number(book.word_count);
  return record;
}

function findPenName(sqlite, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return sqlite.prepare('SELECT * FROM pen_names WHERE id = ?').get(raw);
  return sqlite.prepare('SELECT * FROM pen_names WHERE lower(key) = lower(?) OR lower(display_name) = lower(?)').get(raw, raw);
}

function shouldExportBook(book) {
  return !['archived', 'cancelled', 'canceled'].includes(String(book.status || '').trim().toLowerCase());
}

function publicStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (['published', 'published live'].includes(normalized)) return { value: 'out-now', label: 'Out now' };
  if (['pre-order live', 'preorder live', 'uploaded to kdp', 'cover ready', 'formatting'].includes(normalized)) return { value: 'coming-soon', label: normalized.includes('pre') ? 'Pre-order' : 'Coming soon' };
  return { value: 'planned', label: 'Planned' };
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
