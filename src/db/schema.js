import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const timestamps = {
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`)
};

export const penNames = sqliteTable('pen_names', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  displayName: text('display_name').notNull(),
  brandDetails: text('brand_details', { mode: 'json' }).notNull().default('{}'),
  emailOctopusListId: text('email_octopus_list_id'),
  amazonAdsProfileId: text('amazon_ads_profile_id'),
  bufferChannels: text('buffer_channels', { mode: 'json' }).notNull().default('{}'),
  colorPalette: text('color_palette', { mode: 'json' }).notNull().default('{}'),
  fonts: text('fonts', { mode: 'json' }).notNull().default('{}'),
  socialHandles: text('social_handles', { mode: 'json' }).notNull().default('{}'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps
});

export const books = sqliteTable('books', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  title: text('title').notNull(),
  series: text('series'),
  seriesPosition: integer('series_position'),
  wordCount: integer('word_count').notNull().default(0),
  publicSlug: text('public_slug'),
  blurb: text('blurb'),
  coverImage: text('cover_image'),
  status: text('status').notNull().default('Planning'),
  plannedRelease: text('planned_release'),
  actualRelease: text('actual_release'),
  draftComplete: text('draft_complete'),
  editingComplete: text('editing_complete'),
  coverReady: text('cover_ready'),
  formatted: text('formatted'),
  uploadedKdp: text('uploaded_kdp'),
  preorderLive: text('preorder_live'),
  publishedLive: text('published_live'),
  audiobookProgress: integer('audiobook_progress').notNull().default(0),
  notes: text('notes'),
  ...timestamps
});

export const launchChecklists = sqliteTable('launch_checklists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bookId: integer('book_id').references(() => books.id),
  bookTitle: text('book_title').notNull(),
  item: text('item').notNull(),
  checked: integer('checked', { mode: 'boolean' }).notNull().default(false),
  updated: text('updated'),
  ...timestamps
});

export const goals = sqliteTable('goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  title: text('title').notNull(),
  category: text('category').notNull().default('General'),
  status: text('status').notNull().default('Active'),
  targetDate: text('target_date'),
  progress: integer('progress').notNull().default(0),
  notes: text('notes'),
  ...timestamps
});

export const milestones = sqliteTable('milestones', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  emoji: text('emoji').notNull().default('*'),
  title: text('title').notNull(),
  description: text('description'),
  notes: text('notes'),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  penNameLabel: text('pen_name_label').notNull().default('All'),
  ...timestamps
});

export const subscriptions = sqliteTable('subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service: text('service').notNull(),
  category: text('category').notNull().default('Software'),
  monthlyCost: real('monthly_cost').notNull().default(0),
  billingCycle: text('billing_cycle').notNull().default('Monthly'),
  renewalDate: text('renewal_date'),
  paymentMethod: text('payment_method'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  annualizedCost: real('annualized_cost').notNull().default(0),
  ...timestamps
});

export const expenses = sqliteTable('expenses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  vendor: text('vendor').notNull(),
  description: text('description'),
  category: text('category').notNull(),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  paymentMethod: text('payment_method'),
  recurring: integer('recurring', { mode: 'boolean' }).notNull().default(false),
  amount: real('amount').notNull(),
  receiptSaved: text('receipt_saved').notNull().default('No'),
  notes: text('notes'),
  ...timestamps
});

export const income = sqliteTable('income', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  platform: text('platform').notNull().default('Amazon KDP'),
  incomeType: text('income_type').notNull().default('Combined Payout'),
  amount: real('amount').notNull(),
  notes: text('notes'),
  ...timestamps
});

export const royaltyEntries = sqliteTable('royalty_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  periodStart: text('period_start'),
  periodEnd: text('period_end'),
  reportDate: text('report_date').notNull(),
  platform: text('platform').notNull().default('Amazon KDP'),
  marketplace: text('marketplace'),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  bookId: integer('book_id').references(() => books.id),
  title: text('title').notNull(),
  author: text('author'),
  format: text('format'),
  units: integer('units').notNull().default(0),
  freeUnits: integer('free_units').notNull().default(0),
  kenpRead: integer('kenp_read').notNull().default(0),
  royalty: real('royalty').notNull().default(0),
  currency: text('currency').notNull().default('USD'),
  sourceFile: text('source_file'),
  notes: text('notes'),
  ...timestamps
});

export const brainRoots = sqliteTable('brain_roots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
  folderPath: text('folder_path').notNull().unique(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastIndexedAt: text('last_indexed_at'),
  ...timestamps
});

export const brainDocuments = sqliteTable('brain_documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  rootId: integer('root_id').references(() => brainRoots.id),
  filePath: text('file_path').notNull().unique(),
  fileName: text('file_name').notNull(),
  extension: text('extension'),
  title: text('title'),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  bookId: integer('book_id').references(() => books.id),
  tags: text('tags', { mode: 'json' }).notNull().default('[]'),
  snippet: text('snippet'),
  sizeBytes: integer('size_bytes').notNull().default(0),
  modifiedAt: text('modified_at'),
  indexedAt: text('indexed_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  ...timestamps
});

export const brainNotes = sqliteTable('brain_notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  noteType: text('note_type').notNull().default('Decision'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  bookId: integer('book_id').references(() => books.id),
  sourcePath: text('source_path'),
  status: text('status').notNull().default('Active'),
  important: integer('important', { mode: 'boolean' }).notNull().default(false),
  ...timestamps
});

export const newsletterProjects = sqliteTable('newsletter_projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  penNameId: integer('pen_name_id').notNull().references(() => penNames.id),
  title: text('title').notNull(),
  topic: text('topic'),
  status: text('status').notNull().default('Active'),
  draftSubject: text('draft_subject'),
  draftPreview: text('draft_preview'),
  draftText: text('draft_text'),
  draftHtml: text('draft_html'),
  draftProvider: text('draft_provider'),
  draftWarning: text('draft_warning'),
  ...timestamps
});

export const newsletterMessages = sqliteTable('newsletter_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => newsletterProjects.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const calendarEvents = sqliteTable('calendar_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  eventDate: text('event_date').notNull(),
  eventTime: text('event_time'),
  eventType: text('event_type').notNull().default('General'),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  bookId: integer('book_id').references(() => books.id),
  status: text('status').notNull().default('Planned'),
  source: text('source').notNull().default('manual'),
  externalSource: text('external_source'),
  externalId: text('external_id'),
  externalUpdated: text('external_updated'),
  notes: text('notes'),
  ...timestamps
});

export const googleCalendarSync = sqliteTable('google_calendar_sync', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  localKey: text('local_key').notNull().unique(),
  googleEventId: text('google_event_id'),
  syncedAt: text('synced_at'),
  syncStatus: text('sync_status'),
  lastError: text('last_error'),
  ...timestamps
});

export const contentPosts = sqliteTable('content_posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  platform: text('platform').notNull(),
  channelId: text('channel_id'),
  content: text('content').notNull(),
  scheduledFor: text('scheduled_for'),
  status: text('status').notNull().default('draft'),
  source: text('source').notNull().default('manual'),
  externalId: text('external_id'),
  notes: text('notes'),
  ...timestamps
});

export const adEntries = sqliteTable('ad_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignName: text('campaign_name').notNull(),
  platform: text('platform').notNull(),
  source: text('source').notNull().default('manual'),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  bookId: integer('book_id').references(() => books.id),
  dateStart: text('date_start'),
  dateEnd: text('date_end'),
  spend: real('spend').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  conversions: integer('conversions').notNull().default(0),
  sales: integer('sales').notNull().default(0),
  revenue: real('revenue').notNull().default(0),
  profileId: text('profile_id'),
  externalId: text('external_id'),
  notes: text('notes'),
  ...timestamps
});

export const adCopyDrafts = sqliteTable('ad_copy_drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  penNameId: integer('pen_name_id').references(() => penNames.id),
  bookId: integer('book_id').references(() => books.id),
  platform: text('platform').notNull(),
  angle: text('angle'),
  headline: text('headline'),
  body: text('body').notNull(),
  cta: text('cta'),
  provider: text('provider').notNull().default('manual_or_stub'),
  prompt: text('prompt'),
  ...timestamps
});

export const oauthTokens = sqliteTable('oauth_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider').notNull(),
  accountId: text('account_id'),
  encryptedAccessToken: text('encrypted_access_token'),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  expiresAt: text('expires_at'),
  scopes: text('scopes'),
  ...timestamps
});
