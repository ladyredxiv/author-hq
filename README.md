# Author HQ Rebuild

Author HQ is a local-first Electron app for author-business and life management. It keeps day-to-day data in a private SQLite database on this computer and can optionally connect to Google Calendar, Buffer, EmailOctopus, Claude, and other services.

## What Is Included

- Single-user passphrase gate.
- SQLite database with Drizzle schema definitions.
- Author, Life, and Everything dashboard modes with releases, money, calendar, open loops, and social runway.
- Quick Log for natural-ish expense, income, subscription, book, milestone, weekly recap, routine, and life-task entries.
- Local expense, income, royalty, subscription, book, goal, milestone, journal, routine, and launch checklist tracking.
- Monthly calendar with local editing, drag-to-move, Google Calendar sync, and ICS export.
- Second Brain indexing, journal ingestion, maintenance review queue, and movable knowledge-base storage.
- Content scheduling table for manual posts and future Buffer publishing logic.
- Newsletter drafting interface plus EmailOctopus list stats hook.
- KDP listing packets, adult-category filtering, public book export, and launch tracking.
- Manuscript-aware KDP packets from DOCX, EPUB, PDF, TXT, Markdown, HTML, or chapter-by-chapter folders. Claude creates a reusable evidence-based book brief, description variants, keyword sets, and a validation report.
- KDP royalty XLSX imports with duplicate protection and KENP estimates.
- Manual/report-based ad tracking for Amazon and Meta with ROI/ACOS calculations.
- Ad copy generation interface using Claude when configured, or prompt-only fallback when not.
- One-time CSV import screen for the existing spreadsheet tabs.
- Automatic daily database backups with a manual Backup Now control in Settings.

## Port

The default port is `3131` so it does not collide with your existing `3000` or `3127` apps.

The Electron desktop app also avoids `3000` and `3127`. If `3131` is busy, it walks upward until it finds an open local port.

Change it in `.env`:

```env
PORT=3131
```

## Setup

```bash
cp .env.example .env
npm install
npm run electron:dev
```

For normal use, launch the Electron app. It starts the local database and app window for you.

Run the maintenance checks before packaging:

```bash
npm run check
npm test
```

## Desktop App / Executable

This project includes an Electron shell. It starts the local Express app internally and opens it in a desktop window.

Development:

```bash
npm run electron:dev
```

Build a Windows installer:

```bash
npm run package:win
```

Build an unpacked app folder for testing:

```bash
npm run package:dir
```

Packaged app data is stored in Electron's user-data folder, not beside the executable:

- SQLite database: `author-hq.sqlite`
- Local settings: `local-settings.json`

That keeps updates from overwriting your data.

Author HQ checks the database at startup and keeps up to 14 daily backups in a `backups` folder beside the database. Settings also has a **Backup Now** button.

## Environment Variables

Required for local auth:

```env
AUTH_PASSPHRASE=your-private-passphrase
COOKIE_SECRET=a-long-random-string
```

Optional service integrations:

```env
BUFFER_TOKEN=
BUFFER_ORGANIZATION_ID=
EMAILOCTOPUS_API_KEY=
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
CO_TEACHING_CREDITS_URL=
```

You can also enter these from inside the app at **Settings**. The Settings screen writes to a local untracked settings file and the app reads those values before falling back to `.env`.

Optional future Meta integration:

```env
META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=http://localhost:3131/integrations/meta/callback
```

## Importing Existing Spreadsheet Data

The app stores day-to-day data locally in SQLite. To bring the old spreadsheet over, download each Google Sheets tab as a CSV and upload it at **Import** inside Author HQ.

Supported tabs:

- `LaunchChecklists`
- `Goals`
- `Milestones`
- `Books`
- `Expenses`
- `Income`
- `Subscriptions`

Expected `LaunchChecklists` columns:

```text
Book Title | Item | Checked | Updated
```

Suggested `Goals` columns:

```text
Goal | Pen Name | Category | Status | Target Date | Progress | Notes
```

Expected `Milestones` columns:

```text
Date | Emoji | Title | Description | Notes | Pen Name
```

Expected `Books` columns:

```text
Title | Series | Series Position | Word Count | Pen Name | Status | Planned Release | Actual Release | Draft Complete | Editing Complete | Cover Ready | Formatted | Uploaded to KDP | Pre-order Live | Published / Live | Notes
```

Expected `Expenses` columns:

```text
Date | Vendor | Description | Category | Pen Name | Payment Method | Recurring | Amount | Receipt Saved | Notes
```

Expected `Income` columns:

```text
Date | Platform | Income Type | Amount | Notes
```

Expected `Subscriptions` columns:

```text
Service | Category | Monthly Cost | Billing Cycle | Renewal Date | Payment Method | Active | Notes | Annualized Cost
```

## Preserved Apps Script Features

The rebuild keeps the Apps Script functionality as modules:

- Chatbot-style log entry lives at `/chat`.
- Newsletter drafting lives at `/newsletter`.
- EmailOctopus list stats are pulled for configured pen names.
- Buffer health/runway appears on the dashboard.
- Book status can be logged through Quick Log.
- Subscription monthly set-aside math is built into `/subscriptions` and the dashboard.

## Ad Tracking

Manual ad tracking is available at `/ads`.

Fields:

- Campaign name
- Platform: Amazon or Meta
- Pen name
- Book
- Date range
- Spend
- Clicks
- Conversions
- Sales
- Revenue
- Notes

The table stores `source`, currently `manual`, so future Meta API pulls can write `meta_api` rows into the same table without changing the schema.

## Ad Copy Drafting

Use `/ad-copy` to draft ad angles and copy. If `ANTHROPIC_API_KEY` is blank, the app returns a structured prompt you can paste into Claude manually. If configured, it calls the Claude Messages API directly.

## Data Safety

- Installed updates do not overwrite the database or local settings.
- Database backups are separate from the installer and can be found from **Settings > Data Safety**.
- Do not commit `.env`, SQLite files, backups, or service credential JSON.
- The Brain knowledge-base folder can be moved independently from the app database.

## Public Repository Safety

This repository contains application source code, tests, icons, build scripts, and the public Kindle category reference data. It intentionally excludes:

- Your SQLite database and its backups.
- Local settings and API keys.
- OAuth tokens and Google client credentials.
- Imported manuscripts, royalty reports, journals, and Second Brain files.
- Generated installers and dependency folders.

Pen-name service IDs, Buffer channel IDs, writing-folder paths, and the co-teaching credits URL are configured locally in Author HQ. Never add `data/local-settings.json`, `.env`, or an installed app-data folder to Git.
