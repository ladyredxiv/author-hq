import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const dbPath = process.env.DATABASE_PATH || './data/author-hq.sqlite';
export const databasePath = path.resolve(dbPath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const sqlite = new Database(databasePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('wal_autocheckpoint = 1000');

export const db = drizzle(sqlite, { schema });

export function initializeDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pen_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      brand_details TEXT NOT NULL DEFAULT '{}',
      email_octopus_list_id TEXT,
      buffer_channels TEXT NOT NULL DEFAULT '{}',
      color_palette TEXT NOT NULL DEFAULT '{}',
      fonts TEXT NOT NULL DEFAULT '{}',
      social_handles TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pen_name_id INTEGER REFERENCES pen_names(id),
      title TEXT NOT NULL,
      series TEXT,
      series_position INTEGER,
      word_count INTEGER NOT NULL DEFAULT 0,
      public_slug TEXT,
      blurb TEXT,
      cover_image TEXT,
      status TEXT NOT NULL DEFAULT 'Planning',
      planned_release TEXT,
      actual_release TEXT,
      draft_complete TEXT,
      editing_complete TEXT,
      cover_ready TEXT,
      formatted TEXT,
      uploaded_kdp TEXT,
      preorder_live TEXT,
      published_live TEXT,
      audiobook_progress INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS launch_checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER REFERENCES books(id),
      book_title TEXT NOT NULL,
      item TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      updated TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS launch_checklists_book_item_idx ON launch_checklists(book_title, item);

    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pen_name_id INTEGER REFERENCES pen_names(id),
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'Active',
      target_date TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '*',
      title TEXT NOT NULL,
      description TEXT,
      notes TEXT,
      pen_name_id INTEGER REFERENCES pen_names(id),
      pen_name_label TEXT NOT NULL DEFAULT 'All',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Software',
      monthly_cost REAL NOT NULL DEFAULT 0,
      billing_cycle TEXT NOT NULL DEFAULT 'Monthly',
      renewal_date TEXT,
      payment_method TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      annualized_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      vendor TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      pen_name_id INTEGER REFERENCES pen_names(id),
      subscription_id INTEGER REFERENCES subscriptions(id),
      payment_method TEXT,
      recurring INTEGER NOT NULL DEFAULT 0,
      amount REAL NOT NULL,
      receipt_saved TEXT NOT NULL DEFAULT 'No',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS income (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'Amazon KDP',
      income_type TEXT NOT NULL DEFAULT 'Combined Payout',
      amount REAL NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS royalty_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start TEXT,
      period_end TEXT,
      report_date TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'Amazon KDP',
      marketplace TEXT,
      pen_name_id INTEGER REFERENCES pen_names(id),
      book_id INTEGER REFERENCES books(id),
      title TEXT NOT NULL,
      author TEXT,
      format TEXT,
      units INTEGER NOT NULL DEFAULT 0,
      free_units INTEGER NOT NULL DEFAULT 0,
      kenp_read INTEGER NOT NULL DEFAULT 0,
      royalty REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      source_file TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS royalty_entries_title_idx ON royalty_entries(lower(title));
    CREATE INDEX IF NOT EXISTS royalty_entries_report_date_idx ON royalty_entries(report_date);

    CREATE TABLE IF NOT EXISTS brain_roots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      folder_path TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      last_indexed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS brain_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_id INTEGER REFERENCES brain_roots(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      extension TEXT,
      title TEXT,
      pen_name_id INTEGER REFERENCES pen_names(id),
      book_id INTEGER REFERENCES books(id),
      tags TEXT NOT NULL DEFAULT '[]',
      snippet TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      modified_at TEXT,
      indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      archive_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS brain_documents_title_idx ON brain_documents(lower(title));
    CREATE INDEX IF NOT EXISTS brain_documents_file_name_idx ON brain_documents(lower(file_name));

    CREATE TABLE IF NOT EXISTS brain_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_type TEXT NOT NULL DEFAULT 'Decision',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      pen_name_id INTEGER REFERENCES pen_names(id),
      book_id INTEGER REFERENCES books(id),
      source_path TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      important INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS brain_notes_title_idx ON brain_notes(lower(title));
    CREATE INDEX IF NOT EXISTS brain_notes_type_idx ON brain_notes(note_type);

    CREATE TABLE IF NOT EXISTS hq_improvement_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Complete',
      provider TEXT NOT NULL DEFAULT 'local',
      summary TEXT,
      raw_output TEXT,
      output_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS hq_improvement_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES hq_improvement_runs(id) ON DELETE CASCADE,
      bucket TEXT NOT NULL DEFAULT 'Needs Review',
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'Proposed',
      resolution_note_id INTEGER REFERENCES brain_notes(id),
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS hq_improvement_items_status_idx ON hq_improvement_items(status);

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      event_time TEXT,
      event_type TEXT NOT NULL DEFAULT 'General',
      pen_name_id INTEGER REFERENCES pen_names(id),
      book_id INTEGER REFERENCES books(id),
      status TEXT NOT NULL DEFAULT 'Planned',
      source TEXT NOT NULL DEFAULT 'manual',
      external_source TEXT,
      external_id TEXT,
      external_updated TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS calendar_events_date_idx ON calendar_events(event_date);

    CREATE TABLE IF NOT EXISTS life_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      title TEXT NOT NULL,
      body TEXT,
      mood TEXT,
      energy TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS life_logs_date_idx ON life_logs(log_date);

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      mood TEXT,
      energy TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      source_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries(entry_date);

    CREATE TABLE IF NOT EXISTS newsletter_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pen_name_id INTEGER NOT NULL REFERENCES pen_names(id),
      title TEXT NOT NULL,
      topic TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      featured_book_id INTEGER REFERENCES books(id),
      promotion_mode TEXT NOT NULL DEFAULT 'auto',
      draft_subject TEXT,
      draft_preview TEXT,
      draft_text TEXT,
      draft_html TEXT,
      draft_provider TEXT,
      draft_warning TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS newsletter_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES newsletter_projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS newsletter_projects_updated_idx ON newsletter_projects(updated_at);
    CREATE INDEX IF NOT EXISTS newsletter_messages_project_idx ON newsletter_messages(project_id, id);

    CREATE TABLE IF NOT EXISTS life_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'Open',
      due_date TEXT,
      priority TEXT NOT NULL DEFAULT 'Normal',
      energy TEXT,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS life_tasks_status_idx ON life_tasks(status);
    CREATE INDEX IF NOT EXISTS life_tasks_due_idx ON life_tasks(due_date);

    CREATE TABLE IF NOT EXISTS life_routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      cadence TEXT NOT NULL DEFAULT 'Weekly',
      next_due TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS life_routines_due_idx ON life_routines(next_due);

    CREATE TABLE IF NOT EXISTS google_calendar_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_key TEXT NOT NULL UNIQUE,
      google_event_id TEXT,
      synced_at TEXT,
      sync_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS content_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pen_name_id INTEGER REFERENCES pen_names(id),
      platform TEXT NOT NULL,
      channel_id TEXT,
      content TEXT NOT NULL,
      scheduled_for TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      verified_live INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ad_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      pen_name_id INTEGER REFERENCES pen_names(id),
      book_id INTEGER REFERENCES books(id),
      date_start TEXT,
      date_end TEXT,
      spend REAL NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      conversions INTEGER NOT NULL DEFAULT 0,
      sales INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      profile_id TEXT,
      external_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ad_copy_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pen_name_id INTEGER REFERENCES pen_names(id),
      book_id INTEGER REFERENCES books(id),
      platform TEXT NOT NULL,
      angle TEXT,
      headline TEXT,
      body TEXT NOT NULL,
      cta TEXT,
      provider TEXT NOT NULL DEFAULT 'manual_or_stub',
      prompt TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kindle_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      dept TEXT,
      l2 TEXT,
      l3 TEXT,
      l4 TEXT,
      node_id TEXT,
      url TEXT,
      rank20_absr INTEGER,
      rank20_rating TEXT,
      rank100_absr INTEGER,
      rank100_rating TEXT,
      overall_rating TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kdp_genre_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pen_name_id INTEGER NOT NULL REFERENCES pen_names(id),
      status TEXT NOT NULL DEFAULT 'draft',
      voice_description TEXT,
      core_tropes TEXT NOT NULL DEFAULT '[]',
      target_audience TEXT,
      verified_categories TEXT NOT NULL DEFAULT '[]',
      keyword_starter_list TEXT NOT NULL DEFAULT '[]',
      category_strategy_notes TEXT,
      default_price_usd REAL NOT NULL DEFAULT 4.99,
      default_ku_enrolled INTEGER NOT NULL DEFAULT 0,
      ai_generated_default INTEGER NOT NULL DEFAULT 0,
      ai_assisted_default INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pen_name_id)
    );

    CREATE TABLE IF NOT EXISTS kdp_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER REFERENCES books(id),
      pen_name_id INTEGER REFERENCES pen_names(id),
      format TEXT NOT NULL DEFAULT 'ebook',
      title TEXT NOT NULL,
      subtitle TEXT,
      series_name TEXT,
      series_number TEXT,
      blurb_draft TEXT,
      comp_titles TEXT,
      target_categories TEXT,
      price_usd REAL NOT NULL DEFAULT 4.99,
      ku_enrolled INTEGER NOT NULL DEFAULT 0,
      ai_generated INTEGER NOT NULL DEFAULT 0,
      ai_assisted INTEGER NOT NULL DEFAULT 1,
      language TEXT NOT NULL DEFAULT 'English',
      reading_age TEXT NOT NULL DEFAULT '18+',
      publication_rights TEXT NOT NULL DEFAULT 'I own the copyright and hold necessary publishing rights',
      status TEXT NOT NULL DEFAULT 'draft',
      generated_packet TEXT NOT NULL DEFAULT '{}',
      provider TEXT NOT NULL DEFAULT 'rules',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kdp_manuscript_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      chapter_count INTEGER NOT NULL DEFAULT 1,
      extraction_warnings TEXT NOT NULL DEFAULT '[]',
      analysis_json TEXT NOT NULL DEFAULT '{}',
      review_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'Processing',
      provider TEXT NOT NULL DEFAULT 'claude',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS kdp_manuscript_analyses_book_idx ON kdp_manuscript_analyses(book_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS kdp_manuscript_analyses_hash_idx ON kdp_manuscript_analyses(book_id, source_hash);

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      account_id TEXT,
      encrypted_access_token TEXT,
      encrypted_refresh_token TEXT,
      expires_at TEXT,
      scopes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  migrateColumns();
  seedPenNames();
  seedBrainRoots();
  seedKindleCategories();
  seedKdpGenreConfigs();
}

export function databaseHealth() {
  const quickCheck = sqlite.pragma('quick_check').map((row) => Object.values(row)[0]);
  const foreignKeyIssues = sqlite.pragma('foreign_key_check');
  return {
    ok: quickCheck.length === 1 && quickCheck[0] === 'ok' && foreignKeyIssues.length === 0,
    quickCheck,
    foreignKeyIssues,
    path: databasePath
  };
}

export async function createDatabaseBackup({ force = false, keep = 14 } = {}) {
  const backupDir = path.join(path.dirname(databasePath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const destination = path.join(backupDir, `author-hq-${day}.sqlite`);

  if (!force && fs.existsSync(destination)) {
    return { created: false, path: destination, reason: 'A backup already exists for today.' };
  }

  const target = force && fs.existsSync(destination)
    ? path.join(backupDir, `author-hq-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
    : destination;
  await sqlite.backup(target);
  pruneBackups(backupDir, keep);
  return { created: true, path: target };
}

export function databaseMaintenanceStatus() {
  const backupDir = path.join(path.dirname(databasePath), 'backups');
  const backups = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir)
      .filter((name) => name.endsWith('.sqlite'))
      .map((name) => {
        const filePath = path.join(backupDir, name);
        const stat = fs.statSync(filePath);
        return { name, path: filePath, modifiedAt: stat.mtime.toISOString(), sizeBytes: stat.size };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    : [];
  return { health: databaseHealth(), backupDir, backups };
}

function pruneBackups(backupDir, keep) {
  const files = fs.readdirSync(backupDir)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => ({ name, time: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  files.slice(Math.max(1, keep)).forEach(({ name }) => fs.rmSync(path.join(backupDir, name)));
}

function migrateColumns() {
  const ensure = (table, column, ddl) => {
    const existing = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!existing.includes(column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };

  ensure('books', 'draft_complete', 'draft_complete TEXT');
  ensure('books', 'series_position', 'series_position INTEGER');
  ensure('books', 'word_count', 'word_count INTEGER NOT NULL DEFAULT 0');
  ensure('books', 'public_slug', 'public_slug TEXT');
  ensure('books', 'blurb', 'blurb TEXT');
  ensure('books', 'cover_image', 'cover_image TEXT');
  ensure('books', 'editing_complete', 'editing_complete TEXT');
  ensure('books', 'cover_ready', 'cover_ready TEXT');
  ensure('books', 'formatted', 'formatted TEXT');
  ensure('books', 'uploaded_kdp', 'uploaded_kdp TEXT');
  ensure('books', 'preorder_live', 'preorder_live TEXT');
  ensure('books', 'published_live', 'published_live TEXT');
  ensure('pen_names', 'amazon_ads_profile_id', 'amazon_ads_profile_id TEXT');
  ensure('ad_entries', 'profile_id', 'profile_id TEXT');
  ensure('ad_entries', 'external_id', 'external_id TEXT');
  ensure('content_posts', 'verified_live', 'verified_live INTEGER NOT NULL DEFAULT 0');
  ensure('kdp_listings', 'manuscript_analysis_id', 'manuscript_analysis_id INTEGER REFERENCES kdp_manuscript_analyses(id)');
  ensure('royalty_entries', 'free_units', 'free_units INTEGER NOT NULL DEFAULT 0');
  ensure('expenses', 'subscription_id', 'subscription_id INTEGER REFERENCES subscriptions(id)');
  ensure('brain_documents', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
  ensure('brain_documents', 'archived_at', 'archived_at TEXT');
  ensure('brain_documents', 'archive_reason', 'archive_reason TEXT');
  ensure('newsletter_projects', 'featured_book_id', 'featured_book_id INTEGER REFERENCES books(id)');
  ensure('newsletter_projects', 'promotion_mode', "promotion_mode TEXT NOT NULL DEFAULT 'auto'");
  // KDP's order-status sheets repeat paid sales already represented by Combined Sales.
  // Older imports stored those status rows as sales, so remove only those imported duplicates.
  sqlite.exec(`
    DELETE FROM royalty_entries
    WHERE lower(trim(COALESCE(format, ''))) IN ('orders processed', 'ebook orders placed')
      AND lower(COALESCE(notes, '')) LIKE 'imported from%'
  `);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS ad_entries_amazon_report_idx ON ad_entries(platform, source, profile_id, campaign_name, date_start, date_end) WHERE platform = 'Amazon' AND source = 'amazon_report'");
  ensure('hq_improvement_items', 'resolution_note_id', 'resolution_note_id INTEGER REFERENCES brain_notes(id)');
  ensure('hq_improvement_items', 'resolved_at', 'resolved_at TEXT');
  ensure('calendar_events', 'external_source', 'external_source TEXT');
  ensure('calendar_events', 'external_id', 'external_id TEXT');
  ensure('calendar_events', 'external_updated', 'external_updated TEXT');
  sqlite.exec('CREATE INDEX IF NOT EXISTS calendar_events_external_idx ON calendar_events(external_source, external_id)');
}

function seedBrainRoots() {
  const stmt = sqlite.prepare('INSERT OR IGNORE INTO brain_roots (label, folder_path) VALUES (?, ?)');
  if (process.env.AUTHOR_HQ_WRITING_ROOT) stmt.run('Writing', process.env.AUTHOR_HQ_WRITING_ROOT);
  if (process.env.AUTHOR_HQ_EXTERNAL_WRITING_ROOT) stmt.run('External Writing', process.env.AUTHOR_HQ_EXTERNAL_WRITING_ROOT);
}

function seedPenNames() {
  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO pen_names
      (key, display_name, brand_details, email_octopus_list_id, buffer_channels, color_palette, fonts, social_handles)
    VALUES
      (@key, @displayName, @brandDetails, @emailOctopusListId, @bufferChannels, @colorPalette, @fonts, @socialHandles)
  `);

  const defaults = [
    {
      key: 'selena-monroe',
      displayName: 'Selena Monroe',
      brandDetails: { genre: 'sapphic dark erotic romance / romantasy', voice: 'lush, intimate, gothic, emotionally dangerous' },
      emailOctopusListId: null,
      bufferChannels: {},
      colorPalette: { accent: '#8b4a2f', ink: '#1a1612', paper: '#faf8f5' },
      fonts: { serif: 'Playfair Display', sans: 'DM Sans' },
      socialHandles: {}
    },
    {
      key: 'morgan-k-quinn',
      displayName: 'Morgan K Quinn',
      brandDetails: { genre: 'psychological thriller', voice: 'sharp, unnerving, elegant, controlled' },
      emailOctopusListId: null,
      bufferChannels: {},
      colorPalette: { accent: '#185fa5', ink: '#16191d', paper: '#f7f8fa' },
      fonts: { serif: 'Georgia', sans: 'Inter' },
      socialHandles: {}
    },
    {
      key: 'ra-lorne',
      displayName: 'R.A. Lorne',
      brandDetails: { genre: 'sapphic erotic horror romance', voice: 'visceral, tender, feral, atmospheric' },
      emailOctopusListId: null,
      bufferChannels: {},
      colorPalette: { accent: '#534AB7', ink: '#17141f', paper: '#fbf9ff' },
      fonts: { serif: 'Cormorant Garamond', sans: 'Jost' },
      socialHandles: {}
    },
    {
      key: 'sage-halcyon',
      displayName: 'Sage Halcyon',
      brandDetails: { genre: 'cozy science fiction romance', voice: 'warm, gentle, witty, emotionally safe' },
      emailOctopusListId: null,
      bufferChannels: {},
      colorPalette: { accent: '#4f8f7f', ink: '#17211f', paper: '#f8fbf8' },
      fonts: { serif: 'Georgia', sans: 'Inter' },
      socialHandles: {}
    },
    {
      key: 'ana-rourke',
      displayName: 'Ana Rourke',
      brandDetails: { genre: 'M/F erotica shorts', voice: 'direct, high-heat, compact, reader-forward' },
      emailOctopusListId: null,
      bufferChannels: {},
      colorPalette: { accent: '#b64e6f', ink: '#17131a', paper: '#fbf7f9' },
      fonts: { serif: 'Georgia', sans: 'Inter' },
      socialHandles: {}
    }
  ];

  const tx = sqlite.transaction((rows) => {
    rows.forEach((row) => insert.run({
      ...row,
      brandDetails: JSON.stringify(row.brandDetails),
      bufferChannels: JSON.stringify(row.bufferChannels),
      colorPalette: JSON.stringify(row.colorPalette),
      fonts: JSON.stringify(row.fonts),
      socialHandles: JSON.stringify(row.socialHandles)
    }));
  });
  tx(defaults);
}

function seedKindleCategories() {
  const source = kindleCategorySeedPath();
  if (!fs.existsSync(source)) return;
  const current = sqlite.prepare('SELECT COUNT(*) AS count FROM kindle_categories').get().count;
  if (current > 0) return;

  const rows = JSON.parse(fs.readFileSync(source, 'utf8'));
  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO kindle_categories
      (path, dept, l2, l3, l4, node_id, url, rank20_absr, rank20_rating, rank100_absr, rank100_rating, overall_rating)
    VALUES
      (@path, @dept, @l2, @l3, @l4, @nodeId, @url, @rank20Absr, @rank20Rating, @rank100Absr, @rank100Rating, @overallRating)
  `);
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => insert.run(row));
  });
  tx(rows);
}

function kindleCategorySeedPath() {
  const candidates = [
    path.resolve(process.cwd(), 'data', 'kindle-categories.json')
  ];
  if (process.resourcesPath) {
    candidates.push(path.resolve(process.resourcesPath, 'data', 'kindle-categories.json'));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function seedKdpGenreConfigs() {
  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO kdp_genre_configs
      (pen_name_id, status, voice_description, core_tropes, target_audience, verified_categories, keyword_starter_list, category_strategy_notes, default_price_usd, default_ku_enrolled, ai_generated_default, ai_assisted_default)
    VALUES
      (@penNameId, @status, @voiceDescription, @coreTropes, @targetAudience, @verifiedCategories, @keywordStarterList, @categoryStrategyNotes, @defaultPriceUsd, @defaultKuEnrolled, @aiGeneratedDefault, @aiAssistedDefault)
  `);
  const penByKey = sqlite.prepare('SELECT id FROM pen_names WHERE key = ?');
  const defaults = [
    {
      key: 'selena-monroe',
      status: 'verified',
      voiceDescription: 'Sapphic dark erotic romance with paranormal/monster elements, dubcon, slow burn, enemies-to-lovers, magical compulsion, and monster/demon love interests.',
      coreTropes: ['sapphic', 'dark romantasy', 'monster romance', 'slow burn', 'enemies to lovers', 'magical compulsion'],
      targetAudience: 'Adult dark romantasy and sapphic monster-romance readers; explicit 18+.',
      verifiedCategories: [
        { path: 'Romance > LGBTQ+ > Lesbian Romance', rating: 'Fortress', notes: 'Strong primary slot for sapphic books.' },
        { path: 'Romance > Paranormal > Demons & Devils', rating: 'Competitive', notes: 'Specific fit for demon/monster romance.' },
        { path: 'Science Fiction & Fantasy > Fantasy > Dark Fantasy > LGBTQ+ Horror', rating: 'Competitive', notes: 'Crosses into SF&F dark fantasy discovery.' },
        { path: 'Science Fiction & Fantasy > Fantasy > Dark Fantasy > Cosmic & Eldritch', rating: 'Moderate', notes: 'Use when the book has eldritch/cosmic elements.' },
        { path: 'Science Fiction & Fantasy > Fantasy > Indigenous', rating: 'Easy', notes: 'Situational only if the book has indigenous worldbuilding elements.' }
      ],
      keywordStarterList: ['sapphic dark romance', 'lesbian monster romance', 'dark romantasy', 'demon romance', 'slow burn sapphic romance', 'enemies to lovers fantasy', 'kindle unlimited sapphic fantasy'],
      categoryStrategyNotes: 'Spread across Romance and SF&F hierarchies when possible to land on separate bestseller lists from the 3 available slots.',
      defaultPriceUsd: 4.99,
      defaultKuEnrolled: 1,
      aiGeneratedDefault: 0,
      aiAssistedDefault: 1
    },
    {
      key: 'morgan-k-quinn',
      status: 'draft',
      voiceDescription: 'Psychological thriller: sharp, unnerving, elegant, controlled.',
      coreTropes: ['psychological suspense', 'unreliable narrator', 'mind games', 'family secrets', 'psychological manipulation'],
      targetAudience: 'Adult psychological thriller and domestic suspense readers.',
      verifiedCategories: [
        { path: 'Mystery, Thriller & Suspense > Thriller & Suspense > Psychological', rating: 'Competitive', notes: 'Primary slot; confirm live KDP category before locking.' },
        { path: 'Mystery, Thriller & Suspense > Thriller & Suspense > Domestic Fiction', rating: 'Moderate', notes: 'Use if the book has a domestic/family-secrets angle.' },
        { path: 'Mystery, Thriller & Suspense > Mystery > Women Sleuths', rating: 'Moderate', notes: 'Only if the protagonist genuinely fits.' },
        { path: "Literature & Fiction > Women's Fiction > Suspense", rating: 'Moderate', notes: 'Stretch/cross-list option.' }
      ],
      keywordStarterList: ['psychological thriller', 'psychological suspense', 'unreliable narrator', 'mind games', 'psychological manipulation', 'twisted mind', 'mental suspense'],
      categoryStrategyNotes: 'Use each category slot for a distinct purpose: specific niche fit, complementary angle, and stretch/category association.',
      defaultPriceUsd: 4.99,
      defaultKuEnrolled: 0,
      aiGeneratedDefault: 0,
      aiAssistedDefault: 1
    },
    {
      key: 'ra-lorne',
      status: 'draft',
      voiceDescription: 'Sapphic erotic horror romance-adjacent, visceral, tender, feral, atmospheric; no HEA.',
      coreTropes: ['sapphic horror', 'erotic horror', 'no happy ending', 'gothic horror', 'monster horror', 'cult horror'],
      targetAudience: 'Adult sapphic horror and erotic horror readers who expect darkness over genre-romance HEA.',
      verifiedCategories: [
        { path: 'Horror > Occult', rating: 'Moderate', notes: 'Primary horror-first slot when threat type fits.' },
        { path: 'Horror > Ghosts', rating: 'Moderate', notes: 'Use depending on the book-specific monster/threat type.' },
        { path: 'Horror > Lesbian', rating: 'Competitive', notes: 'Sapphic-horror-specific list.' },
        { path: 'LGBTQ+ Fiction > Lesbian', rating: 'Moderate', notes: 'Broader sapphic-fiction cross-list.' },
        { path: 'Romance > Erotica > LGBT', rating: 'Competitive', notes: 'Only as a deliberate convention deviation; flag no-HEA issue.' }
      ],
      keywordStarterList: ['dark horror romance', 'sapphic horror', 'erotic horror', 'no happy ending', 'gothic horror romance', 'monster horror romance', 'cult horror'],
      categoryStrategyNotes: 'Open question: no-HEA books may not fit Romance category convention. Prefer Horror-first categories and signal romance through keywords unless deliberately choosing otherwise.',
      defaultPriceUsd: 4.99,
      defaultKuEnrolled: 0,
      aiGeneratedDefault: 0,
      aiAssistedDefault: 1
    },
    {
      key: 'sage-halcyon',
      status: 'draft',
      voiceDescription: 'Cozy science fiction romance: warm, low-stakes, emotionally safe, found-family comfort in space.',
      coreTropes: ['found family', 'slow burn', 'low stakes', 'sentient ship', 'AI companion', 'found-family crew', 'gentle humor', 'non-human love interest'],
      targetAudience: 'Cozy sci-fi and sweet science fiction romance readers who want warmth, community, and emotional safety.',
      verifiedCategories: [
        { path: 'Science Fiction & Fantasy > Science Fiction > Space Opera', rating: 'Competitive', notes: 'Broad but defensible if shipbound/space-set.' },
        { path: 'Romance > Science Fiction Romance', rating: 'Competitive', notes: 'Most direct fit if live in KDP dropdown; hand-check for duplicate/ghost category.' },
        { path: 'Science Fiction & Fantasy > Fantasy > Cozy Fantasy', rating: 'Moderate', notes: 'Worth checking as a cozy signal; use only if Amazon allows it accurately.' },
        { path: 'Romance > Romantic Comedy', rating: 'Moderate', notes: 'Only if tone leans clearly humorous.' }
      ],
      keywordStarterList: ['cozy sci-fi romance', 'cozy science fiction', 'found family space', 'slow burn space romance', 'sentient spaceship companion', 'low stakes science fiction', 'gentle science fiction romance'],
      categoryStrategyNotes: 'New pen name and fresh niche. Keep config as draft until the first manuscript is far enough along for a live KDP category sanity-check.',
      defaultPriceUsd: 4.99,
      defaultKuEnrolled: 0,
      aiGeneratedDefault: 0,
      aiAssistedDefault: 1
    },
    {
      key: 'ana-rourke',
      status: 'verified',
      voiceDescription: 'M/F erotica shorts with immediate heat, clear adult positioning, strong female agency, and compact reader payoff.',
      coreTropes: ['dark romance', 'enemies to lovers', 'instalove', 'strangers', 'forbidden romance'],
      targetAudience: 'Adult 18+ erotica-short readers who want explicit heat without a long wait.',
      verifiedCategories: [
        { path: 'Kindle Store > Kindle eBooks > Literature & Fiction > Erotica', rating: 'Fortress', notes: 'Required primary category for every Ana Rourke title.' },
        { path: 'Kindle Store > Kindle eBooks > Literature & Fiction > Erotica > Romantic', rating: 'Fortress', notes: 'Use for explicit and non-dark projects.' },
        { path: 'Kindle Store > Kindle eBooks > Literature & Fiction > Erotica > Dark', rating: 'Fortress', notes: 'Use for dark heat or CNC/dark-romance metadata.' }
      ],
      keywordStarterList: ['M/F erotica short story', 'steamy short read adult', 'forbidden romance explicit', 'alpha male erotica', 'kindle unlimited erotica'],
      categoryStrategyNotes: 'Ana Rourke uses a locked two-category template. Category 2 is derived from project.json heatLevel, cncPresent, and tropes.',
      defaultPriceUsd: 2.99,
      defaultKuEnrolled: 1,
      aiGeneratedDefault: 1,
      aiAssistedDefault: 1
    }
  ];

  const tx = sqlite.transaction((rows) => {
    rows.forEach((row) => {
      const pen = penByKey.get(row.key);
      if (!pen) return;
      insert.run({
        penNameId: pen.id,
        status: row.status,
        voiceDescription: row.voiceDescription,
        coreTropes: JSON.stringify(row.coreTropes),
        targetAudience: row.targetAudience,
        verifiedCategories: JSON.stringify(row.verifiedCategories),
        keywordStarterList: JSON.stringify(row.keywordStarterList),
        categoryStrategyNotes: row.categoryStrategyNotes,
        defaultPriceUsd: row.defaultPriceUsd,
        defaultKuEnrolled: row.defaultKuEnrolled,
        aiGeneratedDefault: row.aiGeneratedDefault,
        aiAssistedDefault: row.aiAssistedDefault
      });
    });
  });
  tx(defaults);
}
