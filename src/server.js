import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import { createDatabaseBackup, databaseMaintenanceStatus, initializeDatabase, sqlite } from './db/index.js';
import { handleLogin, handleLogout, loginPage, requireAuth } from './auth.js';
import { escapeHtml, formatPercent, layout, money, options } from './ui.js';
import { adMetrics, billingMonthlyEquivalent, parseJson, parseMoney, todayIso } from './utils.js';
import { parseLogText } from './services/chatParser.js';
import { chatNewsletterProject, draftNewsletter } from './services/newsletterService.js';
import { generateWithLlm } from './services/llmClient.js';
import { draftAdCopy } from './services/adCopyService.js';
import { generateKdpPacket, packetToFlatText } from './services/kdpListingService.js';
import { analyzeManuscript, effectiveManuscriptBrief } from './services/manuscriptAnalysisService.js';
import { extractManuscript, extractManuscriptCollection, manuscriptFingerprint } from './services/manuscriptExtractor.js';
import { royaltySheetMode, royaltyUnitBreakdown } from './services/royaltyImportService.js';
import { adultKdpCategoryWarning, isAdultKdpCategory } from './services/kdpCategoryRules.js';
import { publicBookPayload } from './services/publicBookExportService.js';
import { getBufferRunway } from './integrations/bufferClient.js';
import { getListStats } from './integrations/emailOctopusClient.js';
import {
  amazonAdsConfigured,
  amazonAdsConnected,
  downloadAmazonAdsReport,
  exchangeAmazonAdsCode,
  getAmazonAdsAuthUrl,
  listAmazonAdsProfiles,
  requestAmazonSponsoredProductsCampaignReport,
  waitForAmazonAdsReport
} from './integrations/amazonAdsClient.js';
import {
  disconnectGoogleCalendar,
  googleAuthUrl,
  googleCalendarConnected,
  googleCalendarConfigured,
  googleCalendarId,
  handleGoogleCallback,
  listGoogleCalendarEvents,
  listGoogleCalendars,
  saveGoogleCalendarId,
  upsertGoogleCalendarEvent
} from './integrations/googleCalendarClient.js';
import { getMetaAuthUrl, metaConfigured } from './integrations/metaApiClient.js';
import { allSettingKeys, getSetting, loadSettings, redactedSettings, saveSettings, settingsPath } from './config.js';

export const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: { fileSize: 32 * 1024 * 1024, files: 250 }
});
const DEFAULT_KENP_RATE = 0.00469;
let improvementScheduleRunning = false;
let improvementScheduleTimer = null;
let improvementScheduleStartupTimer = null;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/login', (req, res) => res.send(loginPage()));
app.post('/login', handleLogin);
app.get('/logout', handleLogout);
app.use(requireAuth);

app.get('/', async (req, res) => {
  try {
    const dashboardMode = ['author', 'life', 'everything'].includes(String(req.query.mode || '').toLowerCase()) ? String(req.query.mode).toLowerCase() : 'author';
    const showAuthor = dashboardMode !== 'life';
    const showLife = dashboardMode !== 'author';
    const adSummary = sqlite.prepare(`
      SELECT p.display_name AS pen_name, a.platform, SUM(a.spend) AS spend, SUM(a.revenue) AS revenue, SUM(a.clicks) AS clicks
      FROM ad_entries a
      LEFT JOIN pen_names p ON p.id = a.pen_name_id
      GROUP BY p.display_name, a.platform
      ORDER BY spend DESC
    `).all();
    const subscriptions = sqlite.prepare('SELECT * FROM subscriptions WHERE active = 1 ORDER BY renewal_date').all();
    const activeGoals = sqlite.prepare("SELECT COUNT(*) AS count FROM goals WHERE lower(status) NOT IN ('complete', 'completed', 'done', 'archived')").get().count;
    const recentMilestones = sqlite.prepare("SELECT COUNT(*) AS count FROM milestones WHERE date >= date('now', '-90 day')").get().count;
    const liveBooks = liveBooksRows(6);
    const liveBookCount = liveBooksRows(1000).length;
    const royaltySummary = royaltySummaryRows(5);
    const royaltyTotals = royaltyTotalsRow();
    const brainCount = sqlite.prepare('SELECT COUNT(*) AS count FROM brain_documents').get().count;
    const nextEvent = nextCalendarEvents(1)[0];
    const todayEvents = calendarEventsBetween(todayIso(), todayIso()).slice(0, 6);
    const openLifeTasks = lifeTasks({ status: 'Open', limit: 8 });
    const dueLifeTasks = lifeTasks({ status: 'Open', dueBefore: addDaysIso(todayIso(), 7), limit: 6 });
    const activeRoutines = lifeRoutines({ limit: 6 });
    const recentLifeLogs = lifeLogs({ limit: 5 });
    const overdueTasks = lifeTasks({ status: 'Open', dueBefore: addDaysIso(todayIso(), -1), includeUndated: false, limit: 1000 }).length;

    const monthlySetAside = subscriptions.reduce((sum, sub) => sum + billingMonthlyEquivalent(sub.monthly_cost, sub.billing_cycle), 0);

    const adSpend = adSummary.reduce((sum, row) => sum + Number(row.spend || 0), 0);
    const upcoming = allUpcomingBooks();
    const bufferCards = await Promise.all(allPenNames().map(async (pen) => ({
      pen,
      runway: await withTimeout(getBufferRunway(pen), 1400, { configured: true, channels: [], error: 'Timed out' })
    })));
    const loggedMessage = req.query.logged ? `<div class="notice good">Saved ${escapeHtml(req.query.logged)}.</div>` : '';

    res.send(layout('Dashboard', `
      ${dashboardModeSwitch(dashboardMode)}
      <div class="command-grid ${dashboardMode === 'everything' ? '' : 'dashboard-fit'}">
        <section class="card span-8 hero-panel">
          <div class="section-title-row">
            <div>
              <h2>${dashboardMode === 'life' ? 'Today' : dashboardMode === 'everything' ? 'Everything Dashboard' : 'Command Center'}</h2>
              <p class="muted">${dashboardMode === 'life' ? 'Schedule, open loops, routines, and notes at a glance.' : dashboardMode === 'everything' ? 'Author work and life admin in one scan.' : 'Money, releases, marketing, and admin at a glance.'}</p>
            </div>
            <div class="action-row">
              <a class="button secondary" href="/briefing">Briefing</a>
              <a class="button secondary" href="/calendar">Calendar</a>
              <a class="button secondary" href="${dashboardMode === 'life' ? '/life/tasks' : '/books'}">${dashboardMode === 'life' ? 'Add Task' : 'Add Book'}</a>
            </div>
          </div>
          <div class="metric-strip">
            ${showLife ? `
              <div class="metric-tile"><span class="eyebrow">Today</span><strong>${todayEvents.length}</strong><small>scheduled items</small></div>
              <div class="metric-tile"><span class="eyebrow">Open loops</span><strong>${openLifeTasks.length}</strong><small>${overdueTasks} overdue</small></div>
              <div class="metric-tile"><span class="eyebrow">Routines</span><strong>${activeRoutines.length}</strong><small>active rhythms</small></div>
              <div class="metric-tile"><span class="eyebrow">Life notes</span><strong>${recentLifeLogs.length}</strong><small>recent captures</small></div>
            ` : `
              <div class="metric-tile"><span class="eyebrow">Monthly subscriptions</span><strong>${money(monthlySetAside)}</strong><small>${money(monthlySetAside / 2)} per twice-monthly paycheck</small></div>
              <div class="metric-tile"><span class="eyebrow">Ad spend</span><strong>${money(adSpend)}</strong><small>manual and imported rows</small></div>
              <div class="metric-tile"><span class="eyebrow">Royalties</span><strong>${money(royaltyTotals.total_royalty)}</strong><small>${royaltyTotals.periods || 0} reporting periods tracked</small></div>
              <div class="metric-tile"><span class="eyebrow">Live books</span><strong data-testid="live-books-count">${liveBookCount}</strong><small>published or live &middot; ${brainCount} indexed docs</small></div>
            `}
          </div>
          <div class="next-event-card">
            <span class="eyebrow">${nextEvent ? 'Next Up' : 'Planning Pulse'}</span>
            ${nextEvent ? `
              <strong>${escapeHtml(nextEvent.title)}</strong>
              <small>${escapeHtml(nextEvent.event_date)}${nextEvent.event_type ? ` - ${escapeHtml(nextEvent.event_type)}` : ''}</small>
            ` : `
              <strong>${activeGoals} open goals</strong>
              <small>${recentMilestones} milestones in the last 90 days</small>
            `}
          </div>
        </section>

        <section class="card span-4 side-card quick-log-card">
          <div class="section-title-row">
            <div>
              <h2>Quick Log</h2>
              <p class="tiny">Expense, income, book update, weekly recap, and more.</p>
            </div>
            <a class="button secondary" href="/chat">Full Chat</a>
          </div>
          ${loggedMessage}
          ${logEntryForm({ returnTo: 'dashboard', compact: true })}
          ${logGuideDetails({ compact: true })}
        </section>

        ${showLife ? `
        <section class="card span-4 side-card dashboard-panel">
          <div class="section-title-row"><h2>Today</h2><a class="button secondary" href="/calendar">Calendar</a></div>
          ${todayEvents.length ? calendarMiniList(todayEvents) : '<p class="muted">No events scheduled today.</p>'}
        </section>
        <section class="card span-4 side-card dashboard-panel">
          <div class="section-title-row"><h2>Open Loops</h2><a class="button secondary" href="/life/tasks">Manage</a></div>
          ${dueLifeTasks.length ? lifeTasksTable(dueLifeTasks, { compact: true }) : '<p class="muted">No life tasks due soon.</p>'}
        </section>
        <section class="card span-4 side-card dashboard-panel">
          <div class="section-title-row"><h2>Routines</h2><a class="button secondary" href="/life/routines">Manage</a></div>
          ${activeRoutines.length ? lifeRoutinesTable(activeRoutines, { compact: true }) : '<p class="muted">No routines yet.</p>'}
        </section>
        ` : ''}

        ${showAuthor ? `
        <section class="card span-4 side-card dashboard-panel">
          <div class="section-title-row">
            <h2>Upcoming Releases</h2>
            <a class="button secondary" href="/books">Manage Books</a>
          </div>
          ${upcomingReleasesHtml(upcoming, 3, { compact: true })}
        </section>

        <section class="card span-4 dashboard-panel">
          <div class="section-title-row">
            <h2>Social Runway</h2>
            <a class="button secondary" href="/buffer-health">Full View</a>
          </div>
          ${socialRunwayDashboard(bufferCards, { maxPens: 2, maxChannels: 3 })}
        </section>

        <section class="card span-4 dashboard-panel">
          <div class="section-title-row">
            <h2>Royalty Performance</h2>
            <a class="button secondary" href="/royalties">Import Report</a>
          </div>
          ${royaltySummary.length ? table(['Title', 'Paid', 'Free', 'Royalty'], royaltySummary.map((row) => [row.title, row.units || 0, row.free_units || 0, money(row.royalty)])) : '<p class="muted">No royalty report rows imported yet.</p>'}
          ${liveBooks.length ? `<p class="tiny">${liveBookCount} live books tracked. Latest: ${escapeHtml(liveBooks[0].title)}</p>` : ''}
        </section>
        ` : ''}
      </div>
    `, { active: 'dashboard' }));
  } catch (error) {
    res.status(500).send(layout('Dashboard Error', `<section class="card"><h2>Dashboard Error</h2><pre>${escapeHtml(error.stack || error.message)}</pre></section>`));
  }
});

app.get('/chat', (req, res) => {
  res.send(layout('Log Chat', `
    <section class="card">
      <div class="section-title-row">
        <div>
          <h2>Log Chat</h2>
          <p class="muted">Type naturally. This parser handles common expense, income, subscription, book, milestone, and weekly summary entries.</p>
        </div>
        <a class="button secondary" href="/">Dashboard</a>
      </div>
      ${logEntryForm({ returnTo: 'chat' })}
      ${logGuideDetails()}
    </section>
  `, { active: 'chat' }));
});

app.post('/chat', asyncRoute(async (req, res) => {
  const parsed = parseLogText(req.body.text || '', { penNames: allPenNames(), books: allBooks() });
  await saveParsedEntry(parsed);
  if (req.body.returnTo === 'dashboard') {
    res.redirect(`/?logged=${encodeURIComponent(parsed.type)}`);
    return;
  }
  if (req.body.returnTo === 'life') {
    res.redirect(`/life?logged=${encodeURIComponent(parsed.type)}`);
    return;
  }
  res.send(layout('Log Chat', `
    <div class="chat">
      <div class="bubble user">${escapeHtml(req.body.text || '')}</div>
      <div class="bubble assistant"><strong>Saved as ${escapeHtml(parsed.type)}.</strong><pre>${escapeHtml(JSON.stringify(parsed, null, 2))}</pre></div>
    </div>
    <p><a class="button secondary" href="/chat">Log another</a></p>
  `, { active: 'chat' }));
}));

app.get('/briefing', (req, res) => {
  const today = todayIso();
  const todaysEvents = calendarEventsBetween(today, today);
  const nextEvents = combinedCalendarEvents(14).slice(0, 8);
  const coTeaching = combinedCalendarEvents(30).filter((event) => String(event.event_type || '').toLowerCase().includes('teach')).slice(0, 8);
  const upcoming = allUpcomingBooks().slice(0, 5);
  const activeGoals = decorateGoals(sqlite.prepare(`
    SELECT g.*, p.display_name AS pen_name
    FROM goals g LEFT JOIN pen_names p ON p.id = g.pen_name_id
    WHERE lower(g.status) NOT IN ('complete', 'completed', 'done', 'archived')
    ORDER BY COALESCE(g.target_date, '9999-12-31'), g.id DESC
    LIMIT 6
  `).all());
  res.send(layout('Morning Briefing', `
    <div class="grid">
      <section class="card span-8 hero-panel">
        <div class="section-title-row">
          <div>
            <h2>Morning Briefing</h2>
            <p class="muted">A quiet daily scan: schedule, co-teaching, releases, and goals.</p>
          </div>
          <div class="action-row"><a class="button secondary" href="/calendar">Edit Calendar</a>${coTeachingCreditsButton()}</div>
        </div>
        ${morningBriefingHero({ today, todaysEvents, nextEvents, coTeaching })}
      </section>
      <section class="card span-4 side-card"><h2>End Of Week Summary</h2>${weeklySummaryForm()}</section>
      <section class="card span-6"><div class="section-title-row"><h2>Co-teaching</h2>${coTeachingCreditsButton()}</div>${coTeaching.length ? calendarMiniList(coTeaching) : '<p class="muted">No co-teaching events scheduled yet. Add one on the Calendar page.</p>'}</section>
      <section class="card span-6"><h2>Upcoming Releases</h2>${upcomingReleasesHtml(upcoming, 5)}</section>
      <section class="card span-12"><h2>Active Goals</h2>${activeGoals.length ? table(['Goal','Pen','Target','Progress','Status'], activeGoals.map((goal) => [goal.title, goal.pen_name || 'All', goal.target_date || '', `${goal.progress || 0}%`, goal.status])) : '<p class="muted">No active goals yet.</p>'}</section>
    </div>
  `, { active: 'briefing' }));
});

app.post('/briefing/week-summary', async (req, res) => {
  try {
    const result = await saveWeeklySummary(req.body);
    res.send(layout('Weekly Summary Saved', `
      <section class="card">
        <h2>Weekly Summary Saved</h2>
        <p class="muted">Saved to Brain and the Knowledge Base.</p>
        <p class="tiny">${escapeHtml(result.outputPath)}</p>
        <p><a class="button secondary" href="/briefing">Back to Briefing</a></p>
      </section>
    `, { active: 'briefing' }));
  } catch (error) {
    res.status(500).send(layout('Weekly Summary Error', `<section class="card"><h2>Weekly Summary Error</h2><p class="muted">${escapeHtml(error.message)}</p></section><p><a class="button secondary" href="/briefing">Back</a></p>`, { active: 'briefing' }));
  }
});

app.get('/life', (req, res) => {
  const today = todayIso();
  const todaysEvents = calendarEventsBetween(today, today);
  const tasks = lifeTasks({ status: 'Open', dueBefore: addDaysIso(today, 7), limit: 12 });
  const routines = lifeRoutines({ limit: 8 });
  const logs = lifeLogs({ limit: 8 });
  res.send(layout('Today', `
    <div class="grid">
      <section class="card span-8 hero-panel">
        <div class="section-title-row">
          <div>
            <h2>Today</h2>
            <p class="muted">A life-side scan: schedule, open loops, routines, and recent notes.</p>
          </div>
          <div class="action-row"><a class="button secondary" href="/?mode=life">Life Dashboard</a><a class="button secondary" href="/calendar">Calendar</a>${coTeachingCreditsButton()}</div>
        </div>
        ${morningBriefingHero({ today, todaysEvents, nextEvents: combinedCalendarEvents(14).slice(0, 8), coTeaching: combinedCalendarEvents(30).filter((event) => String(event.event_type || '').toLowerCase().includes('teach')).slice(0, 8) })}
      </section>
      <section class="card span-4 side-card quick-log-card"><h2>Life Log</h2>${logEntryForm({ returnTo: 'life', compact: true })}${logGuideDetails({ compact: true })}</section>
      <section class="card span-6"><div class="section-title-row"><h2>Open Loops</h2><a class="button secondary" href="/life/tasks">Manage</a></div>${tasks.length ? lifeTasksTable(tasks) : '<p class="muted">No open life tasks due soon.</p>'}</section>
      <section class="card span-6"><div class="section-title-row"><h2>Routines</h2><a class="button secondary" href="/life/routines">Manage</a></div>${routines.length ? lifeRoutinesTable(routines) : '<p class="muted">No routines yet.</p>'}</section>
      <section class="card span-12"><h2>Recent Life Notes</h2>${logs.length ? lifeLogsTable(logs) : '<p class="muted">No life notes yet.</p>'}</section>
    </div>
  `, { active: 'life' }));
});

app.get('/journal', (req, res) => {
  const entries = journalEntries({ limit: 25 });
  const saved = req.query.saved ? '<div class="notice good">Journal entry saved to Brain.</div>' : '';
  res.send(layout('Journal', `
    <div class="grid">
      <section class="card span-7">
        <div class="section-title-row">
          <div>
            <h2>Journal</h2>
            <p class="muted">A quiet place to capture the day as it happens. Entries feed your weekly recap and Brain.</p>
          </div>
          <a class="button secondary" href="/briefing">Weekly Summary</a>
        </div>
        ${saved}
        ${journalEntryForm()}
      </section>
      <section class="card span-5">
        <h2>Recent Entries</h2>
        ${entries.length ? journalEntriesList(entries) : '<p class="muted">No journal entries yet.</p>'}
      </section>
    </div>
  `, { active: 'journal' }));
});

app.post('/journal', (req, res) => {
  try {
    saveJournalEntry(req.body);
    res.redirect('/journal?saved=1');
  } catch (error) {
    res.status(500).send(layout('Journal Error', `<section class="card"><h2>Journal Error</h2><p class="muted">${escapeHtml(error.message)}</p><p><a class="button secondary" href="/journal">Back to Journal</a></p></section>`, { active: 'journal' }));
  }
});

app.get('/life/tasks', (req, res) => {
  const tasks = lifeTasks({ status: req.query.status || 'Open', limit: 100 });
  res.send(layout('Open Loops', `
    <div class="grid">
      <section class="card span-4 side-card"><h2>Add Open Loop</h2>${lifeTaskForm()}</section>
      <section class="card span-8">
        <div class="section-title-row"><h2>Open Loops</h2><a class="button secondary" href="/life/tasks?status=All">Show All</a></div>
        ${tasks.length ? lifeTasksTable(tasks) : '<p class="muted">No matching tasks.</p>'}
      </section>
    </div>
  `, { active: 'tasks' }));
});

app.post('/life/tasks', (req, res) => {
  sqlite.prepare(`
    INSERT INTO life_tasks (title, category, status, due_date, priority, energy, notes, source)
    VALUES (@title, @category, 'Open', @dueDate, @priority, @energy, @notes, 'manual')
  `).run({
    title: String(req.body.title || '').trim() || 'Untitled task',
    category: req.body.category || 'General',
    dueDate: normalizeDate(req.body.dueDate) || '',
    priority: req.body.priority || 'Normal',
    energy: req.body.energy || '',
    notes: req.body.notes || ''
  });
  res.redirect('/life/tasks');
});

app.post('/life/tasks/:id/complete', (req, res) => {
  sqlite.prepare("UPDATE life_tasks SET status = 'Done', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
  res.redirect(req.body.returnTo || '/life/tasks');
});

app.get('/life/routines', (req, res) => {
  const routines = lifeRoutines({ includeInactive: true, limit: 100 });
  res.send(layout('Routines', `
    <div class="grid">
      <section class="card span-4 side-card"><h2>Add Routine</h2>${lifeRoutineForm()}</section>
      <section class="card span-8"><h2>Routines</h2>${routines.length ? lifeRoutinesTable(routines) : '<p class="muted">No routines yet.</p>'}</section>
    </div>
  `, { active: 'routines' }));
});

app.post('/life/routines', (req, res) => {
  sqlite.prepare(`
    INSERT INTO life_routines (title, category, cadence, next_due, status, notes)
    VALUES (@title, @category, @cadence, @nextDue, 'Active', @notes)
  `).run({
    title: String(req.body.title || '').trim() || 'Untitled routine',
    category: req.body.category || 'General',
    cadence: req.body.cadence || 'Weekly',
    nextDue: normalizeDate(req.body.nextDue) || '',
    notes: req.body.notes || ''
  });
  res.redirect('/life/routines');
});

app.post('/life/routines/:id/toggle', (req, res) => {
  const routine = sqlite.prepare('SELECT * FROM life_routines WHERE id = ?').get(req.params.id);
  if (routine) {
    sqlite.prepare('UPDATE life_routines SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(routine.status === 'Active' ? 'Paused' : 'Active', routine.id);
  }
  res.redirect('/life/routines');
});

app.get('/books', (req, res) => {
  const rows = sqlite.prepare(`
    SELECT b.*, p.display_name AS pen_name FROM books b
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
    ORDER BY COALESCE(b.planned_release, b.actual_release, b.updated_at) DESC
  `).all();
  res.send(layout('Books', `
    <section class="card"><h2>Add Book</h2>${bookForm()}</section>
    <section><h2>Books</h2>${booksTable(rows)}</section>
  `, { active: 'books' }));
});

app.get('/books/:id/edit', (req, res) => {
  const book = sqlite.prepare(`
    SELECT b.*, p.display_name AS pen_name FROM books b
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!book) {
    res.status(404).send(layout('Book Not Found', '<section class="card"><h2>Book not found</h2><p><a class="button secondary" href="/books">Back to Books</a></p></section>', { active: 'books' }));
    return;
  }
  res.send(layout(`Edit ${book.title}`, `
    <section class="card">
      <div class="section-title-row"><h2>Edit Book</h2><a class="button secondary" href="/books">Back</a></div>
      ${bookForm(book)}
    </section>
  `, { active: 'books' }));
});

app.post('/books', (req, res) => {
  const existing = req.body.id ? sqlite.prepare('SELECT * FROM books WHERE id = ?').get(req.body.id) : null;
  const payload = {
    id: req.body.id || null,
    penNameId: req.body.penNameId || null,
    title: req.body.title,
    series: req.body.series || '',
    seriesPosition: req.body.seriesPosition ? Number(req.body.seriesPosition) : null,
    wordCount: Math.max(0, Math.round(Number(String(req.body.wordCount || '0').replaceAll(',', '')) || 0)),
    publicSlug: String(req.body.publicSlug || '').trim() || slugify(req.body.title),
    blurb: req.body.blurb || '',
    coverImage: req.body.coverImage || '',
    status: req.body.status || 'Planning',
    plannedRelease: req.body.plannedRelease || '',
    actualRelease: req.body.actualRelease || '',
    notes: req.body.notes || ''
  };
  if (existing) {
    sqlite.prepare(`
      UPDATE books SET pen_name_id=@penNameId, title=@title, series=@series, series_position=@seriesPosition, word_count=@wordCount, public_slug=@publicSlug,
        blurb=@blurb, cover_image=@coverImage, status=@status, planned_release=@plannedRelease,
        actual_release=@actualRelease, notes=@notes, updated_at=CURRENT_TIMESTAMP
      WHERE id=@id
    `).run(payload);
  } else {
    sqlite.prepare(`
      INSERT INTO books (pen_name_id, title, series, series_position, word_count, public_slug, blurb, cover_image, status, planned_release, actual_release, notes)
      VALUES (@penNameId, @title, @series, @seriesPosition, @wordCount, @publicSlug, @blurb, @coverImage, @status, @plannedRelease, @actualRelease, @notes)
    `).run(payload);
  }
  res.redirect('/books');
});

app.post('/books/:id/delete', (req, res) => {
  const book = bookById(req.params.id);
  if (!book) {
    res.redirect('/books');
    return;
  }
  const tx = sqlite.transaction((bookId) => {
    sqlite.prepare('DELETE FROM launch_checklists WHERE book_id = ? OR book_title = ?').run(bookId, book.title);
    sqlite.prepare('UPDATE kdp_listings SET book_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE book_id = ?').run(bookId);
    sqlite.prepare('UPDATE ad_entries SET book_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE book_id = ?').run(bookId);
    sqlite.prepare('UPDATE ad_copy_drafts SET book_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE book_id = ?').run(bookId);
    sqlite.prepare('UPDATE royalty_entries SET book_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE book_id = ?').run(bookId);
    sqlite.prepare('UPDATE brain_documents SET book_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE book_id = ?').run(bookId);
    sqlite.prepare('UPDATE brain_notes SET book_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE book_id = ?').run(bookId);
    sqlite.prepare('UPDATE calendar_events SET book_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE book_id = ?').run(bookId);
    sqlite.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  });
  tx(book.id);
  res.redirect('/books');
});

app.get('/brain', (req, res) => {
  const q = String(req.query.q || '').trim();
  const roots = brainRoots();
  const docs = q ? searchBrainDocuments(q, 80) : recentBrainDocuments(80);
  const notes = q ? searchBrainNotes(q, 80) : recentBrainNotes(20);
  const totals = sqlite.prepare('SELECT COUNT(*) AS count, MAX(indexed_at) AS last_indexed FROM brain_documents').get();
  const noteTotals = sqlite.prepare('SELECT COUNT(*) AS count FROM brain_notes').get();
  const improvementRuns = recentImprovementRuns(8);
  const improvementItems = improvementItemsForReview({ status: 'Proposed', limit: 8 });
  const reviewCounts = improvementReviewCounts();
  res.send(layout('Brain', `
    <div class="grid">
      <section class="card span-8 hero-panel">
        <div class="section-title-row">
          <div>
            <h2>Author Brain</h2>
            <p class="muted">One local map for manuscripts, notes, bibles, blurbs, launch docs, and stray book materials.</p>
          </div>
          <form method="post" action="/brain/index"><button>Scan All</button></form>
        </div>
        <div class="metric-strip">
          <div class="metric-tile"><span class="eyebrow">Indexed docs</span><strong>${totals.count || 0}</strong><small>${totals.last_indexed ? `last scan ${formatDateTime(totals.last_indexed)}` : 'not scanned yet'}</small></div>
          <div class="metric-tile"><span class="eyebrow">Roots</span><strong>${roots.length}</strong><small>registered writing folders</small></div>
          <div class="metric-tile"><span class="eyebrow">Brain notes</span><strong>${noteTotals.count || 0}</strong><small>facts, decisions, corrections</small></div>
          <div class="metric-tile"><span class="eyebrow">Search</span><strong>${q ? docs.length + notes.length : 0}</strong><small>${q ? 'matching items' : 'enter a term'}</small></div>
        </div>
      </section>
      <section class="card span-4 side-card"><h2>Capture Note</h2>${brainNoteForm()}</section>
      <section class="card span-12">
        <div class="section-title-row">
          <div>
            <h2>Improve HQ</h2>
            <p class="muted">Local knowledge-base runs for files, wiki summaries, and reviewable improvement ideas.</p>
          </div>
          <div class="action-row"><span class="pill">${escapeHtml(knowledgeBaseRoot())}</span><a class="button secondary" href="#brain-storage">Move Storage</a><a class="button secondary" href="/brain/improvements">Full Review Queue</a></div>
        </div>
        <div class="action-row">
          <form method="post" action="/brain/kb/setup"><button class="secondary">Set Up Knowledge Base</button></form>
          <form method="post" action="/brain/kb/sync"><button>Sync Writing Folders</button></form>
          <form method="post" action="/brain/improve"><button class="secondary">Suggest Improvements</button></form>
          <form method="post" action="/brain/maintenance"><button class="secondary">Run Brain Maintenance</button></form>
        </div>
        ${knowledgeBaseMoveForm()}
        ${improvementSchedulePanel()}
        <div class="grid" style="margin-top:14px">
          <section class="span-6">${improvementRuns.length ? improvementRunsTable(improvementRuns) : '<p class="muted">No improvement runs yet.</p>'}</section>
          <section class="span-6">
            <div class="section-title-row"><h2>Open Review Items</h2><a class="button secondary" href="/brain/improvements">Review All</a></div>
            <p class="tiny">${escapeHtml(reviewCounts.proposed || 0)} proposed, ${escapeHtml(reviewCounts.planned || 0)} planned, ${escapeHtml(reviewCounts.applied || 0)} applied.</p>
            ${improvementItems.length ? improvementItemsTable(improvementItems, { compact: true }) : '<p class="muted">No proposed review items. Applied and resolved items are tucked into the full queue.</p>'}
          </section>
        </div>
      </section>
      <section class="card span-12">
        <div class="section-title-row"><h2>Search Brain</h2><a class="button secondary" href="/brain">Recent</a></div>
        <form class="row" method="get" action="/brain">
          <input name="q" value="${escapeHtml(q)}" placeholder="Search title, path, snippet, tag, book, pen name...">
          <button class="secondary">Search</button>
        </form>
      </section>
      <section class="card span-5 side-card"><h2>Add Folder</h2>${brainRootForm()}</section>
      <section class="card span-7">
        <h2>${q ? 'Note Matches' : 'Recent Notes'}</h2>
        ${notes.length ? brainNotesTable(notes) : '<p class="muted">No Brain notes yet.</p>'}
      </section>
      <section class="card span-5 side-card">
        <h2>Folders</h2>
        ${roots.length ? brainRootsTable(roots) : '<p class="muted">No folders registered yet.</p>'}
      </section>
      <section class="card span-7">
        <h2>${q ? 'Matches' : 'Recent Documents'}</h2>
        ${docs.length ? brainDocumentsTable(docs) : '<p class="muted">No indexed documents yet. Scan your folders to build the map.</p>'}
      </section>
    </div>
  `, { active: 'brain' }));
});

app.post('/brain/notes', (req, res) => {
  sqlite.prepare(`
    INSERT INTO brain_notes (note_type, title, body, pen_name_id, book_id, source_path, status, important)
    VALUES (@noteType, @title, @body, @penNameId, @bookId, @sourcePath, @status, @important)
  `).run({
    noteType: req.body.noteType || 'Decision',
    title: req.body.title,
    body: req.body.body || '',
    penNameId: req.body.penNameId || null,
    bookId: req.body.bookId || null,
    sourcePath: req.body.sourcePath || '',
    status: req.body.status || 'Active',
    important: req.body.important ? 1 : 0
  });
  res.redirect('/brain');
});

app.post('/brain/roots', (req, res) => {
  const folderPath = String(req.body.folderPath || '').trim();
  if (folderPath) {
    sqlite.prepare(`
      INSERT INTO brain_roots (label, folder_path, active)
      VALUES (@label, @folderPath, 1)
      ON CONFLICT(folder_path) DO UPDATE SET label=@label, active=1, updated_at=CURRENT_TIMESTAMP
    `).run({ label: req.body.label || path.basename(folderPath) || folderPath, folderPath });
  }
  res.redirect('/brain');
});

app.post('/brain/roots/:id/toggle', (req, res) => {
  sqlite.prepare('UPDATE brain_roots SET active = CASE active WHEN 1 THEN 0 ELSE 1 END, updated_at=CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.redirect('/brain');
});

app.post('/brain/index', (req, res) => {
  const result = indexBrainRoots();
  res.send(layout('Brain Scan Complete', `
    <section class="card">
      <h2>Brain Scan Complete</h2>
      <p class="muted">Indexed ${result.indexed} files. Skipped ${result.skipped} files or folders.</p>
      ${result.errors.length ? `<pre>${escapeHtml(result.errors.slice(0, 12).join('\n'))}</pre>` : ''}
      <p><a class="button secondary" href="/brain">Back to Brain</a></p>
    </section>
  `, { active: 'brain' }));
});

app.post('/brain/kb/setup', (req, res) => {
  const result = setupKnowledgeBase();
  res.send(layout('Knowledge Base Ready', `
    <section class="card">
      <h2>Knowledge Base Ready</h2>
      <p class="muted">Created or verified ${result.created.length} folders.</p>
      <p class="tiny">${escapeHtml(result.root)}</p>
      <p><a class="button secondary" href="/brain">Back to Brain</a></p>
    </section>
  `, { active: 'brain' }));
});

app.post('/brain/kb/move', (req, res) => {
  try {
    const targetRoot = String(req.body.knowledgeBaseRoot || '').trim();
    if (!targetRoot) throw new Error('Add a destination folder path first.');
    const cleanupMode = req.body.cleanupMode || 'archive';
    const result = moveKnowledgeBaseRoot(targetRoot, { cleanupMode });
    res.send(layout('Knowledge Base Moved', `
      <section class="card">
        <h2>Knowledge Base Moved</h2>
        <p class="muted">Author HQ will now write Brain knowledge-base files to:</p>
        <p><code>${escapeHtml(result.newRoot)}</code></p>
        <p class="tiny">${escapeHtml(result.cleanupMessage)}</p>
        <p><a class="button secondary" href="/brain">Back to Brain</a></p>
      </section>
    `, { active: 'brain' }));
  } catch (error) {
    res.status(500).send(layout('Knowledge Base Move Error', `<section class="card"><h2>Move Error</h2><p class="muted">${escapeHtml(error.message)}</p></section><p><a class="button secondary" href="/brain">Back</a></p>`, { active: 'brain' }));
  }
});

app.post('/brain/kb/sync', async (req, res) => {
  try {
    const result = await syncKnowledgeBase();
    res.send(layout('Knowledge Base Synced', `
      <section class="card">
        <h2>Knowledge Base Synced</h2>
        <p class="muted">${escapeHtml(result.summary)}</p>
        <p class="tiny">${escapeHtml(result.outputPath || '')}</p>
        <p><a class="button secondary" href="/brain">Back to Brain</a></p>
      </section>
    `, { active: 'brain' }));
  } catch (error) {
    res.status(500).send(layout('Knowledge Base Sync Error', `<section class="card"><h2>Sync Error</h2><p class="muted">${escapeHtml(error.message)}</p></section><p><a class="button secondary" href="/brain">Back</a></p>`, { active: 'brain' }));
  }
});

app.post('/brain/improve', async (req, res) => {
  try {
    const result = await suggestAuthorHqImprovements();
    res.send(layout('Improvement Review Ready', `
      <section class="card">
        <h2>Improvement Review Ready</h2>
        <p class="muted">${escapeHtml(result.summary)}</p>
        <p class="tiny">${escapeHtml(result.outputPath || '')}</p>
        <p><a class="button secondary" href="/brain">Back to Brain</a></p>
      </section>
    `, { active: 'brain' }));
  } catch (error) {
    res.status(500).send(layout('Improvement Error', `<section class="card"><h2>Improvement Error</h2><p class="muted">${escapeHtml(error.message)}</p></section><p><a class="button secondary" href="/brain">Back</a></p>`, { active: 'brain' }));
  }
});

app.post('/brain/maintenance', (req, res) => {
  try {
    const result = runBrainMaintenance();
    res.send(layout('Brain Maintenance Complete', `
      <section class="card">
        <h2>Brain Maintenance Complete</h2>
        <p class="muted">${escapeHtml(result.summary)}</p>
        <ul>
          <li>Index: <code>${escapeHtml(result.indexPath)}</code></li>
          <li>Duplicate index rows removed: ${escapeHtml(result.duplicatesRemoved)}</li>
          <li>Copyedit archive report: <code>${escapeHtml(result.copyeditReportPath)}</code></li>
        </ul>
        <p><a class="button secondary" href="/brain">Back to Brain</a></p>
      </section>
    `, { active: 'brain' }));
  } catch (error) {
    res.status(500).send(layout('Brain Maintenance Error', `<section class="card"><h2>Brain Maintenance Error</h2><p class="muted">${escapeHtml(error.message)}</p><p><a class="button secondary" href="/brain">Back</a></p></section>`, { active: 'brain' }));
  }
});

app.post('/brain/improvement-schedule', (req, res) => {
  saveSettings({
    IMPROVEMENT_SCHEDULE_ENABLED: req.body.enabled ? '1' : '0',
    IMPROVEMENT_SCHEDULE_DAY: req.body.day || '5',
    IMPROVEMENT_SCHEDULE_TIME: req.body.time || '17:00'
  });
  res.redirect('/brain');
});

app.get('/brain/improvements', (req, res) => {
  const filters = {
    status: String(req.query.status || 'Proposed'),
    bucket: String(req.query.bucket || 'All')
  };
  const items = improvementItemsForReview({ ...filters, limit: 250 });
  const counts = improvementReviewCounts();
  res.send(layout('Review Queue', `
    <section class="card">
      <div class="section-title-row">
        <div>
          <h2>Review Queue</h2>
          <p class="muted">Scroll through proposed improvements, bring back planned work, and review applied decisions when needed.</p>
        </div>
        <a class="button secondary" href="/brain">Back to Brain</a>
      </div>
      <div class="metric-strip">
        <div class="metric-tile"><span class="eyebrow">Proposed</span><strong>${escapeHtml(counts.proposed || 0)}</strong><small>needs review</small></div>
        <div class="metric-tile"><span class="eyebrow">Planned</span><strong>${escapeHtml(counts.planned || 0)}</strong><small>ready to work on</small></div>
        <div class="metric-tile"><span class="eyebrow">Applied</span><strong>${escapeHtml(counts.applied || 0)}</strong><small>already handled</small></div>
        <div class="metric-tile"><span class="eyebrow">Resolved</span><strong>${escapeHtml(counts.resolved || 0)}</strong><small>decisions saved</small></div>
      </div>
      ${improvementFilterForm(filters)}
    </section>
    <section class="card review-queue-panel">
      ${items.length ? improvementItemsTable(items, { full: true }) : '<p class="muted">No review items match that filter.</p>'}
    </section>
  `, { active: 'brain' }));
});

app.get('/brain/improvements/:id/resolve', (req, res) => {
  const item = improvementItemById(req.params.id);
  if (!item) {
    res.status(404).send(layout('Review Item Not Found', '<section class="card"><h2>Review item not found</h2><p><a class="button secondary" href="/brain">Back to Brain</a></p></section>', { active: 'brain' }));
    return;
  }
  res.send(layout('Resolve Review Item', `
    <section class="card">
      <div class="section-title-row">
        <div>
          <h2>Resolve Review Item</h2>
          <p class="muted">Turn this into a decision, planned task, or dismiss it as not useful.</p>
        </div>
        <a class="button secondary" href="/brain">Back</a>
      </div>
      <div class="review-item-focus">
        <span class="pill">${escapeHtml(item.bucket)}</span>
        <h3>${escapeHtml(item.title)}</h3>
        ${item.body ? `<p class="muted">${escapeHtml(item.body)}</p>` : ''}
      </div>
      ${improvementResolutionForm(item)}
    </section>
  `, { active: 'brain' }));
});

app.post('/brain/improvements/:id/resolve', (req, res) => {
  const item = improvementItemById(req.params.id);
  if (!item) {
    res.redirect('/brain');
    return;
  }
  const action = req.body.action || 'resolved';
  if (action === 'apply') {
    const result = applyImprovementItem(item);
    sqlite.prepare(`
      UPDATE hq_improvement_items
      SET status = @status, resolution_note_id = @noteId, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ id: item.id, status: result.status, noteId: result.noteId });
    res.redirect('/brain');
    return;
  }
  let noteId = null;
  if (String(req.body.answer || '').trim()) {
    noteId = sqlite.prepare(`
      INSERT INTO brain_notes (note_type, title, body, source_path, status, important)
      VALUES (@noteType, @title, @body, @sourcePath, 'Active', @important)
    `).run({
      noteType: action === 'planned' ? 'Workflow' : 'Decision',
      title: `Review decision: ${item.title}`.slice(0, 180),
      body: String(req.body.answer || '').trim(),
      sourcePath: `improvement-item:${item.id}`,
      important: action === 'dismissed' ? 0 : 1
    }).lastInsertRowid;
  }
  const status = action === 'planned' ? 'Planned' : action === 'dismissed' ? 'Dismissed' : 'Resolved';
  sqlite.prepare(`
    UPDATE hq_improvement_items
    SET status = @status, resolution_note_id = @noteId, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id: item.id, status, noteId });
  res.redirect('/brain');
});

app.post('/brain/improvements/:id/reopen', (req, res) => {
  sqlite.prepare(`
    UPDATE hq_improvement_items
    SET status = 'Proposed', resolved_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);
  res.redirect('/brain/improvements?status=Proposed');
});

app.get('/calendar', async (req, res) => {
  const events = combinedCalendarEvents();
  const monthData = calendarMonthData(req.query.month);
  let googleCalendars = [];
  let googleError = '';
  if (googleCalendarConnected()) {
    try {
      googleCalendars = await listGoogleCalendars(baseUrl(req));
    } catch (error) {
      googleError = error.message;
    }
  }
  const googleConnectUrl = googleCalendarConfigured() && !googleCalendarConnected() ? googleAuthUrl(baseUrl(req)) : '';
  res.send(layout('Calendar', `
    <div class="grid">
      <section class="card span-12 calendar-month-card">
        <div class="section-title-row">
          <div>
            <h2>Author Calendar</h2>
            <p class="muted">Release dates, launch milestones, goals, newsletters, promos, and manual reminders in one local view.</p>
          </div>
          <div class="action-row">
            <button class="secondary" type="button" data-open-event-modal="${todayIso()}">Add Event</button>
            <form method="post" action="/calendar/sync/google"><button class="secondary" ${googleCalendarConnected() ? '' : 'disabled'}>Sync Google Both Ways</button></form>
            <a class="button secondary" href="/calendar.ics">Export ICS</a>
          </div>
        </div>
        ${calendarMonthView(monthData)}
      </section>
      <section class="card span-12">${googleCalendarPanel(googleCalendars, googleError, googleConnectUrl)}</section>
      <section class="card span-12"><h2>Upcoming</h2>${events.length ? calendarEventsTable(events.slice(0, 80)) : '<p class="muted">No upcoming events yet.</p>'}</section>
    </div>
    ${calendarEventModal()}
  `, { active: 'calendar' }));
});

app.post('/calendar', (req, res) => {
  sqlite.prepare(`
    INSERT INTO calendar_events (title, event_date, event_time, event_type, pen_name_id, book_id, status, source, notes)
    VALUES (@title, @eventDate, @eventTime, @eventType, @penNameId, @bookId, @status, 'manual', @notes)
  `).run({
    title: req.body.title,
    eventDate: req.body.eventDate || todayIso(),
    eventTime: req.body.eventTime || '',
    eventType: req.body.eventType || 'General',
    penNameId: req.body.penNameId || null,
    bookId: req.body.bookId || null,
    status: req.body.status || 'Planned',
    notes: req.body.notes || ''
  });
  res.redirect('/calendar');
});

app.get('/calendar/events/:id/edit', (req, res) => {
  const event = sqlite.prepare(`
    SELECT e.*, p.display_name AS pen_name, b.title AS book_title
    FROM calendar_events e
    LEFT JOIN pen_names p ON p.id = e.pen_name_id
    LEFT JOIN books b ON b.id = e.book_id
    WHERE e.id = ?
  `).get(req.params.id);
  if (!event) {
    res.status(404).send(layout('Event Not Found', '<section class="card"><h2>Event not found</h2><p><a class="button secondary" href="/calendar">Back to Calendar</a></p></section>', { active: 'calendar' }));
    return;
  }
  res.send(layout(`Edit ${event.title}`, `<section class="card"><div class="section-title-row"><h2>Edit Event</h2><a class="button secondary" href="/calendar">Back</a></div>${calendarEventForm(event)}</section>`, { active: 'calendar' }));
});

app.post('/calendar/events/:id', (req, res) => {
  sqlite.prepare(`
    UPDATE calendar_events SET
      title=@title,
      event_date=@eventDate,
      event_time=@eventTime,
      event_type=@eventType,
      pen_name_id=@penNameId,
      book_id=@bookId,
      status=@status,
      notes=@notes,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({
    id: req.params.id,
    title: req.body.title,
    eventDate: req.body.eventDate || todayIso(),
    eventTime: req.body.eventTime || '',
    eventType: req.body.eventType || 'General',
    penNameId: req.body.penNameId || null,
    bookId: req.body.bookId || null,
    status: req.body.status || 'Planned',
    notes: req.body.notes || ''
  });
  res.redirect('/calendar');
});

app.post('/calendar/events/:id/move', (req, res) => {
  const event = sqlite.prepare("SELECT * FROM calendar_events WHERE id = ? AND source IN ('manual', 'google')").get(req.params.id);
  if (!event) {
    res.status(404).json({ ok: false, error: 'Only manual or Google-imported events can be moved.' });
    return;
  }
  const eventDate = String(req.body.eventDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    res.status(400).json({ ok: false, error: 'A valid date is required.' });
    return;
  }
  sqlite.prepare('UPDATE calendar_events SET event_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eventDate, req.params.id);
  res.json({ ok: true, eventDate });
});

app.post('/calendar/events/move', (req, res) => {
  try {
    const localKey = String(req.body.localKey || '');
    const eventDate = String(req.body.eventDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      res.status(400).json({ ok: false, error: 'A valid date is required.' });
      return;
    }
    moveCalendarEventByKey(localKey, eventDate);
    res.json({ ok: true, eventDate });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/calendar/events/delete', (req, res) => {
  try {
    deleteCalendarEventByKey(String(req.body.localKey || ''));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/calendar/events/:id/delete', (req, res) => {
  const localKey = `manual:${req.params.id}`;
  deleteCalendarEventByKey(localKey);
  res.redirect('/calendar');
});

app.get('/calendar.ics', (req, res) => {
  const ics = calendarIcs(combinedCalendarEvents(365));
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="author-hq-calendar.ics"');
  res.send(ics);
});

app.get('/integrations/google/start', (req, res) => {
  const url = googleAuthUrl(baseUrl(req));
  if (!url) {
    res.send(layout('Google Calendar', '<section class="card"><h2>Google Calendar Not Configured</h2><p class="muted">Paste your OAuth client JSON in Settings first.</p><p><a class="button secondary" href="/settings">Open Settings</a></p></section>', { active: 'calendar' }));
    return;
  }
  res.redirect(url);
});

app.get('/integrations/google/callback', async (req, res) => {
  try {
    await handleGoogleCallback(req.query.code, baseUrl(req));
    res.send(layout('Google Calendar Connected', '<section class="card"><h2>Google Calendar Connected</h2><p class="muted">Author HQ can now sync events both ways with Google Calendar.</p><p><a class="button secondary" href="/calendar">Back to Calendar</a></p></section>', { active: 'calendar' }));
  } catch (error) {
    res.status(500).send(layout('Google Calendar Error', `<section class="card"><h2>Google Calendar Error</h2><pre>${escapeHtml(error.stack || error.message)}</pre><p><a class="button secondary" href="/calendar">Back</a></p></section>`, { active: 'calendar' }));
  }
});

app.post('/integrations/google/disconnect', (req, res) => {
  disconnectGoogleCalendar();
  res.redirect('/calendar');
});

app.post('/calendar/google-calendar', (req, res) => {
  saveGoogleCalendarId(req.body.calendarId || 'primary');
  res.redirect('/calendar');
});

app.post('/calendar/sync/google', async (req, res) => {
  try {
    const imported = await syncCalendarFromGoogle(baseUrl(req));
    const result = await syncCalendarToGoogle(baseUrl(req));
    res.send(layout('Google Calendar Sync', `
      <section class="card">
        <h2>Google Calendar Sync Complete</h2>
        <p class="muted">Imported ${imported.imported} Google events and updated ${imported.updated}. Sent ${result.synced} Author HQ events back to Google. ${result.failed + imported.failed} failed.</p>
        ${[...imported.errors, ...result.errors].length ? `<pre>${escapeHtml([...imported.errors, ...result.errors].slice(0, 12).join('\n'))}</pre>` : ''}
        <p><a class="button secondary" href="/calendar">Back to Calendar</a></p>
      </section>
    `, { active: 'calendar' }));
  } catch (error) {
    res.status(500).send(layout('Google Calendar Sync Error', `<section class="card"><h2>Google Calendar Sync Error</h2><pre>${escapeHtml(error.stack || error.message)}</pre><p><a class="button secondary" href="/calendar">Back</a></p></section>`, { active: 'calendar' }));
  }
});

app.get('/exports/books', (req, res) => {
  const cards = allPenNames().map((pen) => {
    const { payload } = publicBookPayload({ sqlite, penNameKeyOrId: pen.id });
    return `<section class="card span-4">
      <h2>${escapeHtml(pen.display_name)}</h2>
      <p class="metric">${payload.books.length}</p>
      <p class="tiny">public website books</p>
      <p><a class="button" href="/api/export/books/${escapeHtml(pen.key)}">Download books.json</a></p>
    </section>`;
  }).join('');
  res.send(layout('Book Exports', `
    <section class="card">
      <h2>Public Book Data Export</h2>
      <p class="muted">Download one static <code>books.json</code> per pen name, then upload it beside that pen name's website files. The website can read this file with client-side JavaScript; no public Author HQ server is required.</p>
      <p class="tiny">Cover image paths are exported as stored on each book, usually like images/book-cover.jpg. Drop the matching resized cover into the website images folder before uploading.</p>
    </section>
    <section class="grid">${cards}</section>
  `, { active: 'exports' }));
});

app.get('/api/export/books/:penName', (req, res) => {
  try {
    const { payload } = publicBookPayload({ sqlite, penNameKeyOrId: req.params.penName });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="books.json"');
    res.send(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/launch-checklists', (req, res) => {
  const books = sqlite.prepare(`
    SELECT b.*, p.display_name AS pen_name FROM books b
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
    ORDER BY p.display_name, b.planned_release, b.title
  `).all().filter(shouldShowLaunchChecklist);
  const rows = sqlite.prepare('SELECT * FROM launch_checklists').all();
  const byBook = new Map();
  rows.forEach((row) => byBook.set(`${row.book_title}::${row.item}`, row));
  const cards = books.length ? books.map((book) => launchChecklistCard(book, byBook)).join('') : '<section class="card span-12"><h2>No active launch checklists</h2><p class="muted">Books appear here once they reach Draft Complete. Published books are removed from this page automatically.</p></section>';
  res.send(layout('Launch Checklists', `<section class="grid">${cards}</section>`, { active: 'launch' }));
});

app.post('/launch-checklists/toggle', (req, res) => {
  const checked = req.body.checked ? 1 : 0;
  const book = sqlite.prepare('SELECT * FROM books WHERE id = ?').get(req.body.bookId);
  if (book) {
    sqlite.prepare(`
      INSERT INTO launch_checklists (book_id, book_title, item, checked, updated)
      VALUES (@bookId, @bookTitle, @item, @checked, @updated)
      ON CONFLICT(book_title, item) DO UPDATE SET checked=@checked, updated=@updated, updated_at=CURRENT_TIMESTAMP
    `).run({ bookId: book.id, bookTitle: book.title, item: req.body.item, checked, updated: todayIso() });
  }
  res.redirect('/launch-checklists');
});

app.get('/goals', (req, res) => {
  const rows = decorateGoals(sqlite.prepare(`
    SELECT g.*, p.display_name AS pen_name FROM goals g
    LEFT JOIN pen_names p ON p.id = g.pen_name_id
    ORDER BY CASE lower(g.status) WHEN 'active' THEN 0 WHEN 'in progress' THEN 1 WHEN 'planned' THEN 2 ELSE 3 END, COALESCE(g.target_date, '9999-12-31')
  `).all());
  const publishedWords = publishedWordsSnapshot();
  const hasPublishedWordsGoal = rows.some(isPublishedWordsGoal);
  res.send(layout('Goals', `
    <section class="card">
      <div class="section-title-row"><div><h2>1 Million Published Words</h2><p class="muted">Counts the word totals of books marked Published or Live.</p></div>${hasPublishedWordsGoal ? '<span class="pill">Challenge active</span>' : '<form method="post" action="/goals/published-words-challenge"><button>Start Challenge</button></form>'}</div>
      <div class="metric-strip challenge-metrics">
        <div class="metric-tile"><span class="eyebrow">Published Words</span><strong>${publishedWords.total.toLocaleString()}</strong><small>included in the challenge</small></div>
        <div class="metric-tile"><span class="eyebrow">Published Books</span><strong>${publishedWords.bookCount.toLocaleString()}</strong><small>marked Published or Live</small></div>
        <div class="metric-tile"><span class="eyebrow">Goal</span><strong>1,000,000</strong><small>published words</small></div>
        <div class="metric-tile"><span class="eyebrow">Remaining</span><strong>${publishedWords.remaining.toLocaleString()}</strong><small>words to go</small></div>
        <div class="metric-tile"><span class="eyebrow">Progress</span><strong>${publishedWords.percent.toFixed(1)}%</strong><small>updates with book status</small></div>
      </div>
    </section>
    <section class="card"><h2>Add Goal</h2>${goalForm()}</section>
    <section class="card"><h2>Goals</h2>${rows.length ? goalsTable(rows) : '<p class="muted">No goals yet.</p>'}</section>
  `, { active: 'goals' }));
});

app.post('/goals', (req, res) => {
  sqlite.prepare(`
    INSERT INTO goals (pen_name_id, title, category, status, target_date, progress, notes)
    VALUES (@penNameId, @title, @category, @status, @targetDate, @progress, @notes)
  `).run({ ...req.body, penNameId: req.body.penNameId || null, progress: Number(req.body.progress || 0) });
  res.redirect('/goals');
});

app.post('/goals/published-words-challenge', (req, res) => {
  const existing = sqlite.prepare("SELECT id FROM goals WHERE lower(category) = 'published words' OR lower(title) LIKE '%million%words%published%'").get();
  if (!existing) {
    sqlite.prepare(`
      INSERT INTO goals (pen_name_id, title, category, status, target_date, progress, notes)
      VALUES (NULL, '1 Million Words Published', 'Published Words', 'Active', '', 0, 'Automatically totals word counts from books marked Published or Live.')
    `).run();
  }
  res.redirect('/goals');
});

app.get('/goals/:id/edit', (req, res) => {
  const goal = sqlite.prepare(`
    SELECT g.*, p.display_name AS pen_name FROM goals g
    LEFT JOIN pen_names p ON p.id = g.pen_name_id
    WHERE g.id = ?
  `).get(req.params.id);
  if (!goal) {
    res.status(404).send(layout('Goal Not Found', '<section class="card"><h2>Goal not found</h2><p><a class="button secondary" href="/goals">Back to Goals</a></p></section>', { active: 'goals' }));
    return;
  }
  res.send(layout(`Edit ${goal.title}`, `
    <section class="card">
      <div class="section-title-row"><h2>Edit Goal</h2><a class="button secondary" href="/goals">Back</a></div>
      ${goalForm(goal)}
    </section>
  `, { active: 'goals' }));
});

app.post('/goals/:id', (req, res) => {
  sqlite.prepare(`
    UPDATE goals SET
      pen_name_id=@penNameId,
      title=@title,
      category=@category,
      status=@status,
      target_date=@targetDate,
      progress=@progress,
      notes=@notes,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({
    id: req.params.id,
    penNameId: req.body.penNameId || null,
    title: req.body.title,
    category: req.body.category || 'General',
    status: req.body.status || 'Active',
    targetDate: req.body.targetDate || '',
    progress: Number(req.body.progress || 0),
    notes: req.body.notes || ''
  });
  res.redirect('/goals');
});

app.post('/goals/:id/delete', (req, res) => {
  sqlite.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  res.redirect('/goals');
});

app.get('/milestones', (req, res) => {
  const rows = sqlite.prepare(`
    SELECT m.*, p.display_name AS pen_name FROM milestones m
    LEFT JOIN pen_names p ON p.id = m.pen_name_id
    ORDER BY m.date DESC, m.id DESC
  `).all();
  res.send(layout('Milestones', `
    <section class="card"><h2>Add Milestone</h2>${milestoneForm()}</section>
    <section><h2>Milestones</h2>${rows.length ? table(['Date','Marker','Title','Pen','Description','Notes'], rows.map((r) => [r.date, r.emoji || '*', r.title, r.pen_name || r.pen_name_label || 'All', r.description || '', r.notes || ''])) : '<p class="muted">No milestones yet.</p>'}</section>
  `, { active: 'milestones' }));
});

app.post('/milestones', (req, res) => {
  const pen = penNameById(req.body.penNameId);
  sqlite.prepare(`
    INSERT INTO milestones (date, emoji, title, description, notes, pen_name_id, pen_name_label)
    VALUES (@date, @emoji, @title, @description, @notes, @penNameId, @penNameLabel)
  `).run({ ...req.body, date: req.body.date || todayIso(), emoji: req.body.emoji || '*', penNameId: req.body.penNameId || null, penNameLabel: pen?.display_name || req.body.penNameLabel || 'All' });
  res.redirect('/milestones');
});

app.get('/expenses', (req, res) => {
  const rows = sqlite.prepare(`
    SELECT e.*, p.display_name AS pen_name FROM expenses e
    LEFT JOIN pen_names p ON p.id = e.pen_name_id
    ORDER BY e.date DESC, e.id DESC LIMIT 100
  `).all();
  const rollup = expenseCategoryRollup();
  res.send(layout('Expenses', `
    <div class="grid">
      <section class="card span-5"><h2>Add Expense</h2>${expenseForm()}</section>
      <section class="card span-7"><h2>This Month By Category</h2>${rollup.length ? table(['Category','Rows','Total'], rollup.map((r) => [r.category || 'Uncategorized', r.count, money(r.total)])) : '<p class="muted">No expenses logged this month.</p>'}</section>
      <section class="span-12"><h2>Recent Expenses</h2>${rows.length ? table(['Date','Vendor','Category','Pen','Amount'], rows.map((r) => [r.date, r.vendor, r.category, r.pen_name || '', money(r.amount)])) : '<p class="muted">No expenses yet.</p>'}</section>
    </div>
  `, { active: 'expenses' }));
});

app.post('/expenses', (req, res) => {
  const penNameId = req.body.penNameId || null;
  sqlite.prepare(`
    INSERT INTO expenses (date, vendor, description, category, pen_name_id, payment_method, recurring, amount, receipt_saved, notes)
    VALUES (@date, @vendor, @description, @category, @penNameId, @paymentMethod, @recurring, @amount, @receiptSaved, @notes)
  `).run({
    date: req.body.date || todayIso(),
    vendor: req.body.vendor,
    description: req.body.description || '',
    category: req.body.category || 'Miscellaneous',
    penNameId,
    paymentMethod: req.body.paymentMethod || 'Credit Card',
    recurring: req.body.recurring ? 1 : 0,
    amount: parseMoney(req.body.amount),
    receiptSaved: req.body.receiptSaved || 'No',
    notes: req.body.notes || ''
  });
  res.redirect('/expenses');
});

app.get('/income', (req, res) => {
  const rows = sqlite.prepare('SELECT * FROM income ORDER BY date DESC, id DESC LIMIT 100').all();
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  res.send(layout('Income', `
    <section class="card"><h2>Add Income</h2>${incomeForm()}</section>
    <section class="card"><h2>Recent Total</h2><div class="metric">${money(total)}</div><p class="muted">Last ${rows.length} imported or logged income rows.</p></section>
    <section><h2>Recent Income</h2>${rows.length ? table(['Date','Platform','Type','Amount','Notes'], rows.map((r) => [r.date, r.platform, r.income_type, money(r.amount), r.notes || ''])) : '<p class="muted">No income yet.</p>'}</section>
  `, { active: 'income' }));
});

app.post('/income', (req, res) => {
  sqlite.prepare('INSERT INTO income (date, platform, income_type, amount, notes) VALUES (@date, @platform, @incomeType, @amount, @notes)').run({
    date: req.body.date || todayIso(),
    platform: req.body.platform || 'Amazon KDP',
    incomeType: req.body.incomeType || 'Combined Payout',
    amount: parseMoney(req.body.amount),
    notes: req.body.notes || ''
  });
  res.redirect('/income');
});

app.get('/royalties', (req, res) => {
  const summary = royaltySummaryRows(100);
  const trend = royaltyTrendRows(18);
  const recent = royaltyRecentRows(80);
  const totals = royaltyTotalsRow();
  const live = liveBooksRows(100);
  res.send(layout('Royalties', `
    <div class="grid">
      <div class="royalty-layout">
        <div class="royalty-left">
          <section class="card summary-panel">
            <div class="section-title-row">
              <div>
                <h2>Royalty Command</h2>
                <p class="muted">Track live books, title performance, KENP reads, units, and royalties over time.</p>
              </div>
              <a class="button secondary" href="/books">Manage Books</a>
            </div>
            <div class="metric-strip royalty-metrics">
              <div class="metric-tile"><span class="eyebrow">Total royalties</span><strong>${money(totals.total_royalty)}</strong><small>${totals.rows || 0} rows imported</small></div>
              <div class="metric-tile"><span class="eyebrow">Paid sales</span><strong>${totals.units || 0}</strong><small>royalty-bearing units</small></div>
              <div class="metric-tile"><span class="eyebrow">Free downloads</span><strong>${totals.free_units || 0}</strong><small>promotion copies</small></div>
              <div class="metric-tile"><span class="eyebrow">KENP</span><strong>${totals.kenp_read || 0}</strong><small>pages read</small></div>
              <div class="metric-tile"><span class="eyebrow">Live books</span><strong>${live.length}</strong><small>published or live</small></div>
            </div>
          </section>
          <section class="card"><h2>Monthly Trend</h2>${trend.length ? table(['Month','Paid','Free','KENP','Royalties'], trend.map((row) => [row.month, row.units || 0, row.free_units || 0, row.kenp_read || 0, money(row.royalty)])) : '<p class="muted">No royalty history yet.</p>'}</section>
          <section class="card side-card royalty-import-card"><h2>Import Royalty Report</h2>${royaltyImportForm()}</section>
        </div>
        <div class="royalty-right">
          <section class="card side-card royalty-form-card"><h2>Add Royalty Row</h2>${royaltyForm()}</section>
        </div>
      </div>
      <section class="card span-5 side-card"><h2>Live Books</h2>${live.length ? table(['Title','Pen','Status'], live.map((book) => [book.title, book.pen_name || '', book.status || ''])) : '<p class="muted">No live books yet. Mark a book as Published or Pre-order Live on the Books page.</p>'}</section>
      <section class="card span-7"><h2>Title Performance</h2>${summary.length ? table(['Title','Pen','Paid','Free','KENP','Royalties','Last Seen'], summary.map((row) => [row.title, row.pen_name || '', row.units || 0, row.free_units || 0, row.kenp_read || 0, money(row.royalty), row.last_seen || ''])) : '<p class="muted">No royalty report rows imported yet.</p>'}</section>
      <section class="card span-12"><h2>Recent Royalty Rows</h2>${recent.length ? table(['Date','Title','Marketplace','Format','Paid','Free','KENP','Royalty'], recent.map((row) => [row.report_date, row.title, row.marketplace || '', row.format || '', row.units || 0, row.free_units || 0, row.kenp_read || 0, money(row.royalty)])) : '<p class="muted">No rows yet.</p>'}</section>
    </div>
  `, { active: 'royalties' }));
});

app.post('/royalties', (req, res) => {
  const book = req.body.bookId ? bookById(req.body.bookId) : findBookByTitle(req.body.title);
  const pen = req.body.penNameId ? penNameById(req.body.penNameId) : null;
  upsertRoyaltyEntry({
    periodStart: req.body.periodStart || null,
    periodEnd: req.body.periodEnd || null,
    reportDate: req.body.reportDate || req.body.periodEnd || todayIso(),
    platform: req.body.platform || 'Amazon KDP',
    marketplace: req.body.marketplace || '',
    penNameId: req.body.penNameId || book?.pen_name_id || pen?.id || null,
    bookId: book?.id || null,
    title: req.body.title || book?.title || 'Untitled',
    author: req.body.author || '',
    format: req.body.format || '',
    units: Number(req.body.units || 0) || 0,
    freeUnits: Number(req.body.freeUnits || 0) || 0,
    kenpRead: Number(req.body.kenpRead || 0) || 0,
    royalty: parseMoney(req.body.royalty),
    currency: req.body.currency || 'USD',
    sourceFile: 'manual',
    notes: req.body.notes || ''
  });
  res.redirect('/royalties');
});

app.post('/royalties/import', upload.single('royalties'), (req, res) => {
  if (!req.file) {
    res.redirect('/royalties');
    return;
  }
  const rows = parseSpreadsheetRows(req.file.buffer, req.file.originalname);
  const kenpRate = parseMoney(req.body.kenpRate) || DEFAULT_KENP_RATE;
  const count = importRoyalties(rows, req.file.originalname, { kenpRate });
  res.send(layout('Royalty Import Complete', `
    <section class="card">
      <h2>Royalty Import Complete</h2>
      <p class="muted">Imported ${count} royalty rows from ${escapeHtml(req.file.originalname)}.</p>
      <p class="tiny">KENP rows without finalized royalties were estimated at ${formatKenpRate(kenpRate)} per page.</p>
      <p><a class="button secondary" href="/royalties">View royalties</a></p>
    </section>
  `, { active: 'royalties' }));
});

app.get('/subscriptions', (req, res) => {
  const rows = sqlite.prepare('SELECT * FROM subscriptions ORDER BY active DESC, renewal_date').all();
  const monthly = rows.filter((r) => r.active).reduce((sum, r) => sum + billingMonthlyEquivalent(r.monthly_cost, r.billing_cycle), 0);
  res.send(layout('Subscriptions', `
    <section class="card"><h2>Add Subscription</h2>${subscriptionForm()}</section>
    <section class="card"><h2>Monthly Set Aside</h2><div class="metric">${money(monthly)}</div><p class="muted">${money(monthly / 2)} per twice-monthly paycheck, ${money((monthly * 12) / 26)} biweekly.</p></section>
    <section><h2>Subscriptions</h2>${subscriptionsTable(rows)}</section>
  `, { active: 'subscriptions' }));
});

app.get('/subscriptions/:id/edit', (req, res) => {
  const row = sqlite.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!row) {
    res.status(404).send(notFoundPage('Subscription', '/subscriptions', 'subscriptions'));
    return;
  }
  res.send(layout('Edit Subscription', `
    <section class="card"><div class="section-title-row"><h2>Edit ${escapeHtml(row.service)}</h2><a class="button secondary" href="/subscriptions">Back</a></div>${subscriptionForm(row)}</section>
  `, { active: 'subscriptions' }));
});

app.post('/subscriptions', (req, res) => {
  const monthlyCost = parseMoney(req.body.monthlyCost);
  const active = req.body.active ? 1 : 0;
  const annualizedCost = billingMonthlyEquivalent(monthlyCost, req.body.billingCycle) * 12;
  const service = String(req.body.service || '').trim();
  const existing = req.body.id
    ? sqlite.prepare('SELECT id FROM subscriptions WHERE id = ?').get(req.body.id)
    : sqlite.prepare('SELECT id FROM subscriptions WHERE lower(service) = lower(?)').get(service);
  const values = { ...req.body, id: existing?.id, service, monthlyCost, active, annualizedCost };
  if (existing) {
    sqlite.prepare(`
      UPDATE subscriptions SET service=@service, category=@category, monthly_cost=@monthlyCost,
        billing_cycle=@billingCycle, renewal_date=@renewalDate, payment_method=@paymentMethod,
        active=@active, notes=@notes, annualized_cost=@annualizedCost, updated_at=CURRENT_TIMESTAMP
      WHERE id=@id
    `).run(values);
  } else {
    sqlite.prepare(`
      INSERT INTO subscriptions (service, category, monthly_cost, billing_cycle, renewal_date, payment_method, active, notes, annualized_cost)
      VALUES (@service, @category, @monthlyCost, @billingCycle, @renewalDate, @paymentMethod, @active, @notes, @annualizedCost)
    `).run(values);
  }
  res.redirect('/subscriptions');
});

app.post('/subscriptions/:id/delete', (req, res) => {
  sqlite.prepare('DELETE FROM subscriptions WHERE id = ?').run(req.params.id);
  res.redirect('/subscriptions');
});

app.get('/content', (req, res) => {
  const posts = sqlite.prepare(`
    SELECT c.*, p.display_name AS pen_name FROM content_posts c
    LEFT JOIN pen_names p ON p.id = c.pen_name_id
    ORDER BY COALESCE(c.scheduled_for, c.created_at) DESC
  `).all();
  res.send(layout('Content', `<section class="card"><h2>Add Content Post</h2>${contentForm()}</section>${posts.length ? table(['Pen','Platform','Status','Verified','Scheduled','Content'], posts.map((p) => [p.pen_name || '', p.platform, p.status, p.verified_live ? 'Yes' : 'No', p.scheduled_for || '', p.content])) : '<p class="muted">No posts yet.</p>'}`, { active: 'content' }));
});

app.post('/content', (req, res) => {
  sqlite.prepare(`
    INSERT INTO content_posts (pen_name_id, platform, channel_id, content, scheduled_for, status, verified_live, notes)
    VALUES (@penNameId, @platform, @channelId, @content, @scheduledFor, @status, @verifiedLive, @notes)
  `).run({ ...req.body, verifiedLive: req.body.verifiedLive ? 1 : 0 });
  res.redirect('/content');
});

app.get('/buffer-health', asyncRoute(async (req, res) => {
  const penNames = allPenNames();
  const bufferCards = await Promise.all(penNames.map(async (pen) => ({ pen, runway: await withTimeout(getBufferRunway(pen), 1800, { configured: true, channels: [], error: 'Timed out' }) })));
  res.send(layout('Buffer Health', `
    <section class="stack-page">
      ${bufferCards.map(({ pen, runway }) => socialRunwaySection(pen, runway)).join('')}
    </section>
  `, { active: 'health' }));
}));

app.get('/newsletter', asyncRoute(async (req, res) => {
  const penNames = allPenNames();
  const stats = await Promise.all(penNames.map(async (pen) => ({ pen, stats: await getListStats(pen.email_octopus_list_id) })));
  const projects = newsletterProjects();
  res.send(layout('Newsletter', `
    <div class="grid">
      <section class="card span-5"><h2>Start a Newsletter Workspace</h2><p class="muted">Create a room to talk through the newsletter with Claude before shaping the final draft.</p>${newsletterProjectForm()}</section>
      <section class="card span-7"><h2>Newsletter Workspaces</h2>${newsletterProjectTable(projects)}</section>
    </div>
    <section class="grid">${stats.map(({ pen, stats }) => newsletterStatsCard(pen, stats)).join('')}</section>
  `, { active: 'newsletter' }));
}));

app.post('/newsletter/projects', (req, res) => {
  const pen = penNameById(req.body.penNameId);
  if (!pen) {
    res.redirect('/newsletter');
    return;
  }
  const topic = String(req.body.topic || '').trim() || 'Newsletter planning';
  const title = String(req.body.title || '').trim() || topic;
  const result = sqlite.prepare(`
    INSERT INTO newsletter_projects (pen_name_id, title, topic)
    VALUES (?, ?, ?)
  `).run(pen.id, title, topic);
  res.redirect(`/newsletter/projects/${result.lastInsertRowid}`);
});

app.get('/newsletter/projects/:id', (req, res) => {
  const project = newsletterProjectById(req.params.id);
  if (!project) {
    res.status(404).send(layout('Newsletter Workspace Not Found', '<section class="card"><h2>Workspace not found</h2><p><a class="button secondary" href="/newsletter">Back to Newsletter</a></p></section>', { active: 'newsletter' }));
    return;
  }
  const messages = newsletterMessages(project.id);
  res.send(layout(project.title, newsletterWorkspaceView(project, messages), { active: 'newsletter' }));
});

app.post('/newsletter/projects/:id/messages', async (req, res) => {
  const project = newsletterProjectById(req.params.id);
  const content = String(req.body.message || '').trim();
  if (!project || !content) {
    res.status(400).json({ ok: false, error: project ? 'Write a message first.' : 'Newsletter workspace not found.' });
    return;
  }
  sqlite.prepare('INSERT INTO newsletter_messages (project_id, role, content) VALUES (?, ?, ?)').run(project.id, 'user', content);
  sqlite.prepare('UPDATE newsletter_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(project.id);
  try {
    const messages = newsletterMessages(project.id).map(({ role, content: body }) => ({ role, content: body }));
    const reply = await chatNewsletterProject({
      penName: project,
      topic: project.topic,
      messages,
      books: allBooks(),
      upcomingEvents: newsletterUpcomingEvents(project.pen_name_id)
    });
    if (reply.provider === 'prompt_only') throw new Error('Add an OpenRouter API key or Claude API key in Settings first.');
    const inserted = sqlite.prepare('INSERT INTO newsletter_messages (project_id, role, content) VALUES (?, ?, ?)').run(project.id, 'assistant', reply.text);
    sqlite.prepare('UPDATE newsletter_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(project.id);
    res.json({ ok: true, message: { id: inserted.lastInsertRowid, role: 'assistant', content: reply.text }, provider: reply.provider, model: reply.model || '' });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.post('/newsletter/projects/:id/draft', asyncRoute(async (req, res) => {
  const project = newsletterProjectById(req.params.id);
  if (!project) throw new Error('Newsletter workspace not found.');
  const transcript = newsletterMessages(project.id)
    .slice(-40)
    .map((message) => `${message.role === 'user' ? 'Author' : 'Claude'}: ${message.content}`)
    .join('\n\n');
  const draft = await draftNewsletter({
    penName: project,
    topic: project.topic || project.title,
    notes: `Use this planning conversation as the editorial brief. Honor the author's decisions and do not invent facts.\n\n${transcript || 'No planning conversation yet.'}`,
    books: allBooks()
  });
  sqlite.prepare(`
    UPDATE newsletter_projects SET
      draft_subject=@subject, draft_preview=@preview, draft_text=@text, draft_html=@html,
      draft_provider=@provider, draft_warning=@warning, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({ id: project.id, subject: draft.subject || '', preview: draft.preview || '', text: draft.text || '', html: draft.html || '', provider: draft.provider || '', warning: draft.warning || '' });
  res.redirect(`/newsletter/projects/${project.id}#newsletter-draft`);
}));

app.post('/newsletter/projects/:id/draft/save', (req, res) => {
  sqlite.prepare(`
    UPDATE newsletter_projects SET draft_subject=@subject, draft_preview=@preview,
      draft_text=@text, draft_html=@html, updated_at=CURRENT_TIMESTAMP WHERE id=@id
  `).run({ id: req.params.id, subject: req.body.subject || '', preview: req.body.preview || '', text: req.body.text || '', html: req.body.html || '' });
  res.redirect(`/newsletter/projects/${req.params.id}#newsletter-draft`);
});

app.post('/newsletter/projects/:id/delete', (req, res) => {
  sqlite.prepare('DELETE FROM newsletter_projects WHERE id = ?').run(req.params.id);
  res.redirect('/newsletter');
});

app.post('/newsletter', (req, res) => {
  const pen = penNameById(req.body.penNameId);
  if (!pen) return res.redirect('/newsletter');
  const topic = String(req.body.topic || '').trim() || 'Newsletter planning';
  const result = sqlite.prepare('INSERT INTO newsletter_projects (pen_name_id, title, topic) VALUES (?, ?, ?)').run(pen.id, topic, topic);
  if (String(req.body.notes || '').trim()) sqlite.prepare('INSERT INTO newsletter_messages (project_id, role, content) VALUES (?, ?, ?)').run(result.lastInsertRowid, 'user', String(req.body.notes).trim());
  return res.redirect(`/newsletter/projects/${result.lastInsertRowid}`);
});

app.get('/kdp-listings', (req, res) => {
  const q = String(req.query.q || '').trim();
  const listings = allKdpListings();
  const analyses = allManuscriptAnalyses();
  const matches = q ? searchKindleCategories(q, 15) : [];
  res.send(layout('KDP Listings', `
    <section class="grid">
      <section class="card span-6">
        <h2>Analyze Manuscript File</h2>
        <p class="muted">Upload DOCX, EPUB, PDF, TXT, Markdown, or HTML. Author HQ saves the resulting brief, not a second copy of the manuscript.</p>
        ${manuscriptUploadForm()}
      </section>
      <section class="card span-6">
        <h2>Analyze Chapter Folder</h2>
        <p class="muted">Choose a folder of chapter files. They are sorted by filename and combined only in memory for analysis.</p>
        ${manuscriptFolderForm()}
      </section>
      <section class="card span-12">
        <h2>Manuscript Briefs</h2>
        ${manuscriptAnalysesTable(analyses)}
      </section>
    </section>
    <section class="card">
      <h2>Generate KDP Listing Packet</h2>
      ${kdpListingForm({ selectedBookId: req.query.bookId || '', analyses })}
    </section>
    <section class="card">
      <h2>Search Amazon Category Audit</h2>
      <p class="tiny">${escapeHtml(adultKdpCategoryWarning)}</p>
      <form class="row" method="get" action="/kdp-listings">
        <input name="q" value="${escapeHtml(q)}" placeholder="Search category paths, e.g. lesbian horror, space opera, psychological">
        <button class="secondary">Search Categories</button>
      </form>
      ${q ? categorySearchTable(matches) : '<p class="muted">Use this to sanity-check category paths and competitiveness from your imported Amazon workbook.</p>'}
    </section>
    <section class="card">
      <h2>Saved Packets</h2>
      ${savedKdpListingsTable(listings)}
    </section>
  `, { active: 'kdp' }));
});

app.post('/kdp-manuscripts/upload', upload.single('manuscript'), (req, res) => {
  if (!req.file) throw new Error('Choose a manuscript file first.');
  queueManuscriptAnalysis({
    req,
    res,
    sourceName: req.file.originalname,
    sourceType: path.extname(req.file.originalname).slice(1).toLowerCase() || 'file',
    sourceHash: manuscriptFingerprint(req.file.buffer),
    extract: () => extractManuscript(req.file.buffer, req.file.originalname)
  });
});

app.post('/kdp-manuscripts/folder', upload.array('chapters', 250), (req, res) => {
  const files = req.files || [];
  if (!files.length) throw new Error('Choose a chapter folder first.');
  const sourceHash = crypto.createHash('sha256');
  files.sort((a, b) => String(a.originalname).localeCompare(String(b.originalname), undefined, { numeric: true, sensitivity: 'base' }))
    .forEach((file) => sourceHash.update(file.originalname).update(file.buffer));
  queueManuscriptAnalysis({
    req,
    res,
    sourceName: `${path.basename(String(files[0].originalname).split(/[\\/]/)[0] || 'Chapter folder')} (${files.length} files)`,
    sourceType: 'chapter-folder',
    sourceHash: sourceHash.digest('hex'),
    extract: () => extractManuscriptCollection(files)
  });
});

app.get('/kdp-manuscripts/:id', (req, res) => {
  const row = manuscriptAnalysisById(req.params.id);
  if (!row) {
    res.status(404).send(notFoundPage('Manuscript brief', '/kdp-listings', 'kdp'));
    return;
  }
  res.send(layout(`Manuscript Brief - ${row.book_title}`, manuscriptAnalysisView(row), { active: 'kdp' }));
});

app.post('/kdp-manuscripts/:id/review', (req, res) => {
  const row = manuscriptAnalysisById(req.params.id);
  if (!row) {
    res.status(404).send(notFoundPage('Manuscript brief', '/kdp-listings', 'kdp'));
    return;
  }
  sqlite.prepare(`
    UPDATE kdp_manuscript_analyses SET review_json=@reviewJson, status='Reviewed', updated_at=CURRENT_TIMESTAMP WHERE id=@id
  `).run({ id: row.id, reviewJson: JSON.stringify(manuscriptReviewFromBody(req.body), null, 2) });
  res.redirect(`/kdp-manuscripts/${row.id}`);
});

app.post('/kdp-listings', async (req, res) => {
  try {
    const book = req.body.bookId ? bookById(req.body.bookId) : null;
    const penName = penNameById(req.body.penNameId || book?.pen_name_id);
    const genreConfig = kdpGenreConfigForPen(penName?.id);
    const listing = kdpListingFieldsFromBody(req.body, book, genreConfig);
    const categoryRows = categoryRowsForKdpConfig(genreConfig, listing.targetCategories);
    const manuscriptAnalysis = req.body.manuscriptAnalysisId ? manuscriptAnalysisById(req.body.manuscriptAnalysisId) : latestManuscriptAnalysis(book?.id);
    if (manuscriptAnalysis && book && String(manuscriptAnalysis.book_id) !== String(book.id)) throw new Error('The selected manuscript brief belongs to a different book.');
    const manuscriptBrief = manuscriptAnalysis ? effectiveManuscriptBrief(manuscriptAnalysis) : null;
    const generated = await generateKdpPacket({ penName, genreConfig, book, listing, categoryRows, manuscriptBrief });
    const info = sqlite.prepare(`
      INSERT INTO kdp_listings
        (book_id, pen_name_id, manuscript_analysis_id, format, title, subtitle, series_name, series_number, blurb_draft, comp_titles, target_categories, price_usd, ku_enrolled, ai_generated, ai_assisted, language, reading_age, publication_rights, status, generated_packet, provider)
      VALUES
        (@bookId, @penNameId, @manuscriptAnalysisId, @format, @title, @subtitle, @seriesName, @seriesNumber, @blurbDraft, @compTitles, @targetCategories, @priceUsd, @kuEnrolled, @aiGenerated, @aiAssisted, @language, @readingAge, @publicationRights, 'draft', @generatedPacket, @provider)
    `).run({
      ...listing,
      bookId: book?.id || req.body.bookId || null,
      penNameId: penName?.id || null,
      manuscriptAnalysisId: manuscriptAnalysis?.id || null,
      generatedPacket: JSON.stringify(generated.packet, null, 2),
      provider: generated.provider
    });
    res.redirect(`/kdp-listings/${info.lastInsertRowid}`);
  } catch (error) {
    res.status(500).send(layout('KDP Listing Error', `<section class="card"><h2>KDP Listing Error</h2><pre>${escapeHtml(error.stack || error.message)}</pre></section><p><a class="button secondary" href="/kdp-listings">Back</a></p>`, { active: 'kdp' }));
  }
});

app.get('/kdp-listings/:id', (req, res) => {
  const row = kdpListingById(req.params.id);
  if (!row) {
    res.status(404).send(layout('KDP Listing Not Found', '<section class="card"><h2>Not Found</h2></section>', { active: 'kdp' }));
    return;
  }
  const packet = parseJson(row.generated_packet, {});
  res.send(layout(`KDP Packet - ${row.title}`, kdpPacketView(row, packet), { active: 'kdp' }));
});

app.post('/kdp-listings/:id/regenerate', async (req, res) => {
  try {
    const row = kdpListingById(req.params.id);
    if (!row) {
      res.status(404).send(layout('KDP Listing Not Found', '<section class="card"><h2>Not Found</h2></section>', { active: 'kdp' }));
      return;
    }
    const book = row.book_id ? bookById(row.book_id) : null;
    const penName = penNameById(row.pen_name_id || book?.pen_name_id, { includeInactive: true });
    const genreConfig = kdpGenreConfigForPen(penName?.id);
    const listing = kdpListingFieldsFromRow(row, book, genreConfig);
    const categoryRows = categoryRowsForKdpConfig(genreConfig, listing.targetCategories);
    const manuscriptAnalysis = row.manuscript_analysis_id ? manuscriptAnalysisById(row.manuscript_analysis_id) : latestManuscriptAnalysis(book?.id);
    const manuscriptBrief = manuscriptAnalysis ? effectiveManuscriptBrief(manuscriptAnalysis) : null;
    const generated = await generateKdpPacket({ penName, genreConfig, book, listing, categoryRows, manuscriptBrief });
    sqlite.prepare(`
      UPDATE kdp_listings
      SET generated_packet = @generatedPacket,
        provider = @provider,
        manuscript_analysis_id = @manuscriptAnalysisId,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id: row.id,
      generatedPacket: JSON.stringify(generated.packet, null, 2),
      provider: generated.provider,
      manuscriptAnalysisId: manuscriptAnalysis?.id || null
    });
    res.redirect(`/kdp-listings/${row.id}`);
  } catch (error) {
    res.status(500).send(layout('KDP Regenerate Error', `<section class="card"><h2>KDP Regenerate Error</h2><pre>${escapeHtml(error.stack || error.message)}</pre></section><p><a class="button secondary" href="/kdp-listings">Back</a></p>`, { active: 'kdp' }));
  }
});

app.get('/kdp-listings/:id/text', (req, res) => {
  const row = kdpListingById(req.params.id);
  if (!row) {
    res.status(404).send('Not found');
    return;
  }
  const packet = parseJson(row.generated_packet, {});
  const filename = `${slugify(row.title || 'kdp-listing')}-kdp-packet.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(packetToFlatText(packet));
});

app.get('/ads', (req, res) => {
  const rows = sqlite.prepare(`
    SELECT a.*, p.display_name AS pen_name, b.title AS book_title FROM ad_entries a
    LEFT JOIN pen_names p ON p.id = a.pen_name_id
    LEFT JOIN books b ON b.id = a.book_id
    ORDER BY COALESCE(a.date_end, a.created_at) DESC
  `).all();
  res.send(layout('Ads', `
    <div class="grid">
      <section class="card span-6"><h2>Add Manual Ad Entry</h2>${adForm()}</section>
      <section class="card span-6"><h2>Amazon Ads Report Import</h2>${amazonAdsImportForm()}</section>
      <section class="card span-12">${adIntegrationPanels()}</section>
      <section class="span-12">${rows.length ? table(['Campaign','Platform','Source','Pen','Book','Spend','Revenue','ACOS','ROI'], rows.map((r) => { const m = adMetrics(r); return [r.campaign_name, r.platform, r.source || '', r.pen_name || '', r.book_title || '', money(r.spend), money(r.revenue), formatPercent(m.acos), formatPercent(m.roi)]; })) : '<p class="muted">No ad entries yet.</p>'}</section>
    </div>
  `, { active: 'ads' }));
});

app.post('/ads', (req, res) => {
  sqlite.prepare(`
    INSERT INTO ad_entries (campaign_name, platform, source, pen_name_id, book_id, date_start, date_end, spend, clicks, conversions, sales, revenue, profile_id, notes)
    VALUES (@campaignName, @platform, 'manual', @penNameId, @bookId, @dateStart, @dateEnd, @spend, @clicks, @conversions, @sales, @revenue, @profileId, @notes)
  `).run({ ...req.body, spend: parseMoney(req.body.spend), revenue: parseMoney(req.body.revenue), clicks: Number(req.body.clicks || 0), conversions: Number(req.body.conversions || 0), sales: Number(req.body.sales || 0), bookId: req.body.bookId || null, profileId: req.body.profileId || '' });
  res.redirect('/ads');
});

app.post('/ads/amazon/import', upload.single('amazonAds'), (req, res) => {
  if (!req.file) {
    res.redirect('/ads');
    return;
  }
  const rows = parseSpreadsheetRows(req.file.buffer, req.file.originalname);
  const result = importAmazonAdsRows(rows, req.body);
  res.send(layout('Amazon Ads Imported', `
    <section class="card">
      <h2>Amazon Ads Imported</h2>
      <p class="metric">${escapeHtml(result.upserted)}</p>
      <p class="muted">rows added or updated from ${escapeHtml(req.file.originalname)}. ${escapeHtml(result.skipped)} rows skipped.</p>
      <p><a class="button secondary" href="/ads">Back to Ads</a></p>
    </section>
  `, { active: 'ads' }));
});

app.get('/ad-copy', (req, res) => {
  const drafts = sqlite.prepare(`
    SELECT d.*, p.display_name AS pen_name, b.title AS book_title FROM ad_copy_drafts d
    LEFT JOIN pen_names p ON p.id = d.pen_name_id
    LEFT JOIN books b ON b.id = d.book_id
    ORDER BY d.created_at DESC LIMIT 20
  `).all();
  res.send(layout('Ad Copy', `<section class="card"><h2>Draft Ad Copy</h2>${adCopyForm()}</section>${drafts.length ? table(['Pen','Book','Platform','Angle','Body'], drafts.map((d) => [d.pen_name || '', d.book_title || '', d.platform, d.angle || '', d.body])) : '<p class="muted">No drafts yet.</p>'}`, { active: 'copy' }));
});

app.post('/ad-copy', asyncRoute(async (req, res) => {
  const penName = penNameById(req.body.penNameId);
  const book = req.body.bookId ? sqlite.prepare('SELECT * FROM books WHERE id = ?').get(req.body.bookId) : null;
  const draft = await draftAdCopy({ penName, book, platform: req.body.platform, angle: req.body.angle });
  sqlite.prepare(`
    INSERT INTO ad_copy_drafts (pen_name_id, book_id, platform, angle, body, provider, prompt)
    VALUES (@penNameId, @bookId, @platform, @angle, @body, @provider, @prompt)
  `).run({ penNameId: req.body.penNameId, bookId: req.body.bookId || null, platform: req.body.platform, angle: req.body.angle, body: draft.text, provider: draft.provider, prompt: req.body.angle });
  res.redirect('/ad-copy');
}));

app.get('/pen-names', (req, res) => {
  const rows = allPenNames({ includeInactive: true });
  res.send(layout('Pen Names', `
    <div class="grid">
      <section class="card span-12">
        <h2>Add Pen Name</h2>
        ${penNameForm({ mode: 'add', action: '/pen-names' })}
      </section>
      ${rows.map(penNameCard).join('')}
    </div>
  `, { active: 'pen-names' }));
});

app.post('/pen-names', (req, res) => {
  const fields = penNameFieldsFromBody(req.body);
  const key = uniquePenNameKey(fields.displayName);
  sqlite.prepare(`
    INSERT INTO pen_names
      (key, display_name, brand_details, email_octopus_list_id, amazon_ads_profile_id, buffer_channels, color_palette, fonts, social_handles, active)
    VALUES
      (@key, @displayName, @brandDetails, @emailOctopusListId, @amazonAdsProfileId, @bufferChannels, @colorPalette, @fonts, @socialHandles, @active)
  `).run({ key, ...fields });
  res.redirect('/pen-names');
});

app.post('/pen-names/:id', (req, res) => {
  const fields = penNameFieldsFromBody(req.body);
  sqlite.prepare(`
    UPDATE pen_names
    SET display_name = @displayName,
      brand_details = @brandDetails,
      email_octopus_list_id = @emailOctopusListId,
      amazon_ads_profile_id = @amazonAdsProfileId,
      buffer_channels = @bufferChannels,
      color_palette = @colorPalette,
      fonts = @fonts,
      social_handles = @socialHandles,
      active = @active,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id: req.params.id, ...fields });
  res.redirect('/pen-names');
});

app.post('/pen-names/:id/retire', (req, res) => {
  sqlite.prepare('UPDATE pen_names SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.redirect('/pen-names');
});

app.post('/pen-names/:id/restore', (req, res) => {
  sqlite.prepare('UPDATE pen_names SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.redirect('/pen-names');
});

app.post('/pen-names/:id/delete', (req, res) => {
  const pen = penNameById(req.params.id, { includeInactive: true });
  if (!pen) {
    res.redirect('/pen-names');
    return;
  }
  const links = penNameLinkedCounts(pen.id).filter((item) => item.count > 0);
  if (links.length) {
    const summary = links.map((item) => `${item.label}: ${item.count}`).join('<br>');
    res.status(409).send(layout('Cannot Remove Pen Name', `
      <section class="card">
        <h2>${escapeHtml(pen.display_name)} still has linked records</h2>
        <p class="muted">Retire this pen name instead to hide it from normal dropdowns while preserving its history.</p>
        <p>${summary}</p>
        <form method="post" action="/pen-names/${escapeHtml(pen.id)}/retire"><button>Retire Pen Name</button></form>
        <p><a class="button secondary" href="/pen-names">Back</a></p>
      </section>
    `, { active: 'pen-names' }));
    return;
  }
  const tx = sqlite.transaction((id) => {
    sqlite.prepare('DELETE FROM kdp_genre_configs WHERE pen_name_id = ?').run(id);
    sqlite.prepare('DELETE FROM pen_names WHERE id = ?').run(id);
  });
  tx(pen.id);
  res.redirect('/pen-names');
});

app.post('/pen-names/:id/newsletter', (req, res) => {
  sqlite.prepare('UPDATE pen_names SET email_octopus_list_id = @emailOctopusListId, updated_at = CURRENT_TIMESTAMP WHERE id = @id').run({
    id: req.params.id,
    emailOctopusListId: String(req.body.emailOctopusListId || '').trim() || null
  });
  res.redirect('/pen-names');
});

app.get('/import', (req, res) => {
  res.send(layout('Import', `
    <section class="card">
      <h2>Import From Spreadsheet CSVs</h2>
      <p class="muted">In Google Sheets, open each tab, use File > Download > CSV, then upload the matching files here. This imports into the local Author HQ database.</p>
      <form class="stack" method="post" action="/import" enctype="multipart/form-data">
        ${importInput('launchChecklists', 'LaunchChecklists')}
        ${importInput('goals', 'Goals')}
        ${importInput('milestones', 'Milestones')}
        ${importInput('books', 'Books')}
        ${importInput('expenses', 'Expenses')}
        ${importInput('income', 'Income')}
        ${importInput('royalties', 'Royalties')}
        ${importInput('subscriptions', 'Subscriptions')}
        <button>Import Selected CSVs</button>
      </form>
    </section>
  `, { active: 'import' }));
});

app.post('/import', upload.fields([
  { name: 'launchChecklists', maxCount: 1 },
  { name: 'goals', maxCount: 1 },
  { name: 'milestones', maxCount: 1 },
  { name: 'books', maxCount: 1 },
  { name: 'expenses', maxCount: 1 },
  { name: 'income', maxCount: 1 },
  { name: 'royalties', maxCount: 1 },
  { name: 'subscriptions', maxCount: 1 }
]), (req, res) => {
  const results = importCsvFiles(req.files || {});
  res.send(layout('Import Results', `
    <section class="card">
      <h2>Import Complete</h2>
      ${table(['Tab','Rows Imported'], Object.entries(results).map(([name, count]) => [name, String(count)]))}
      <p><a class="button secondary" href="/import">Back to import</a></p>
    </section>
  `, { active: 'import' }));
});

app.get('/settings', (req, res) => {
  const settings = redactedSettings();
  const maintenance = databaseMaintenanceStatus();
  const latestBackup = maintenance.backups[0];
  res.send(layout('Settings', `
    <section class="card">
      <div class="section-title-row"><div><h2>Data Safety</h2><p class="muted">Author HQ checks the database and keeps up to 14 daily backups automatically.</p></div><form method="post" action="/settings/backup"><button class="secondary">Backup Now</button></form></div>
      <div class="metric-strip">
        <div class="metric-tile"><span class="eyebrow">Database</span><strong>${maintenance.health.ok ? 'Healthy' : 'Needs attention'}</strong><small>${escapeHtml(maintenance.health.path)}</small></div>
        <div class="metric-tile"><span class="eyebrow">Latest backup</span><strong>${latestBackup ? formatDateTime(latestBackup.modifiedAt) : 'Not created yet'}</strong><small>${escapeHtml(maintenance.backupDir)}</small></div>
      </div>
    </section>
    <section class="card">
      <h2>Settings</h2>
      <p class="muted">These values are stored locally at <code>${escapeHtml(settingsPath())}</code>. Leave a secret field as dots to keep its current value.</p>
      <form class="stack" method="post" action="/settings">
        <h3>App Lock</h3>
        ${settingsInput('AUTH_PASSPHRASE', 'App passphrase', settings)}
        ${settingsInput('COOKIE_SECRET', 'Cookie secret', settings)}

        <h3>Newsletter Claude</h3>
        ${settingsInput('OPENROUTER_API_KEY', 'OpenRouter API key', settings)}
        <p class="tiny">Newsletter conversations use Claude Haiku through OpenRouter; final drafts use Claude Sonnet. Requests require providers that deny data collection and support zero data retention.</p>

        <h3>Direct Claude Fallback</h3>
        ${settingsInput('ANTHROPIC_API_KEY', 'Claude API key', settings)}

        <h3>Existing Integrations</h3>
        ${settingsInput('BUFFER_TOKEN', 'Buffer token', settings)}
        ${settingsInput('BUFFER_ORGANIZATION_ID', 'Buffer organization ID', settings)}
        ${settingsInput('CO_TEACHING_CREDITS_URL', 'Co-teaching credits form URL', settings)}
        ${settingsInput('EMAILOCTOPUS_API_KEY', 'EmailOctopus API key', settings)}

        <h3>Amazon Ads API</h3>
        ${settingsInput('AMAZON_ADS_CLIENT_ID', 'Client ID', settings)}
        ${settingsInput('AMAZON_ADS_CLIENT_SECRET', 'Client Secret', settings)}
        ${settingsInput('AMAZON_ADS_REDIRECT_URI', 'Redirect URI', settings)}
        ${settingsInput('AMAZON_ADS_REFRESH_TOKEN', 'Refresh Token', settings)}

        <h3>Google Calendar</h3>
        ${settingsTextarea('GOOGLE_OAUTH_CLIENT_JSON', 'OAuth client JSON', settings)}
        ${settingsInput('GOOGLE_CALENDAR_ID', 'Calendar ID', settings)}

        <h3>Brain Storage</h3>
        ${settingsInput('KNOWLEDGE_BASE_ROOT', 'Knowledge base folder', settings)}

        <h3>Future Meta Ads API</h3>
        ${settingsInput('META_APP_ID', 'Meta app ID', settings)}
        ${settingsInput('META_APP_SECRET', 'Meta app secret', settings)}
        ${settingsInput('META_REDIRECT_URI', 'Meta redirect URI', settings)}
        <button>Save Settings</button>
      </form>
    </section>
  `, { active: 'settings' }));
});

app.post('/settings/backup', asyncRoute(async (req, res) => {
  const result = await createDatabaseBackup({ force: true });
  res.send(layout('Backup Complete', `<section class="card"><h2>Backup Complete</h2><p class="muted">Your data was backed up successfully.</p><p class="tiny">${escapeHtml(result.path)}</p><p><a class="button secondary" href="/settings">Back to Settings</a></p></section>`, { active: 'settings' }));
}));

app.post('/settings', (req, res) => {
  const current = loadSettings();
  const next = {};
  allSettingKeys().forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(req.body, key)) return;
    const value = req.body[key] || '';
    if (value.includes('**') && current[key] == null) return;
    next[key] = value.includes('**') ? current[key] : value;
  });
  saveSettings(next);
  res.redirect('/settings');
});

app.get('/integrations/meta/start', (req, res) => {
  const url = getMetaAuthUrl();
  if (!url) {
    res.send(layout('Meta Integration', '<section class="card"><h2>Meta Not Configured</h2><p>Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI to .env first.</p></section>', { active: 'ads' }));
    return;
  }
  res.redirect(url);
});

app.get('/integrations/meta/callback', (req, res) => {
  res.send(layout('Meta Integration', `<section class="card"><h2>Meta Callback Stub</h2><p>Received callback code. Token exchange is intentionally stubbed until Marketing API access is available.</p><pre>${escapeHtml(JSON.stringify(req.query, null, 2))}</pre></section>`, { active: 'ads' }));
});

app.get('/integrations/amazon-ads/start', (req, res) => {
  const url = getAmazonAdsAuthUrl();
  if (!url) {
    res.send(layout('Amazon Ads Integration', '<section class="card"><h2>Amazon Ads Not Configured</h2><p>Add the Amazon Ads Client ID, Client Secret, and Redirect URI in Settings first.</p><p><a class="button secondary" href="/settings">Open Settings</a></p></section>', { active: 'ads' }));
    return;
  }
  res.redirect(url);
});

app.get('/integrations/amazon-ads/callback', (req, res) => {
  (async () => {
    try {
      if (!req.query.code) throw new Error('Amazon did not return an authorization code.');
      await exchangeAmazonAdsCode(req.query.code);
      res.send(layout('Amazon Ads Connected', '<section class="card"><h2>Amazon Ads Connected</h2><p class="muted">Author HQ saved the refresh token locally. Next, load profiles and copy the right Profile ID onto each pen name.</p><p class="action-row"><a class="button" href="/ads/amazon/profiles">Load Profiles</a><a class="button secondary" href="/ads">Back to Ads</a></p></section>', { active: 'ads' }));
    } catch (error) {
      res.status(500).send(layout('Amazon Ads Error', `<section class="card"><h2>Amazon Ads Error</h2><pre>${escapeHtml(error.stack || error.message)}</pre><p><a class="button secondary" href="/ads">Back to Ads</a></p></section>`, { active: 'ads' }));
    }
  })();
});

app.get('/ads/amazon/profiles', async (req, res) => {
  try {
    const profiles = await listAmazonAdsProfiles();
    const rows = Array.isArray(profiles) ? profiles : profiles?.profiles || [];
    res.send(layout('Amazon Ads Profiles', `
      <section class="card">
        <h2>Amazon Ads Profiles</h2>
        <p class="muted">Copy the Profile ID for each ad account into the matching Pen Name. Skip R.A. Lorne.</p>
        ${rows.length ? table(['Profile ID','Name','Country','Currency','Type'], rows.map((profile) => [
          profile.profileId || profile.profile_id || profile.id || '',
          profile.accountInfo?.name || profile.name || '',
          profile.countryCode || profile.country || '',
          profile.currencyCode || profile.currency || '',
          profile.accountInfo?.type || profile.type || ''
        ])) : '<p class="muted">No Amazon Ads profiles returned yet.</p>'}
        <p><a class="button secondary" href="/pen-names">Open Pen Names</a> <a class="button secondary" href="/ads">Back to Ads</a></p>
      </section>
    `, { active: 'ads' }));
  } catch (error) {
    res.status(500).send(layout('Amazon Ads Profiles Error', `<section class="card"><h2>Amazon Ads Profiles Error</h2><pre>${escapeHtml(error.stack || error.message)}</pre><p><a class="button secondary" href="/ads">Back to Ads</a></p></section>`, { active: 'ads' }));
  }
});

app.post('/ads/amazon/pull', async (req, res) => {
  try {
    const startDate = normalizeDate(req.body.startDate || addDaysIso(todayIso(), -7));
    const endDate = normalizeDate(req.body.endDate || todayIso());
    const pens = allPenNames()
      .filter((pen) => pen.amazon_ads_profile_id && pen.display_name !== 'R.A. Lorne')
      .filter((pen) => !req.body.penNameId || String(pen.id) === String(req.body.penNameId));
    let imported = 0;
    const details = [];
    for (const pen of pens) {
      const requested = await requestAmazonSponsoredProductsCampaignReport({ profileId: pen.amazon_ads_profile_id, startDate, endDate });
      const reportId = requested.reportId || requested.report_id || requested.id;
      if (!reportId) throw new Error(`Amazon did not return a report ID for ${pen.display_name}.`);
      const ready = await waitForAmazonAdsReport(reportId);
      const rows = await downloadAmazonAdsReport(ready.url);
      const result = importAmazonAdsRows(rows, { penNameId: pen.id, profileId: pen.amazon_ads_profile_id });
      imported += result.upserted;
      details.push([pen.display_name, reportId, String(result.upserted), String(result.skipped)]);
    }
    res.send(layout('Amazon Ads Pull Complete', `
      <section class="card">
        <h2>Amazon Ads Pull Complete</h2>
        <p class="metric">${escapeHtml(imported)}</p>
        <p class="muted">campaign rows added or updated for ${escapeHtml(startDate)} through ${escapeHtml(endDate)}.</p>
        ${details.length ? table(['Pen','Report ID','Imported','Skipped'], details) : '<p class="muted">No pen names have Amazon Ads Profile IDs yet.</p>'}
        <p><a class="button secondary" href="/ads">Back to Ads</a></p>
      </section>
    `, { active: 'ads' }));
  } catch (error) {
    res.status(500).send(layout('Amazon Ads Pull Error', `<section class="card"><h2>Amazon Ads Pull Error</h2><pre>${escapeHtml(error.stack || error.message)}</pre><p><a class="button secondary" href="/ads">Back to Ads</a></p></section>`, { active: 'ads' }));
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((req, res) => {
  res.status(404).send(notFoundPage('Page', '/', 'dashboard'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error(error);
  const isUploadError = error instanceof multer.MulterError;
  const message = isUploadError && error.code === 'LIMIT_FILE_SIZE'
    ? 'That file is larger than the 32 MB import limit.'
    : isUploadError
      ? 'Author HQ could not accept that upload. Please check the file and try again.'
      : 'Author HQ hit an unexpected problem. Your saved data is still intact.';
  res.status(isUploadError ? 400 : 500).send(layout('Something Went Wrong', `
    <section class="card error-state">
      <h2>Something went wrong</h2>
      <p class="muted">${escapeHtml(message)}</p>
      <div class="action-row"><button class="secondary" type="button" onclick="history.back()">Go Back</button><a class="button secondary" href="/">Dashboard</a></div>
      <details class="kb-move-panel"><summary>Technical details</summary><pre>${escapeHtml(error.stack || error.message || String(error))}</pre></details>
    </section>
  `));
});

export async function startServer({ port = Number(process.env.PORT || 3131), host = '127.0.0.1' } = {}) {
  initializeDatabase();
  const health = databaseMaintenanceStatus().health;
  if (!health.ok) throw new Error(`Database health check failed: ${health.quickCheck.join(', ')}`);
  await createDatabaseBackup();
  startImprovementScheduler();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const actualPort = server.address().port;
      console.log(`Author HQ listening on http://${host}:${actualPort}`);
      resolve({
        server,
        port: actualPort,
        host,
        url: `http://${host}:${actualPort}`,
        close: () => {
          stopImprovementScheduler();
          return new Promise((closeResolve, closeReject) => server.close((error) => error ? closeReject(error) : closeResolve()));
        }
      });
    });
    server.on('error', reject);
  });
}

function stopImprovementScheduler() {
  if (improvementScheduleStartupTimer) clearTimeout(improvementScheduleStartupTimer);
  if (improvementScheduleTimer) clearInterval(improvementScheduleTimer);
  improvementScheduleStartupTimer = null;
  improvementScheduleTimer = null;
  improvementScheduleRunning = false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function saveParsedEntry(parsed) {
  if (parsed.type === 'weekly-summary') {
    await saveWeeklySummary(parsed);
    return;
  }
  if (parsed.type === 'subscription') {
    const annualizedCost = billingMonthlyEquivalent(parsed.monthlyCost, parsed.billingCycle) * 12;
    const values = { ...parsed, active: parsed.active ? 1 : 0, annualizedCost };
    const existing = sqlite.prepare('SELECT id FROM subscriptions WHERE lower(service) = lower(?)').get(parsed.service);
    if (existing) {
      sqlite.prepare(`
        UPDATE subscriptions SET category=@category, monthly_cost=@monthlyCost, billing_cycle=@billingCycle,
          renewal_date=@renewalDate, payment_method=@paymentMethod, active=@active, notes=@notes,
          annualized_cost=@annualizedCost, updated_at=CURRENT_TIMESTAMP WHERE id=@id
      `).run({ ...values, id: existing.id });
    } else {
      sqlite.prepare(`
        INSERT INTO subscriptions (service, category, monthly_cost, billing_cycle, renewal_date, payment_method, active, notes, annualized_cost)
        VALUES (@service, @category, @monthlyCost, @billingCycle, @renewalDate, @paymentMethod, @active, @notes, @annualizedCost)
      `).run(values);
    }
    return;
  }
  if (parsed.type === 'income') {
    sqlite.prepare('INSERT INTO income (date, platform, income_type, amount, notes) VALUES (@date, @platform, @incomeType, @amount, @notes)').run(parsed);
    return;
  }
  if (parsed.type === 'book') {
    const existing = sqlite.prepare('SELECT * FROM books WHERE lower(title) = lower(?)').get(parsed.title);
    if (existing) {
      sqlite.prepare('UPDATE books SET status = COALESCE(@status, status), word_count = COALESCE(@wordCount, word_count), notes = @notes, updated_at = CURRENT_TIMESTAMP WHERE id = @id').run({ ...parsed, id: existing.id });
    } else {
      sqlite.prepare('INSERT INTO books (title, status, word_count, notes) VALUES (@title, COALESCE(@status, "Planning"), COALESCE(@wordCount, 0), @notes)').run(parsed);
    }
    return;
  }
  if (parsed.type === 'milestone') {
    const pen = findPenName(parsed.penName || parsed.penNameLabel);
    sqlite.prepare(`
      INSERT INTO milestones (date, emoji, title, description, notes, pen_name_id, pen_name_label)
      VALUES (@date, @emoji, @title, @description, @notes, @penNameId, @penNameLabel)
    `).run({
      date: parsed.date || todayIso(),
      emoji: parsed.emoji || '*',
      title: parsed.title || 'Milestone',
      description: parsed.description || parsed.title || '',
      notes: parsed.notes || '',
      penNameId: pen?.id || null,
      penNameLabel: pen?.display_name || parsed.penName || parsed.penNameLabel || 'All'
    });
    return;
  }
  if (parsed.type === 'life-task') {
    sqlite.prepare(`
      INSERT INTO life_tasks (title, category, status, due_date, priority, energy, notes, source)
      VALUES (@title, @category, @status, @dueDate, @priority, @energy, @notes, 'quick-log')
    `).run(parsed);
    return;
  }
  if (parsed.type === 'life-routine') {
    sqlite.prepare(`
      INSERT INTO life_routines (title, category, cadence, next_due, status, notes)
      VALUES (@title, @category, @cadence, @nextDue, @status, @notes)
    `).run(parsed);
    return;
  }
  if (parsed.type === 'life-log') {
    sqlite.prepare(`
      INSERT INTO life_logs (log_date, category, title, body, mood, energy, source)
      VALUES (@logDate, @category, @title, @body, @mood, @energy, @source)
    `).run(parsed);
    return;
  }
  sqlite.prepare(`
    INSERT INTO expenses (date, vendor, description, category, payment_method, recurring, amount, receipt_saved, notes)
    VALUES (@date, @vendor, @description, @category, @paymentMethod, @recurring, @amount, @receiptSaved, @notes)
  `).run({ ...parsed, recurring: parsed.recurring ? 1 : 0 });
}

function allPenNames({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return sqlite.prepare(`SELECT * FROM pen_names ${where} ORDER BY display_name`).all();
}

function allBooks() {
  return sqlite.prepare('SELECT * FROM books ORDER BY title').all();
}

function lifeTasks({ status = 'Open', dueBefore = '', includeUndated = true, limit = 20 } = {}) {
  const clauses = [];
  const params = {};
  if (status && status !== 'All') {
    clauses.push('lower(status) = lower(@status)');
    params.status = status;
  }
  if (dueBefore) {
    clauses.push(includeUndated ? "(due_date IS NULL OR due_date = '' OR due_date <= @dueBefore)" : "(due_date IS NOT NULL AND due_date != '' AND due_date <= @dueBefore)");
    params.dueBefore = dueBefore;
  }
  params.limit = limit;
  return sqlite.prepare(`
    SELECT * FROM life_tasks
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY CASE WHEN due_date IS NULL OR due_date = '' THEN 1 ELSE 0 END, due_date, CASE priority WHEN 'High' THEN 0 WHEN 'Normal' THEN 1 ELSE 2 END, id DESC
    LIMIT @limit
  `).all(params);
}

function lifeRoutines({ includeInactive = false, limit = 20 } = {}) {
  return sqlite.prepare(`
    SELECT * FROM life_routines
    ${includeInactive ? '' : "WHERE status = 'Active'"}
    ORDER BY CASE WHEN next_due IS NULL OR next_due = '' THEN 1 ELSE 0 END, next_due, id DESC
    LIMIT ?
  `).all(limit);
}

function lifeLogs({ limit = 20 } = {}) {
  return sqlite.prepare(`
    SELECT * FROM life_logs
    ORDER BY log_date DESC, id DESC
    LIMIT ?
  `).all(limit);
}

function journalEntries({ startDate = '', endDate = '', limit = 20 } = {}) {
  const clauses = [];
  const params = { limit };
  if (startDate) {
    clauses.push('entry_date >= @startDate');
    params.startDate = startDate;
  }
  if (endDate) {
    clauses.push('entry_date <= @endDate');
    params.endDate = endDate;
  }
  return sqlite.prepare(`
    SELECT * FROM journal_entries
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY entry_date DESC, id DESC
    LIMIT @limit
  `).all(params);
}

function saveJournalEntry(body) {
  const entryDate = normalizeDate(body.entryDate || todayIso()) || todayIso();
  const title = String(body.title || '').trim() || `Journal - ${entryDate}`;
  const text = String(body.body || '').trim();
  if (!text) throw new Error('Write a little something before saving.');
  const paths = knowledgeBasePaths();
  setupKnowledgeBase({ logRun: false });
  fs.mkdirSync(paths.rawJournal, { recursive: true });
  const tags = String(body.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const outputPath = path.join(paths.rawJournal, `${entryDate}-${slugify(title)}.md`);
  const markdown = `# ${title}

Date: ${entryDate}
Mood: ${String(body.mood || '').trim() || 'n/a'}
Energy: ${String(body.energy || '').trim() || 'n/a'}
Tags: ${tags.join(', ') || 'n/a'}

${text}
`;
  fs.writeFileSync(outputPath, markdown);
  sqlite.prepare(`
    INSERT INTO journal_entries (entry_date, title, body, mood, energy, tags, source_path)
    VALUES (@entryDate, @title, @body, @mood, @energy, @tags, @sourcePath)
  `).run({
    entryDate,
    title,
    body: text,
    mood: String(body.mood || '').trim(),
    energy: String(body.energy || '').trim(),
    tags: JSON.stringify(tags),
    sourcePath: outputPath
  });
  sqlite.prepare(`
    INSERT INTO brain_notes (note_type, title, body, source_path, status, important)
    VALUES ('Journal', @title, @body, @sourcePath, 'Active', 0)
  `).run({
    title: `Journal - ${entryDate} - ${title}`,
    body: text.slice(0, 5000),
    sourcePath: outputPath
  });
  return { outputPath };
}

function bookById(id) {
  if (!id) return null;
  return sqlite.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

function findBookByTitle(title) {
  if (!title) return null;
  return sqlite.prepare('SELECT * FROM books WHERE lower(title) = lower(?)').get(String(title).trim());
}

function penNameById(id, { includeInactive = false } = {}) {
  if (!id) return null;
  const where = includeInactive ? 'id = ?' : 'id = ? AND active = 1';
  return sqlite.prepare(`SELECT * FROM pen_names WHERE ${where}`).get(id);
}

function penNameLinkedCounts(id) {
  const count = (table) => sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE pen_name_id = ?`).get(id).count;
  return [
    { label: 'Books', count: count('books') },
    { label: 'Goals', count: count('goals') },
    { label: 'Milestones', count: count('milestones') },
    { label: 'Expenses', count: count('expenses') },
    { label: 'Content posts', count: count('content_posts') },
    { label: 'Ad entries', count: count('ad_entries') },
    { label: 'Ad copy drafts', count: count('ad_copy_drafts') },
    { label: 'Royalty rows', count: count('royalty_entries') },
    { label: 'Brain documents', count: count('brain_documents') },
    { label: 'Brain notes', count: count('brain_notes') },
    { label: 'Calendar events', count: count('calendar_events') },
    { label: 'KDP listing packets', count: count('kdp_listings') }
  ];
}

function databaseCounts() {
  const count = (table) => sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return [
    { label: 'Pen names', count: count('pen_names') },
    { label: 'Books', count: count('books') },
    { label: 'Goals', count: count('goals') },
    { label: 'Milestones', count: count('milestones') },
    { label: 'Expenses', count: count('expenses') },
    { label: 'Income rows', count: count('income') },
    { label: 'Subscriptions', count: count('subscriptions') },
    { label: 'Royalty rows', count: count('royalty_entries') },
    { label: 'Brain documents', count: count('brain_documents') },
    { label: 'Brain notes', count: count('brain_notes') },
    { label: 'Calendar events', count: count('calendar_events') },
    { label: 'Improvement runs', count: count('hq_improvement_runs') }
  ];
}

function brainRoots() {
  return sqlite.prepare('SELECT * FROM brain_roots ORDER BY active DESC, label').all();
}

function recentImprovementRuns(limit = 8) {
  return sqlite.prepare('SELECT * FROM hq_improvement_runs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
}

function recentImprovementItems(limit = 12) {
  return improvementItemsForReview({ status: 'All', limit });
}

function improvementItemsForReview({ status = 'Proposed', bucket = 'All', limit = 100 } = {}) {
  const clauses = [];
  const params = {};
  if (status && status !== 'All') {
    clauses.push('lower(i.status) = lower(@status)');
    params.status = status;
  }
  if (bucket && bucket !== 'All') {
    clauses.push('lower(i.bucket) = lower(@bucket)');
    params.bucket = bucket;
  }
  params.limit = limit;
  return sqlite.prepare(`
    SELECT i.*, r.run_type
    FROM hq_improvement_items i
    LEFT JOIN hq_improvement_runs r ON r.id = i.run_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY CASE lower(i.status) WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, i.created_at DESC, i.id DESC
    LIMIT @limit
  `).all(params);
}

function improvementReviewCounts() {
  const counts = sqlite.prepare(`
    SELECT lower(status) AS status, COUNT(*) AS count
    FROM hq_improvement_items
    GROUP BY lower(status)
  `).all();
  return Object.fromEntries(counts.map((row) => [row.status || 'unknown', row.count]));
}

function improvementItemById(id) {
  return sqlite.prepare(`
    SELECT i.*, r.run_type
    FROM hq_improvement_items i
    LEFT JOIN hq_improvement_runs r ON r.id = i.run_id
    WHERE i.id = ?
  `).get(id);
}

function startImprovementScheduler() {
  if (improvementScheduleTimer) return;
  improvementScheduleStartupTimer = setTimeout(() => {
    improvementScheduleStartupTimer = null;
    runScheduledImprovementIfDue().catch((error) => logScheduledImprovementError(error));
  }, 15000);
  improvementScheduleTimer = setInterval(() => {
    runScheduledImprovementIfDue().catch((error) => logScheduledImprovementError(error));
  }, 60 * 60 * 1000);
}

async function runScheduledImprovementIfDue() {
  if (improvementScheduleRunning || !improvementScheduleDue()) return;
  improvementScheduleRunning = true;
  try {
    await suggestAuthorHqImprovements();
    saveSettings({ IMPROVEMENT_SCHEDULE_LAST_RUN: todayIso() });
  } finally {
    improvementScheduleRunning = false;
  }
}

function improvementScheduleDue(now = new Date()) {
  const settings = loadSettings();
  if (settings.IMPROVEMENT_SCHEDULE_ENABLED !== '1') return false;
  const scheduledDay = Number(settings.IMPROVEMENT_SCHEDULE_DAY || 5);
  const scheduledTime = String(settings.IMPROVEMENT_SCHEDULE_TIME || '17:00');
  const [hour, minute] = scheduledTime.split(':').map((part) => Number(part) || 0);
  const lastRun = settings.IMPROVEMENT_SCHEDULE_LAST_RUN || '';
  const lastScheduled = lastScheduledImprovementDate(now, scheduledDay, hour, minute);
  if (!lastScheduled) return false;
  return lastRun < lastScheduled;
}

function lastScheduledImprovementDate(now, scheduledDay, hour, minute) {
  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  const daysBack = (due.getDay() - scheduledDay + 7) % 7;
  due.setDate(due.getDate() - daysBack);
  if (due > now) due.setDate(due.getDate() - 7);
  return dateToIso(due);
}

function logScheduledImprovementError(error) {
  try {
    logImprovementRun({
      runType: 'scheduled-improve-system',
      provider: 'local',
      status: 'Failed',
      summary: `Scheduled improvement run failed: ${error.message}`,
      rawOutput: error.stack || error.message
    });
  } catch {
    console.error(error);
  }
}

function expenseCategoryRollup() {
  return sqlite.prepare(`
    SELECT COALESCE(NULLIF(category, ''), 'Uncategorized') AS category, COUNT(*) AS count, SUM(amount) AS total
    FROM expenses
    WHERE substr(date, 1, 7) = substr(?, 1, 7)
    GROUP BY COALESCE(NULLIF(category, ''), 'Uncategorized')
    ORDER BY total DESC
  `).all(todayIso());
}

function applyImprovementItem(item) {
  const text = `${item.title || ''} ${item.body || ''}`.toLowerCase();
  if (text.includes('expense category')) {
    const noteId = saveImprovementDecisionNote(item, 'Applied: monthly expense category rollup is now visible on the Expenses page.');
    return { status: 'Applied', noteId };
  }
  if (text.includes('income') && text.includes('royalt')) {
    const noteId = saveImprovementDecisionNote(item, 'Applied as policy: royalties and income stay separate. Royalties track title performance over reporting periods; income tracks actual payouts or manual non-royalty income.');
    return { status: 'Applied', noteId };
  }
  if (text.includes('brain notes') && text.includes('brain documents')) {
    const noteId = saveImprovementDecisionNote(item, 'Applied as policy: Brain documents are indexed source files. Brain notes are explicit decisions, corrections, and workflow memories captured inside Author HQ.');
    return { status: 'Applied', noteId };
  }
  if (text.includes('improvement run')) {
    const noteId = saveImprovementDecisionNote(item, 'Applied as policy: improvement runs stay manual for now and are triggered only when a review pass is wanted.');
    return { status: 'Applied', noteId };
  }
  if (text.includes('manuscript status') || text.includes('progress')) {
    const noteId = saveImprovementDecisionNote(item, 'Applied as policy: the Books table is the source of truth for public workflow status. Brain files are supporting context, not authoritative status.');
    return { status: 'Applied', noteId };
  }
  if (text.includes('doc count') || text.includes('categorized index') || text.includes('index page to brain')) {
    const result = runBrainMaintenance();
    const noteId = saveImprovementDecisionNote(item, `Applied: generated a categorized Brain document index at ${result.indexPath}.`);
    return { status: 'Applied', noteId };
  }
  if (text.includes('duplicate brain docs') || text.includes('timestamp')) {
    const result = runBrainMaintenance();
    const noteId = saveImprovementDecisionNote(item, `Applied: removed ${result.duplicatesRemoved} duplicate timestamped rows from Author HQ's Brain index. Source files were not deleted.`);
    return { status: 'Applied', noteId };
  }
  if (text.includes('copyedit') && text.includes('archive')) {
    const result = runBrainMaintenance();
    const noteId = saveImprovementDecisionNote(item, `Applied safely: generated copyedit archive candidates at ${result.copyeditReportPath}. Source files were not moved.`);
    return { status: 'Applied', noteId };
  }
  if (text.includes('verified live')) {
    const noteId = saveImprovementDecisionNote(item, 'Applied: Content posts now include a Verified Live checkbox and table column.');
    return { status: 'Applied', noteId };
  }
  const noteId = saveImprovementDecisionNote(item, `Planned implementation: ${item.title}\n\n${item.body || ''}`.trim());
  return { status: 'Planned', noteId };
}

function saveImprovementDecisionNote(item, body) {
  return sqlite.prepare(`
    INSERT INTO brain_notes (note_type, title, body, source_path, status, important)
    VALUES ('Workflow', @title, @body, @sourcePath, 'Active', 1)
  `).run({
    title: `Improvement: ${item.title}`.slice(0, 180),
    body,
    sourcePath: `improvement-item:${item.id}`
  }).lastInsertRowid;
}

function recentBrainDocuments(limit = 80) {
  return sqlite.prepare(`
    SELECT d.*, r.label AS root_label, p.display_name AS pen_name, b.title AS book_title
    FROM brain_documents d
    LEFT JOIN brain_roots r ON r.id = d.root_id
    LEFT JOIN pen_names p ON p.id = d.pen_name_id
    LEFT JOIN books b ON b.id = d.book_id
    ORDER BY COALESCE(d.modified_at, d.indexed_at) DESC
    LIMIT ?
  `).all(limit);
}

function searchBrainDocuments(query, limit = 80) {
  const like = `%${String(query || '').toLowerCase()}%`;
  return sqlite.prepare(`
    SELECT d.*, r.label AS root_label, p.display_name AS pen_name, b.title AS book_title
    FROM brain_documents d
    LEFT JOIN brain_roots r ON r.id = d.root_id
    LEFT JOIN pen_names p ON p.id = d.pen_name_id
    LEFT JOIN books b ON b.id = d.book_id
    WHERE lower(d.file_name) LIKE @like
       OR lower(d.file_path) LIKE @like
       OR lower(COALESCE(d.title, '')) LIKE @like
       OR lower(COALESCE(d.snippet, '')) LIKE @like
       OR lower(COALESCE(d.tags, '')) LIKE @like
       OR lower(COALESCE(p.display_name, '')) LIKE @like
       OR lower(COALESCE(b.title, '')) LIKE @like
    ORDER BY COALESCE(d.modified_at, d.indexed_at) DESC
    LIMIT @limit
  `).all({ like, limit });
}

function recentBrainNotes(limit = 40) {
  return sqlite.prepare(`
    SELECT n.*, p.display_name AS pen_name, b.title AS book_title
    FROM brain_notes n
    LEFT JOIN pen_names p ON p.id = n.pen_name_id
    LEFT JOIN books b ON b.id = n.book_id
    ORDER BY n.important DESC, n.updated_at DESC, n.id DESC
    LIMIT ?
  `).all(limit);
}

function searchBrainNotes(query, limit = 80) {
  const like = `%${String(query || '').toLowerCase()}%`;
  return sqlite.prepare(`
    SELECT n.*, p.display_name AS pen_name, b.title AS book_title
    FROM brain_notes n
    LEFT JOIN pen_names p ON p.id = n.pen_name_id
    LEFT JOIN books b ON b.id = n.book_id
    WHERE lower(n.title) LIKE @like
       OR lower(n.body) LIKE @like
       OR lower(n.note_type) LIKE @like
       OR lower(COALESCE(n.source_path, '')) LIKE @like
       OR lower(COALESCE(p.display_name, '')) LIKE @like
       OR lower(COALESCE(b.title, '')) LIKE @like
    ORDER BY n.important DESC, n.updated_at DESC, n.id DESC
    LIMIT @limit
  `).all({ like, limit });
}

const brainExtensions = new Set(['.md', '.markdown', '.txt', '.rtf', '.html', '.htm', '.docx', '.pdf', '.scrivx']);
const textExtensions = new Set(['.md', '.markdown', '.txt', '.rtf', '.html', '.htm', '.scrivx']);
const skippedFolderNames = new Set(['.git', 'node_modules', 'dist', 'build', 'release', '.obsidian', '.trash', '__pycache__']);

function indexBrainRoots() {
  const roots = brainRoots().filter((root) => root.active);
  const result = { indexed: 0, skipped: 0, errors: [] };
  roots.forEach((root) => {
    if (!fs.existsSync(root.folder_path)) {
      result.skipped += 1;
      result.errors.push(`${root.label}: folder not found (${root.folder_path})`);
      return;
    }
    scanBrainFolder(root, root.folder_path, result);
    sqlite.prepare('UPDATE brain_roots SET last_indexed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(root.id);
  });
  return result;
}

function scanBrainFolder(root, folderPath, result, depth = 0) {
  if (depth > 12 || result.indexed >= 5000) return;
  let entries = [];
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch (error) {
    result.skipped += 1;
    result.errors.push(`${folderPath}: ${error.message}`);
    return;
  }
  entries.forEach((entry) => {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      if (skippedFolderNames.has(entry.name.toLowerCase())) {
        result.skipped += 1;
        return;
      }
      scanBrainFolder(root, fullPath, result, depth + 1);
      return;
    }
    if (!entry.isFile()) return;
    const ext = path.extname(entry.name).toLowerCase();
    if (!brainExtensions.has(ext)) {
      result.skipped += 1;
      return;
    }
    try {
      upsertBrainDocument(root, fullPath, ext);
      result.indexed += 1;
    } catch (error) {
      result.skipped += 1;
      result.errors.push(`${fullPath}: ${error.message}`);
    }
  });
}

function upsertBrainDocument(root, filePath, extension) {
  const stats = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  const title = fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim();
  const snippet = textExtensions.has(extension) && stats.size < 1024 * 1024 ? fileSnippet(filePath) : '';
  const matchedBook = matchBookForFile(filePath, title, snippet);
  const matchedPen = matchedBook?.pen_name_id ? penNameById(matchedBook.pen_name_id, { includeInactive: true }) : matchPenForFile(filePath, title, snippet);
  const tags = inferBrainTags(filePath, title);
  sqlite.prepare(`
    INSERT INTO brain_documents (root_id, file_path, file_name, extension, title, pen_name_id, book_id, tags, snippet, size_bytes, modified_at, indexed_at)
    VALUES (@rootId, @filePath, @fileName, @extension, @title, @penNameId, @bookId, @tags, @snippet, @sizeBytes, @modifiedAt, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path) DO UPDATE SET
      root_id=@rootId,
      file_name=@fileName,
      extension=@extension,
      title=@title,
      pen_name_id=@penNameId,
      book_id=@bookId,
      tags=@tags,
      snippet=@snippet,
      size_bytes=@sizeBytes,
      modified_at=@modifiedAt,
      indexed_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
  `).run({
    rootId: root.id,
    filePath,
    fileName,
    extension: extension.replace('.', ''),
    title,
    penNameId: matchedPen?.id || null,
    bookId: matchedBook?.id || null,
    tags: JSON.stringify(tags),
    snippet,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString()
  });
}

function fileSnippet(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 420);
}

function matchBookForFile(filePath, title, snippet = '') {
  const haystack = normalizeMatchText(`${filePath} ${title} ${snippet}`);
  return allBooks().find((book) => haystack.includes(normalizeMatchText(book.title)));
}

function matchPenForFile(filePath, title, snippet = '') {
  const haystack = normalizeMatchText(`${filePath} ${title} ${snippet}`);
  return allPenNames({ includeInactive: true }).find((pen) => haystack.includes(normalizeMatchText(pen.display_name)) || haystack.includes(normalizeMatchText(pen.key)));
}

function normalizeMatchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function inferBrainTags(filePath, title) {
  const text = normalizeMatchText(`${filePath} ${title}`);
  const tags = [];
  ['outline', 'draft', 'blurb', 'newsletter', 'launch', 'cover', 'ad', 'promo', 'bible', 'character', 'worldbuilding', 'notes'].forEach((tag) => {
    if (text.includes(tag)) tags.push(tag);
  });
  return tags;
}

function knowledgeBaseRoot() {
  const configured = String(loadSettings().KNOWLEDGE_BASE_ROOT || '').trim();
  return configured ? path.resolve(configured) : defaultKnowledgeBaseRoot();
}

function defaultKnowledgeBaseRoot() {
  return path.join(path.dirname(settingsPath()), 'knowledge-base');
}

function knowledgeBasePaths() {
  const root = knowledgeBaseRoot();
  return {
    root,
    raw: path.join(root, 'raw'),
    rawInputs: path.join(root, 'raw', 'inputs'),
    rawProcessed: path.join(root, 'raw', 'inputs', 'processed'),
    rawEcosystem: path.join(root, 'raw', 'ecosystem'),
    rawJournal: path.join(root, 'raw', 'journal'),
    rawCurated: path.join(root, 'raw', 'curated'),
    wiki: path.join(root, 'wiki'),
    candidates: path.join(root, '_candidates'),
    outputs: path.join(root, 'outputs')
  };
}

function setupKnowledgeBase({ logRun = true } = {}) {
  const paths = knowledgeBasePaths();
  const created = [];
  Object.values(paths).forEach((folder) => {
    if (!fs.existsSync(folder)) created.push(folder);
    fs.mkdirSync(folder, { recursive: true });
  });
  const rulesPath = path.join(paths.root, 'CLAUDE.md');
  if (!fs.existsSync(rulesPath)) {
    fs.writeFileSync(rulesPath, [
      '# Author HQ Knowledge Base Rules',
      '',
      '- raw/ contains original or machine-imported source material. Do not edit it by hand.',
      '- wiki/ contains AI-written indexes and reusable summaries.',
      '- _candidates/ contains proposed changes that need user review before being treated as canon.',
      '- outputs/ contains run logs and improvement reports.',
      '- Low-risk cleanup may be logged, but structural or canon changes need explicit approval.',
      '- Keep summaries grounded in the indexed files and Author HQ records.'
    ].join('\n'));
  }
  if (logRun) {
    logImprovementRun({
      runType: 'knowledge-base-setup',
      provider: 'local',
      summary: `Knowledge Base ready at ${paths.root}`,
      outputPath: rulesPath,
      rawOutput: `Created/verified folders:\n${Object.values(paths).join('\n')}`
    });
  }
  return { root: paths.root, created };
}

function moveKnowledgeBaseRoot(targetRoot, { cleanupMode = 'archive' } = {}) {
  const oldRoot = knowledgeBaseRoot();
  const requestedRoot = path.resolve(targetRoot);
  const parsedTarget = path.parse(requestedRoot);
  const newRoot = requestedRoot === parsedTarget.root ? path.join(requestedRoot, 'Author HQ Knowledge Base') : requestedRoot;
  const oldResolved = path.resolve(oldRoot);
  const newResolved = path.resolve(newRoot);
  if (oldResolved === newResolved) throw new Error('That is already the current knowledge-base folder.');
  if (newResolved.startsWith(`${oldResolved}${path.sep}`)) {
    throw new Error('Pick a folder outside the current knowledge-base folder.');
  }
  fs.mkdirSync(newRoot, { recursive: true });
  if (fs.existsSync(oldRoot)) {
    fs.cpSync(oldRoot, newRoot, { recursive: true, force: true });
  } else {
    fs.mkdirSync(newRoot, { recursive: true });
  }
  saveSettings({ KNOWLEDGE_BASE_ROOT: newRoot });
  setupKnowledgeBase({ logRun: false });
  const cleanupMessage = cleanupOldKnowledgeBase(oldRoot, newRoot, cleanupMode);
  logImprovementRun({
    runType: 'move-knowledge-base',
    provider: 'local',
    summary: `Knowledge Base moved to ${newRoot}`,
    outputPath: newRoot,
    rawOutput: `Old root: ${oldRoot}\nNew root: ${newRoot}\nCleanup: ${cleanupMessage}`
  });
  return { oldRoot, newRoot, cleanupMessage };
}

function cleanupOldKnowledgeBase(oldRoot, newRoot, cleanupMode) {
  if (!fs.existsSync(oldRoot)) return 'No old knowledge-base folder existed.';
  const oldResolved = path.resolve(oldRoot);
  const newResolved = path.resolve(newRoot);
  if (oldResolved === newResolved || newResolved.startsWith(`${oldResolved}${path.sep}`)) {
    return 'Old folder left in place because the new folder is inside it.';
  }
  if (cleanupMode === 'delete') {
    fs.rmSync(oldResolved, { recursive: true, force: true });
    return `Old folder deleted: ${oldResolved}`;
  }
  if (cleanupMode === 'keep') {
    return `Old folder kept in place: ${oldResolved}`;
  }
  const archivePath = `${oldResolved}-moved-${new Date().toISOString().slice(0, 10)}`;
  let candidate = archivePath;
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = `${archivePath}-${suffix}`;
    suffix += 1;
  }
  fs.renameSync(oldResolved, candidate);
  return `Old folder archived as: ${candidate}`;
}

async function syncKnowledgeBase() {
  const paths = knowledgeBasePaths();
  setupKnowledgeBase({ logRun: false });
  const scan = indexBrainRoots();
  const maintenance = runBrainMaintenance({ logRun: false });
  const docs = recentBrainDocuments(60);
  const notes = recentBrainNotes(25);
  const system = 'You maintain a concise author-business knowledge base. Summarize indexed writing files into a reusable wiki index. Stay practical and source-grounded.';
  const prompt = `Create a concise Author HQ wiki index from this local context.

Indexed document samples:
${docs.map((doc) => `- ${doc.title || doc.file_name} [${doc.root_label || 'root'}] ${doc.book_title ? `Book: ${doc.book_title}. ` : ''}${doc.pen_name ? `Pen: ${doc.pen_name}. ` : ''}${doc.snippet || doc.file_path}`).join('\n').slice(0, 12000)}

Brain notes:
${notes.map((note) => `- ${note.note_type}: ${note.title} - ${note.body}`).join('\n').slice(0, 5000)}

Return markdown with sections: Current Map, Useful Source Clusters, Gaps To Review, Suggested Next Sync.`;
  const result = await generateWithLlm({ system, prompt });
  const markdown = result.provider === 'claude'
    ? result.text
    : fallbackWikiIndex({ docs, notes, scan });
  const outputPath = path.join(paths.wiki, 'index.md');
  fs.writeFileSync(outputPath, `${markdown.trim()}\n`);
  const summary = `Indexed ${scan.indexed} files, refreshed wiki/index.md, and updated doc-index.md.`;
  logImprovementRun({
    runType: 'sync-writing-folders',
    provider: result.provider,
    summary,
    outputPath,
    rawOutput: `${markdown}\n\nMaintenance:\n${maintenance.summary}`
  });
  return { summary, outputPath, provider: result.provider };
}

function runBrainMaintenance({ logRun = true } = {}) {
  const paths = knowledgeBasePaths();
  setupKnowledgeBase({ logRun: false });
  const duplicatesRemoved = cleanupTimestampedDuplicateBrainDocs();
  const indexPath = writeBrainDocumentIndex(paths);
  const copyeditReportPath = writeCopyeditArchiveCandidateReport(paths);
  const summary = `Updated Brain document index, removed ${duplicatesRemoved} duplicate timestamped index rows, and refreshed copyedit archive candidates.`;
  if (logRun) {
    logImprovementRun({
      runType: 'brain-maintenance',
      provider: 'local',
      summary,
      outputPath: indexPath,
      rawOutput: `Index: ${indexPath}\nDuplicates removed: ${duplicatesRemoved}\nCopyedit report: ${copyeditReportPath}`
    });
  }
  return { summary, indexPath, duplicatesRemoved, copyeditReportPath };
}

function writeBrainDocumentIndex(paths) {
  const rows = sqlite.prepare(`
    SELECT d.*, r.label AS root_label, p.display_name AS pen_name, b.title AS book_title
    FROM brain_documents d
    LEFT JOIN brain_roots r ON r.id = d.root_id
    LEFT JOIN pen_names p ON p.id = d.pen_name_id
    LEFT JOIN books b ON b.id = d.book_id
    ORDER BY r.label, d.file_path
  `).all();
  const groups = new Map();
  rows.forEach((row) => {
    const key = brainDocumentCategory(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const markdown = [`# Brain Document Index`, '', `Generated ${new Date().toISOString()}.`, '', `Total indexed documents: ${rows.length}`, ''];
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([category, items]) => {
    markdown.push(`## ${category} (${items.length})`, '');
    items.slice(0, 80).forEach((row) => {
      const context = [row.book_title, row.pen_name, row.root_label].filter(Boolean).join(' / ');
      markdown.push(`- ${row.title || row.file_name}${context ? ` — ${context}` : ''}`);
      markdown.push(`  - ${row.file_path}`);
    });
    if (items.length > 80) markdown.push(`- ... ${items.length - 80} more`);
    markdown.push('');
  });
  const outputPath = path.join(paths.wiki, 'doc-index.md');
  fs.writeFileSync(outputPath, `${markdown.join('\n').trim()}\n`);
  return outputPath;
}

function brainDocumentCategory(row) {
  const text = normalizeMatchText(`${row.file_path} ${row.title} ${row.tags}`);
  if (text.includes('chapter')) return 'Chapters';
  if (text.includes('journal')) return 'Journal';
  if (text.includes('log')) return 'Logs';
  if (text.includes('metadata') || text.includes('meta')) return 'Metadata';
  if (text.includes('copyedit') || text.includes('proof')) return 'Editing / Proofing';
  if (text.includes('launch')) return 'Launch';
  if (text.includes('newsletter')) return 'Newsletter';
  if (text.includes('outline')) return 'Outlines';
  if (text.includes('bible') || text.includes('character') || text.includes('worldbuilding')) return 'Story Bible';
  return row.root_label || 'Uncategorized';
}

function cleanupTimestampedDuplicateBrainDocs() {
  const rows = sqlite.prepare('SELECT id, file_name, file_path, modified_at, indexed_at FROM brain_documents ORDER BY id').all();
  const groups = new Map();
  rows.forEach((row) => {
    const canonical = canonicalBrainFileName(row.file_name);
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical).push(row);
  });
  const idsToDelete = [];
  groups.forEach((items) => {
    if (items.length < 2) return;
    const stable = items.find((item) => !timestampedBrainFileName(item.file_name));
    items.forEach((item) => {
      if (stable && item.id !== stable.id && timestampedBrainFileName(item.file_name)) idsToDelete.push(item.id);
    });
  });
  const deleteStmt = sqlite.prepare('DELETE FROM brain_documents WHERE id = ?');
  const tx = sqlite.transaction((ids) => ids.forEach((id) => deleteStmt.run(id)));
  tx(idsToDelete);
  return idsToDelete.length;
}

function canonicalBrainFileName(fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext)
    .replace(/[\s_-]*\d{8}[\s_-]*\d{4,6}$/g, '')
    .replace(/[\s_-]*\d{8}$/g, '')
    .trim();
  return `${normalizeMatchText(base)}${ext.toLowerCase()}`;
}

function timestampedBrainFileName(fileName) {
  return /(?:\s|_|-)\d{8}(?:\s|_|-)?\d{4,6}(?=\.[^.]+$)/.test(fileName) || /(?:\s|_|-)\d{8}(?=\.[^.]+$)/.test(fileName);
}

function writeCopyeditArchiveCandidateReport(paths) {
  const rows = sqlite.prepare(`
    SELECT d.*, r.label AS root_label
    FROM brain_documents d
    LEFT JOIN brain_roots r ON r.id = d.root_id
    WHERE lower(d.file_path || ' ' || COALESCE(d.title, '') || ' ' || COALESCE(d.snippet, '')) LIKE '%copyedit%'
      AND lower(d.file_path || ' ' || COALESCE(d.title, '') || ' ' || COALESCE(d.snippet, '')) LIKE '%complete%'
    ORDER BY d.modified_at DESC
    LIMIT 200
  `).all();
  const outputPath = path.join(paths.candidates, 'copyedit-archive-candidates.md');
  const markdown = [`# Copyedit Archive Candidates`, '', 'These are candidates only. Author HQ did not move or delete the source files.', ''];
  if (!rows.length) {
    markdown.push('No completed copyedit-state candidates found.');
  } else {
    rows.forEach((row) => {
      markdown.push(`- ${row.title || row.file_name}`);
      markdown.push(`  - ${row.file_path}`);
      if (row.snippet) markdown.push(`  - ${row.snippet.slice(0, 220)}`);
    });
  }
  fs.writeFileSync(outputPath, `${markdown.join('\n').trim()}\n`);
  return outputPath;
}

async function suggestAuthorHqImprovements() {
  const paths = knowledgeBasePaths();
  setupKnowledgeBase({ logRun: false });
  const counts = databaseCounts();
  const docs = recentBrainDocuments(40);
  const notes = recentBrainNotes(25);
  const runs = recentImprovementRuns(5);
  const system = 'You are Author HQ improvement analyst. Produce reviewable, low-drama operational improvements. Do not invent user preferences. Do not suggest Gmail/Drive ingestion. Prefer concrete Author HQ UI/data actions over abstract questions.';
  const prompt = `Review Author HQ context and propose improvements.

Counts:
${counts.map((row) => `- ${row.label}: ${row.count}`).join('\n')}

Recent Brain docs:
${docs.map((doc) => `- ${doc.title || doc.file_name}: ${doc.snippet || doc.file_path}`).join('\n').slice(0, 9000)}

Recent Brain notes:
${notes.map((note) => `- ${note.note_type}: ${note.title} - ${note.body}`).join('\n').slice(0, 5000)}

Recent improvement runs:
${runs.map((run) => `- ${run.run_type}: ${run.summary}`).join('\n') || 'None'}

Return markdown with these headings:
## Auto-Approve
Low-risk cleanup only.
## Needs Sign-Off
Feature changes, data model changes, workflow changes.
## More Context Required
Questions for the user.

Each item should be a checkbox line with a short reason. Phrase each item as an implementable action or a direct decision the user can answer in one paragraph.`;
  const result = await generateWithLlm({ system, prompt });
  const markdown = result.provider === 'claude'
    ? result.text
    : fallbackImprovementReview({ counts, docs, notes });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(paths.candidates, `review-${stamp}.md`);
  fs.writeFileSync(outputPath, `${markdown.trim()}\n`);
  const runId = logImprovementRun({
    runType: 'improve-system',
    provider: result.provider,
    summary: 'Improvement review generated for user sign-off.',
    outputPath,
    rawOutput: markdown
  });
  saveImprovementItems(runId, markdown);
  return { summary: 'Improvement review generated for user sign-off.', outputPath, provider: result.provider };
}

function fallbackWikiIndex({ docs, notes, scan }) {
  return `# Author HQ Wiki Index

## Current Map
- Indexed ${scan.indexed} files from active writing folders.
- Skipped ${scan.skipped} files or folders.

## Useful Source Clusters
${docs.slice(0, 20).map((doc) => `- ${doc.title || doc.file_name}: ${doc.book_title || doc.pen_name || doc.root_label || 'Unsorted'}`).join('\n') || '- No indexed documents yet.'}

## Gaps To Review
${notes.length ? '- Review recent Brain notes and promote anything canon-critical.' : '- Add Brain notes for stable decisions, canon facts, and repeat workflows.'}

## Suggested Next Sync
- Run Suggest Improvements after a few more folder scans.
`;
}

function fallbackImprovementReview({ counts, docs, notes }) {
  return `## Auto-Approve
- [ ] Keep scanning active writing folders before improvement reviews. Reason: current index has ${docs.length} recent document samples.

## Needs Sign-Off
- [ ] Decide which repeated workflows deserve first-class Author HQ buttons. Reason: this should follow your actual habits, not guesses.

## More Context Required
- [ ] Which Brain notes are canon versus temporary working notes? Reason: ${notes.length} recent notes exist and may need promotion rules.

## Context Snapshot
${counts.map((row) => `- ${row.label}: ${row.count}`).join('\n')}
`;
}

function logImprovementRun({ runType, provider, summary, rawOutput = '', outputPath = '', status = 'Complete' }) {
  const info = sqlite.prepare(`
    INSERT INTO hq_improvement_runs (run_type, status, provider, summary, raw_output, output_path)
    VALUES (@runType, @status, @provider, @summary, @rawOutput, @outputPath)
  `).run({ runType, status, provider, summary, rawOutput, outputPath });
  return info.lastInsertRowid;
}

function saveImprovementItems(runId, markdown) {
  const insert = sqlite.prepare(`
    INSERT INTO hq_improvement_items (run_id, bucket, title, body, status)
    VALUES (@runId, @bucket, @title, @body, 'Proposed')
  `);
  let bucket = 'Needs Review';
  String(markdown || '').split(/\r?\n/).forEach((line) => {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      bucket = heading[1].trim();
      return;
    }
    const item = line.match(/^[-*]\s+\[[ xX-]?\]\s+(.+)/);
    if (!item) return;
    const [title, ...rest] = item[1].split(/\s+Reason:\s+/i);
    insert.run({ runId, bucket, title: title.trim().slice(0, 180), body: rest.join(' Reason: ').trim() });
  });
}

async function saveWeeklySummary(body) {
  const paths = knowledgeBasePaths();
  setupKnowledgeBase({ logRun: false });
  const weekEnding = normalizeDate(body.weekEnding || todayIso()) || todayIso();
  const weekStart = addDaysIso(weekEnding, -6);
  const rawText = String(body.summary || '').trim();
  const includeJournal = body.includeJournal === 'on' || body.includeJournal === '1';
  const journal = includeJournal ? journalEntries({ startDate: weekStart, endDate: weekEnding, limit: 100 }) : [];
  const journalContext = journal.map((entry) => `### ${entry.entry_date} - ${entry.title}
Mood: ${entry.mood || 'n/a'} | Energy: ${entry.energy || 'n/a'}
${entry.body}`).join('\n\n');
  const fallbackText = [rawText, journalContext].filter(Boolean).join('\n\n');
  if (!rawText && !journal.length) throw new Error('Add a few notes or include journal entries before saving the week.');
  const system = 'You distill weekly author-business notes into a practical knowledge-base entry. Keep it grounded, concise, and useful for future planning.';
  const prompt = `Week ending: ${weekEnding}
Week range: ${weekStart} through ${weekEnding}

Raw weekly notes:
${rawText || 'None entered.'}

Journal entries from this week:
${journalContext || 'None included.'}

Return markdown with headings: Wins, Work Completed, Open Loops, Decisions/Patterns To Remember, Next Week.`;
  let provider = 'local';
  let distilled = '';
  try {
    const result = await generateWithLlm({ system, prompt });
    provider = result.provider;
    distilled = result.provider === 'claude' ? result.text : fallbackWeeklySummary({ weekEnding, rawText: fallbackText });
  } catch (error) {
    distilled = fallbackWeeklySummary({ weekEnding, rawText: fallbackText, warning: error.message });
  }
  const outputPath = path.join(paths.rawEcosystem, `week-ending-${weekEnding}.md`);
  const markdown = `# Week Ending ${weekEnding}

## Raw Notes
${rawText || 'None entered.'}

## Journal Entries Included
${journalContext || 'None included.'}

## Distilled Summary
${distilled.trim()}
`;
  fs.writeFileSync(outputPath, markdown);
  sqlite.prepare(`
    INSERT INTO brain_notes (note_type, title, body, source_path, status, important)
    VALUES ('Process', @title, @body, @sourcePath, 'Active', 0)
  `).run({
    title: `Weekly summary - ${weekEnding}`,
    body: distilled.trim().slice(0, 5000),
    sourcePath: outputPath
  });
  logImprovementRun({
    runType: 'weekly-summary',
    provider,
    summary: `Weekly summary saved for ${weekEnding}.`,
    outputPath,
    rawOutput: markdown
  });
  return { outputPath, provider };
}

function fallbackWeeklySummary({ weekEnding, rawText, warning = '' }) {
  return `## Wins
- Notes captured for week ending ${weekEnding}.

## Work Completed
${rawText.split(/\r?\n/).filter(Boolean).map((line) => `- ${line.trim()}`).join('\n')}

## Open Loops
- Review these notes during the next planning pass.

## Decisions/Patterns To Remember
- Weekly summary was saved locally.${warning ? `\n- Claude summary was unavailable: ${warning}` : ''}

## Next Week
- Pick one or two items from the open loops and add calendar events if needed.`;
}

function nextCalendarEvents(limit = 5) {
  return combinedCalendarEvents(180).slice(0, limit);
}

async function syncCalendarToGoogle(baseUrlValue) {
  const events = combinedCalendarEvents(365).filter((event) => event.event_date && event.local_key);
  const result = { synced: 0, failed: 0, errors: [] };
  for (const event of events) {
    const syncRow = sqlite.prepare('SELECT * FROM google_calendar_sync WHERE local_key = ?').get(event.local_key);
    try {
      const synced = await upsertGoogleCalendarEvent(event, syncRow, baseUrlValue);
      upsertGoogleSyncRow(event.local_key, synced.id, 'synced', '');
      result.synced += 1;
    } catch (error) {
      sqlite.prepare(`
        INSERT INTO google_calendar_sync (local_key, sync_status, last_error)
        VALUES (@localKey, 'failed', @lastError)
        ON CONFLICT(local_key) DO UPDATE SET sync_status='failed', last_error=@lastError, updated_at=CURRENT_TIMESTAMP
      `).run({ localKey: event.local_key, lastError: error.message });
      result.failed += 1;
      result.errors.push(`${event.title}: ${error.message}`);
    }
  }
  return result;
}

function upsertGoogleSyncRow(localKey, googleEventId, status, lastError) {
  sqlite.prepare(`
    INSERT INTO google_calendar_sync (local_key, google_event_id, synced_at, sync_status, last_error)
    VALUES (@localKey, @googleEventId, CURRENT_TIMESTAMP, @status, @lastError)
    ON CONFLICT(local_key) DO UPDATE SET
      google_event_id=COALESCE(@googleEventId, google_event_id),
      synced_at=CURRENT_TIMESTAMP,
      sync_status=@status,
      last_error=@lastError,
      updated_at=CURRENT_TIMESTAMP
  `).run({ localKey, googleEventId: googleEventId || null, status, lastError: lastError || '' });
}

function moveCalendarEventByKey(localKey, eventDate) {
  if (localKey.startsWith('manual:')) {
    const id = localKey.replace('manual:', '');
    const event = sqlite.prepare("SELECT * FROM calendar_events WHERE id = ? AND source IN ('manual', 'google')").get(id);
    if (!event) throw new Error('Only manual or Google-imported events can be moved this way.');
    sqlite.prepare('UPDATE calendar_events SET event_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eventDate, id);
    return;
  }
  if (localKey.startsWith('book:')) {
    const [, bookId, field] = localKey.split(':');
    const allowedFields = new Set(['planned_release', 'actual_release', 'draft_complete', 'editing_complete', 'cover_ready', 'formatted', 'uploaded_kdp', 'preorder_live', 'published_live']);
    if (!allowedFields.has(field)) throw new Error('That book calendar item cannot be moved.');
    const book = sqlite.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
    if (!book) throw new Error('Book not found.');
    sqlite.prepare(`UPDATE books SET ${field} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(eventDate, bookId);
    return;
  }
  if (localKey.startsWith('goal:')) {
    const goalId = localKey.replace('goal:', '');
    const goal = sqlite.prepare('SELECT id FROM goals WHERE id = ?').get(goalId);
    if (!goal) throw new Error('Goal not found.');
    sqlite.prepare('UPDATE goals SET target_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eventDate, goalId);
    return;
  }
  throw new Error('That calendar item cannot be moved yet.');
}

function deleteCalendarEventByKey(localKey) {
  if (localKey.startsWith('manual:')) {
    const id = localKey.replace('manual:', '');
    sqlite.prepare('DELETE FROM google_calendar_sync WHERE local_key = ?').run(localKey);
    const result = sqlite.prepare("DELETE FROM calendar_events WHERE id = ? AND source IN ('manual', 'google')").run(id);
    if (!result.changes) throw new Error('Event not found.');
    return;
  }
  if (localKey.startsWith('book:')) {
    const [, bookId, field] = localKey.split(':');
    const allowedFields = new Set(['planned_release', 'actual_release', 'draft_complete', 'editing_complete', 'cover_ready', 'formatted', 'uploaded_kdp', 'preorder_live', 'published_live']);
    if (!allowedFields.has(field)) throw new Error('That book calendar item cannot be removed.');
    const result = sqlite.prepare(`UPDATE books SET ${field} = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(bookId);
    if (!result.changes) throw new Error('Book not found.');
    return;
  }
  if (localKey.startsWith('goal:')) {
    const goalId = localKey.replace('goal:', '');
    const result = sqlite.prepare("UPDATE goals SET target_date = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(goalId);
    if (!result.changes) throw new Error('Goal not found.');
    return;
  }
  throw new Error('That calendar item cannot be removed yet.');
}

async function syncCalendarFromGoogle(baseUrlValue) {
  const start = addDaysIso(todayIso(), -45);
  const end = addDaysIso(todayIso(), 365);
  const result = { imported: 0, updated: 0, failed: 0, errors: [] };
  const googleEvents = await listGoogleCalendarEvents({
    baseUrl: baseUrlValue,
    timeMin: `${start}T00:00:00Z`,
    timeMax: `${end}T23:59:59Z`
  });
  for (const googleEvent of googleEvents) {
    if (googleEvent.status === 'cancelled') continue;
    try {
      const payload = googleEventToCalendarPayload(googleEvent);
      if (!payload.eventDate) continue;
      const syncRow = sqlite.prepare('SELECT * FROM google_calendar_sync WHERE google_event_id = ?').get(googleEvent.id);
      const existing = syncRow?.local_key?.startsWith('manual:')
        ? sqlite.prepare('SELECT * FROM calendar_events WHERE id = ?').get(syncRow.local_key.replace('manual:', ''))
        : sqlite.prepare('SELECT * FROM calendar_events WHERE external_source = ? AND external_id = ?').get('google', googleEvent.id);
      if (existing) {
        sqlite.prepare(`
          UPDATE calendar_events SET
            title=@title,
            event_date=@eventDate,
            event_time=@eventTime,
            event_type=@eventType,
            status=@status,
            source=CASE WHEN source = 'manual' THEN source ELSE 'google' END,
            external_source='google',
            external_id=@externalId,
            external_updated=@externalUpdated,
            notes=@notes,
            updated_at=CURRENT_TIMESTAMP
          WHERE id=@id
        `).run({ ...payload, id: existing.id });
        upsertGoogleSyncRow(`manual:${existing.id}`, googleEvent.id, 'imported', '');
        result.updated += 1;
      } else {
        const insert = sqlite.prepare(`
          INSERT INTO calendar_events (title, event_date, event_time, event_type, status, source, external_source, external_id, external_updated, notes)
          VALUES (@title, @eventDate, @eventTime, @eventType, @status, 'google', 'google', @externalId, @externalUpdated, @notes)
        `).run(payload);
        upsertGoogleSyncRow(`manual:${insert.lastInsertRowid}`, googleEvent.id, 'imported', '');
        result.imported += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.errors.push(`${googleEvent.summary || googleEvent.id}: ${error.message}`);
    }
  }
  return result;
}

function googleEventToCalendarPayload(event) {
  const start = event.start?.dateTime || event.start?.date || '';
  const eventDate = String(start).slice(0, 10);
  const eventTime = event.start?.dateTime ? String(event.start.dateTime).slice(11, 16) : '';
  const title = String(event.summary || 'Google Calendar Event').trim();
  const notes = [
    cleanGoogleDescription(event.description),
    event.htmlLink ? `Google: ${event.htmlLink}` : ''
  ].filter(Boolean).join('\n\n');
  return {
    title,
    eventDate,
    eventTime,
    eventType: inferGoogleEventType(title, event.description),
    status: 'Planned',
    externalId: event.id,
    externalUpdated: event.updated || '',
    notes
  };
}

function cleanGoogleDescription(value) {
  return String(value || '')
    .replace(/Author HQ source:[\s\S]*$/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferGoogleEventType(...values) {
  const text = values.filter(Boolean).join(' ').toLowerCase();
  if (text.includes('co-teach') || text.includes('coteach') || text.includes('teaching')) return 'Co-teaching';
  if (text.includes('newsletter')) return 'Newsletter';
  if (text.includes('launch') || text.includes('preorder') || text.includes('pre-order')) return 'Launch';
  if (text.includes('release') || text.includes('published')) return 'Release';
  if (text.includes('promo') || text.includes('sale')) return 'Promo';
  if (text.includes('draft') || text.includes('writing')) return 'Drafting';
  return 'General';
}

function combinedCalendarEvents(daysAhead = 365) {
  const today = todayIso();
  const until = addDaysIso(today, daysAhead);
  return combinedCalendarEventsRange(today, until);
}

function combinedCalendarEventsRange(startDate, endDate) {
  const manual = sqlite.prepare(`
    SELECT e.*, p.display_name AS pen_name, b.title AS book_title
    FROM calendar_events e
    LEFT JOIN pen_names p ON p.id = e.pen_name_id
    LEFT JOIN books b ON b.id = e.book_id
    WHERE e.event_date >= ? AND e.event_date <= ?
  `).all(startDate, endDate).map((event) => ({ ...event, local_key: `manual:${event.id}` }));
  const bookEvents = sqlite.prepare(`
    SELECT b.id AS book_id, b.title AS book_title, b.title, p.display_name AS pen_name, b.pen_name_id,
      b.planned_release, b.actual_release, b.draft_complete, b.editing_complete, b.cover_ready, b.formatted, b.uploaded_kdp, b.preorder_live, b.published_live
    FROM books b
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
  `).all().flatMap(bookCalendarEvents).filter((event) => event.event_date >= startDate && event.event_date <= endDate);
  const goals = sqlite.prepare(`
    SELECT g.id AS goal_id, g.target_date AS event_date, g.title, g.pen_name_id, p.display_name AS pen_name
    FROM goals g LEFT JOIN pen_names p ON p.id = g.pen_name_id
    WHERE g.target_date IS NOT NULL AND g.target_date != '' AND g.target_date >= ? AND g.target_date <= ?
      AND lower(g.status) NOT IN ('complete', 'completed', 'done', 'archived')
  `).all(startDate, endDate).map((goal) => ({ ...goal, event_type: 'Goal', source: 'goal', status: 'Planned', local_key: `goal:${goal.goal_id}` }));
  return [...manual, ...bookEvents, ...goals].sort((a, b) => `${a.event_date} ${a.event_time || ''}`.localeCompare(`${b.event_date} ${b.event_time || ''}`));
}

function calendarEventsBetween(startDate, endDate) {
  return combinedCalendarEventsRange(startDate, endDate);
}

function bookCalendarEvents(book) {
  const specs = [
    ['planned_release', 'Release', 'Planned release'],
    ['actual_release', 'Release', 'Actual release'],
    ['draft_complete', 'Production', 'Draft complete'],
    ['editing_complete', 'Production', 'Editing complete'],
    ['cover_ready', 'Production', 'Cover ready'],
    ['formatted', 'Production', 'Formatted'],
    ['uploaded_kdp', 'Launch', 'Uploaded to KDP'],
    ['preorder_live', 'Launch', 'Pre-order live'],
    ['published_live', 'Release', 'Published live']
  ];
  return specs
    .filter(([field]) => book[field])
    .filter(([field]) => !(field === 'planned_release' && book.actual_release && String(book.actual_release).slice(0, 10) === String(book.planned_release).slice(0, 10)))
    .filter(([field]) => !(field === 'actual_release' && book.published_live && String(book.published_live).slice(0, 10) === String(book.actual_release).slice(0, 10)))
    .map(([field, type, label]) => ({
      title: `${label}: ${book.book_title}`,
      event_date: String(book[field]).slice(0, 10),
      event_time: '',
      event_type: type,
      pen_name_id: book.pen_name_id,
      pen_name: book.pen_name,
      book_id: book.book_id,
      book_title: book.book_title,
      status: 'Planned',
      source: 'book',
      local_key: `book:${book.book_id}:${field}`
    }));
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateToIso(date);
}

function mostRecentSaturdayIso(iso = todayIso()) {
  const date = new Date(`${iso}T00:00:00`);
  const daysSinceSaturday = (date.getDay() + 1) % 7;
  date.setDate(date.getDate() - daysSinceSaturday);
  return dateToIso(date);
}

function parseMonthValue(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  if (!match) return new Date(`${todayIso()}T00:00:00`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = new Date(year, month, 1);
  return Number.isNaN(date.getTime()) ? new Date(`${todayIso()}T00:00:00`) : date;
}

function dateToIso(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateToMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function liveBooksRows(limit = 100) {
  return sqlite.prepare(`
    SELECT b.*, p.display_name AS pen_name
    FROM books b
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
    WHERE lower(trim(COALESCE(b.status, ''))) IN ('published', 'published live', 'live')
       OR COALESCE(b.published_live, '') != ''
    ORDER BY COALESCE(b.actual_release, b.published_live, b.updated_at) DESC
    LIMIT ?
  `).all(limit);
}

function royaltyTotalsRow() {
  return sqlite.prepare(`
    SELECT
      COUNT(*) AS rows,
      COUNT(DISTINCT substr(report_date, 1, 7)) AS periods,
      COALESCE(SUM(units), 0) AS units,
      COALESCE(SUM(free_units), 0) AS free_units,
      COALESCE(SUM(kenp_read), 0) AS kenp_read,
      COALESCE(SUM(royalty), 0) AS total_royalty
    FROM royalty_entries
  `).get();
}

function royaltySummaryRows(limit = 100) {
  return sqlite.prepare(`
    SELECT
      COALESCE(b.title, r.title) AS title,
      p.display_name AS pen_name,
      COALESCE(SUM(r.units), 0) AS units,
      COALESCE(SUM(r.free_units), 0) AS free_units,
      COALESCE(SUM(r.kenp_read), 0) AS kenp_read,
      COALESCE(SUM(r.royalty), 0) AS royalty,
      MAX(r.report_date) AS last_seen
    FROM royalty_entries r
    LEFT JOIN books b ON b.id = r.book_id
    LEFT JOIN pen_names p ON p.id = COALESCE(r.pen_name_id, b.pen_name_id)
    GROUP BY COALESCE(r.book_id, lower(r.title)), COALESCE(b.title, r.title), p.display_name
    ORDER BY royalty DESC, units DESC
    LIMIT ?
  `).all(limit);
}

function royaltyTrendRows(limit = 18) {
  return sqlite.prepare(`
    SELECT
      substr(report_date, 1, 7) AS month,
      COALESCE(SUM(units), 0) AS units,
      COALESCE(SUM(free_units), 0) AS free_units,
      COALESCE(SUM(kenp_read), 0) AS kenp_read,
      COALESCE(SUM(royalty), 0) AS royalty
    FROM royalty_entries
    GROUP BY substr(report_date, 1, 7)
    ORDER BY month DESC
    LIMIT ?
  `).all(limit);
}

function decorateGoals(rows) {
  const breakEven = monthlyBreakEvenSnapshot();
  const publishedWords = publishedWordsSnapshot();
  return rows.map((row) => {
    if (isBreakEvenGoal(row)) {
      const progress = breakEven.outgoing > 0 ? Math.min(100, Math.round((breakEven.royalties / breakEven.outgoing) * 100)) : (breakEven.royalties > 0 ? 100 : 0);
      const autoNote = `Auto for ${breakEven.month}: ${money(breakEven.royalties)} royalties vs ${money(breakEven.outgoing)} outgoing (${money(breakEven.remaining)} remaining).`;
      return { ...row, progress, progress_display: `${progress}%`, auto_note: autoNote, auto_label: 'Auto break-even' };
    }
    if (isPublishedWordsGoal(row)) {
      const autoNote = `${publishedWords.total.toLocaleString()} of 1,000,000 published words across ${publishedWords.bookCount} books (${publishedWords.remaining.toLocaleString()} remaining).`;
      return { ...row, progress: Math.round(publishedWords.percent), progress_display: `${publishedWords.percent.toFixed(1)}%`, auto_note: autoNote, auto_label: 'Auto published words' };
    }
    return row;
  });
}

function isBreakEvenGoal(goal) {
  const text = `${goal.title || ''} ${goal.category || ''}`.toLowerCase();
  return text.includes('break even') || text.includes('break-even') || text.includes('breakeven');
}

function isPublishedWordsGoal(goal) {
  const text = `${goal.title || ''} ${goal.category || ''}`.toLowerCase();
  return text.includes('published words') || (text.includes('million') && text.includes('words') && text.includes('published'));
}

function publishedWordsSnapshot() {
  const row = sqlite.prepare(`
    SELECT COALESCE(SUM(word_count), 0) AS total, COUNT(*) AS book_count
    FROM books
    WHERE lower(trim(COALESCE(status, ''))) IN ('published', 'published live', 'live')
       OR COALESCE(published_live, '') != ''
  `).get();
  const total = Math.max(0, Number(row.total || 0));
  const target = 1000000;
  return {
    total,
    target,
    bookCount: Number(row.book_count || 0),
    remaining: Math.max(0, target - total),
    percent: Math.min(100, (total / target) * 100)
  };
}

function monthlyBreakEvenSnapshot(month = todayIso().slice(0, 7)) {
  const royalties = Number(sqlite.prepare(`
    SELECT COALESCE(SUM(royalty), 0) AS total FROM royalty_entries
    WHERE substr(report_date, 1, 7) = ?
  `).get(month).total || 0);
  const expenses = Number(sqlite.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
    WHERE substr(date, 1, 7) = ?
  `).get(month).total || 0);
  const adSpend = Number(sqlite.prepare(`
    SELECT COALESCE(SUM(spend), 0) AS total FROM ad_entries
    WHERE substr(COALESCE(NULLIF(date_start, ''), NULLIF(date_end, ''), created_at), 1, 7) = ?
  `).get(month).total || 0);
  const subscriptionSetAside = sqlite.prepare('SELECT * FROM subscriptions WHERE active = 1').all()
    .reduce((sum, sub) => sum + billingMonthlyEquivalent(sub.monthly_cost, sub.billing_cycle), 0);
  const outgoing = expenses + adSpend + subscriptionSetAside;
  return {
    month,
    royalties,
    expenses,
    adSpend,
    subscriptionSetAside,
    outgoing,
    remaining: Math.max(0, outgoing - royalties)
  };
}

function royaltyRecentRows(limit = 80) {
  return sqlite.prepare(`
    SELECT r.*, COALESCE(b.title, r.title) AS title
    FROM royalty_entries r
    LEFT JOIN books b ON b.id = r.book_id
    ORDER BY r.report_date DESC, r.id DESC
    LIMIT ?
  `).all(limit);
}

function kdpGenreConfigForPen(penNameId) {
  if (!penNameId) return null;
  return sqlite.prepare('SELECT * FROM kdp_genre_configs WHERE pen_name_id = ?').get(penNameId);
}

function allKdpListings() {
  return sqlite.prepare(`
    SELECT l.*, p.display_name AS pen_name
    FROM kdp_listings l
    LEFT JOIN pen_names p ON p.id = l.pen_name_id
    ORDER BY l.updated_at DESC
  `).all();
}

function allManuscriptAnalyses() {
  return sqlite.prepare(`
    SELECT a.*, b.title AS book_title, p.display_name AS pen_name
    FROM kdp_manuscript_analyses a
    JOIN books b ON b.id = a.book_id
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
    ORDER BY a.updated_at DESC, a.id DESC
  `).all();
}

function manuscriptAnalysisById(id) {
  return sqlite.prepare(`
    SELECT a.*, b.title AS book_title, b.pen_name_id, p.display_name AS pen_name
    FROM kdp_manuscript_analyses a
    JOIN books b ON b.id = a.book_id
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
    WHERE a.id = ?
  `).get(id);
}

function latestManuscriptAnalysis(bookId) {
  if (!bookId) return null;
  return sqlite.prepare(`
    SELECT * FROM kdp_manuscript_analyses
    WHERE book_id = ? AND lower(status) IN ('complete', 'reviewed')
    ORDER BY CASE lower(status) WHEN 'reviewed' THEN 0 ELSE 1 END, updated_at DESC, id DESC
    LIMIT 1
  `).get(bookId);
}

function queueManuscriptAnalysis({ req, res, sourceName, sourceType, sourceHash, extract }) {
  if (!getSetting('ANTHROPIC_API_KEY')) throw new Error('Add your Claude API key in Settings before analyzing a manuscript.');
  const book = bookById(req.body.bookId);
  if (!book) throw new Error('Choose an existing book before analyzing its manuscript.');
  const existing = sqlite.prepare('SELECT * FROM kdp_manuscript_analyses WHERE book_id = ? AND source_hash = ?').get(book.id, sourceHash);
  if (existing) {
    if (req.body.force || existing.status === 'Error') {
      sqlite.prepare("UPDATE kdp_manuscript_analyses SET status='Processing', error_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(existing.id);
      res.redirect(`/kdp-manuscripts/${existing.id}`);
      setImmediate(() => runManuscriptAnalysisJob({ analysisId: existing.id, book, extract }).catch((error) => {
        sqlite.prepare("UPDATE kdp_manuscript_analyses SET status='Error', error_message=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(error.message || String(error), existing.id);
      }));
      return;
    }
    res.redirect(`/kdp-manuscripts/${existing.id}`);
    return;
  }
  const info = sqlite.prepare(`
    INSERT INTO kdp_manuscript_analyses (book_id, source_name, source_type, source_hash, status)
    VALUES (?, ?, ?, ?, 'Processing')
  `).run(book.id, sourceName, sourceType, sourceHash);
  const analysisId = Number(info.lastInsertRowid);
  res.redirect(`/kdp-manuscripts/${analysisId}`);
  setImmediate(() => runManuscriptAnalysisJob({ analysisId, book, extract }).catch((error) => {
    sqlite.prepare(`
      UPDATE kdp_manuscript_analyses SET status='Error', error_message=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(error.message || String(error), analysisId);
  }));
}

async function runManuscriptAnalysisJob({ analysisId, book, extract }) {
  const extracted = await extract();
  sqlite.prepare(`
    UPDATE kdp_manuscript_analyses SET word_count=@wordCount, chapter_count=@chapterCount,
      extraction_warnings=@warnings, updated_at=CURRENT_TIMESTAMP WHERE id=@id
  `).run({
    id: analysisId,
    wordCount: extracted.wordCount,
    chapterCount: extracted.chapterCount || 1,
    warnings: JSON.stringify(extracted.warnings || [])
  });
  sqlite.prepare(`
    UPDATE books SET word_count=CASE WHEN COALESCE(word_count, 0)=0 THEN ? ELSE word_count END, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(extracted.wordCount, book.id);
  const penName = penNameById(book.pen_name_id, { includeInactive: true });
  const genreConfig = kdpGenreConfigForPen(penName?.id);
  const result = await analyzeManuscript({
    text: extracted.text,
    book,
    penName,
    genreConfig,
    sourceName: manuscriptAnalysisById(analysisId)?.source_name
  });
  const brief = {
    ...result.brief,
    analysis_meta: {
      chunks_analyzed: result.chunksAnalyzed,
      coverage: result.coverage,
      extracted_word_count: extracted.wordCount,
      chapter_count: extracted.chapterCount || 1
    }
  };
  sqlite.prepare(`
    UPDATE kdp_manuscript_analyses SET analysis_json=@analysisJson, status='Complete', provider=@provider,
      error_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=@id
  `).run({ id: analysisId, analysisJson: JSON.stringify(brief, null, 2), provider: result.provider });
}

function kdpListingById(id) {
  return sqlite.prepare(`
    SELECT l.*, p.display_name AS pen_name, b.title AS book_title
    FROM kdp_listings l
    LEFT JOIN pen_names p ON p.id = l.pen_name_id
    LEFT JOIN books b ON b.id = l.book_id
    WHERE l.id = ?
  `).get(id);
}

function searchKindleCategories(query, limit = 20) {
  const terms = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const where = terms.map(() => 'lower(path) LIKE ?').join(' AND ');
  return sqlite.prepare(`
    SELECT * FROM kindle_categories
    WHERE ${where}
    ORDER BY CASE overall_rating
      WHEN 'Easy' THEN 1
      WHEN 'Moderate' THEN 2
      WHEN 'Competitive' THEN 3
      WHEN 'Fortress' THEN 4
      ELSE 5
    END, path
    LIMIT ?
  `).all(...terms.map((term) => `%${term.toLowerCase()}%`), Math.max(limit * 5, 50))
    .filter(isAdultKdpCategory)
    .slice(0, limit);
}

function categoryRowsForKdpConfig(config, manual = '') {
  const configCategories = parseJson(config?.verified_categories, []);
  const searches = [
    ...String(manual || '').split('\n'),
    ...configCategories.map((category) => category.path)
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const rows = [];
  const seen = new Set();
  searches.forEach((search) => {
    searchKindleCategories(search.replaceAll('>', ' '), 8).forEach((row) => {
      if (!isAdultKdpCategory(row)) return;
      if (seen.has(row.path)) return;
      seen.add(row.path);
      rows.push(row);
    });
  });
  return rows;
}

function kdpListingFieldsFromBody(body, book, genreConfig) {
  const title = String(body.title || book?.title || '').trim();
  if (!title) throw new Error('A title is required.');
  return {
    format: String(body.format || 'ebook'),
    title,
    subtitle: String(body.subtitle || '').trim(),
    seriesName: String(body.seriesName || book?.series || '').trim(),
    seriesNumber: String(body.seriesNumber || '').trim(),
    blurbDraft: String(body.blurbDraft || book?.blurb || '').trim(),
    compTitles: String(body.compTitles || '').trim(),
    targetCategories: String(body.targetCategories || '').trim(),
    priceUsd: parseMoney(body.priceUsd || genreConfig?.default_price_usd || 4.99),
    kuEnrolled: String(body.kuEnrolled || '') === '1' ? 1 : 0,
    aiGenerated: String(body.aiGenerated || '') === '1' ? 1 : 0,
    aiAssisted: String(body.aiAssisted || '') === '1' ? 1 : 0,
    language: String(body.language || 'English').trim(),
    readingAge: String(body.readingAge || '18+').trim(),
    publicationRights: String(body.publicationRights || 'I own the copyright and hold necessary publishing rights').trim()
  };
}

function kdpListingFieldsFromRow(row, book, genreConfig) {
  return {
    format: row.format || 'ebook',
    title: row.title || book?.title || '',
    subtitle: row.subtitle || '',
    seriesName: row.series_name || book?.series || '',
    seriesNumber: row.series_number || '',
    blurbDraft: row.blurb_draft || book?.blurb || '',
    compTitles: row.comp_titles || '',
    targetCategories: row.target_categories || '',
    priceUsd: Number(row.price_usd || genreConfig?.default_price_usd || 4.99),
    kuEnrolled: Number(row.ku_enrolled ?? genreConfig?.default_ku_enrolled ?? 0),
    aiGenerated: Number(row.ai_generated ?? genreConfig?.ai_generated_default ?? 0),
    aiAssisted: Number(row.ai_assisted ?? genreConfig?.ai_assisted_default ?? 1),
    language: row.language || 'English',
    readingAge: row.reading_age || '18+',
    publicationRights: row.publication_rights || 'I own the copyright and hold necessary publishing rights'
  };
}

function findPenName(label) {
  if (!label || String(label).toLowerCase() === 'all') return null;
  return allPenNames().find((pen) => pen.display_name.toLowerCase() === String(label).toLowerCase()) || null;
}

function penNameFieldsFromBody(body) {
  const displayName = String(body.displayName || '').trim();
  if (!displayName) throw new Error('Pen name display name is required.');
  const brandDetails = {
    genre: String(body.genre || '').trim(),
    voice: String(body.voice || '').trim()
  };
  const bufferChannels = Object.fromEntries([
    ['instagram', body.bufferInstagram],
    ['threads', body.bufferThreads],
    ['bluesky', body.bufferBluesky]
  ].map(([key, value]) => [key, String(value || '').trim()]).filter(([, value]) => value));
  const colorPalette = Object.fromEntries([
    ['accent', body.colorAccent],
    ['ink', body.colorInk],
    ['paper', body.colorPaper]
  ].map(([key, value]) => [key, String(value || '').trim()]).filter(([, value]) => value));
  const socialHandles = Object.fromEntries([
    ['instagram', body.handleInstagram],
    ['threads', body.handleThreads],
    ['bluesky', body.handleBluesky],
    ['website', body.website]
  ].map(([key, value]) => [key, String(value || '').trim()]).filter(([, value]) => value));
  return {
    displayName,
    brandDetails: JSON.stringify(brandDetails),
    emailOctopusListId: String(body.emailOctopusListId || '').trim() || null,
    amazonAdsProfileId: String(body.amazonAdsProfileId || '').trim() || null,
    bufferChannels: JSON.stringify(bufferChannels),
    colorPalette: JSON.stringify(colorPalette),
    fonts: JSON.stringify({}),
    socialHandles: JSON.stringify(socialHandles),
    active: body.active === 'on' || body.active === '1' ? 1 : 0
  };
}

function uniquePenNameKey(displayName) {
  const base = slugify(displayName) || 'pen-name';
  let key = base;
  let suffix = 2;
  const exists = sqlite.prepare('SELECT 1 FROM pen_names WHERE key = ?');
  while (exists.get(key)) {
    key = `${base}-${suffix}`;
    suffix += 1;
  }
  return key;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function booksTable(rows) {
  if (!rows.length) return '<p class="muted">No books yet.</p>';
  return `<table><thead><tr><th>Title</th><th>Series</th><th>Pen</th><th>Words</th><th>Status</th><th>Planned</th><th>Actual</th><th>Notes</th><th>Actions</th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td>${escapeHtml(row.title)}</td>
      <td>${escapeHtml(row.series || '')}</td>
      <td>${escapeHtml(row.pen_name || '')}</td>
      <td>${Number(row.word_count || 0).toLocaleString()}</td>
      <td>${escapeHtml(row.status || '')}</td>
      <td>${escapeHtml(row.planned_release || '')}</td>
      <td>${escapeHtml(row.actual_release || '')}</td>
      <td>${escapeHtml(row.notes || '')}</td>
      <td>
        <div class="action-row">
          <a class="button secondary" href="/books/${escapeHtml(row.id)}/edit">Edit</a>
          <a class="button secondary" href="/kdp-listings?bookId=${escapeHtml(row.id)}">KDP Packet</a>
          <form method="post" action="/books/${escapeHtml(row.id)}/delete" onsubmit="return confirm('Remove this book from Author HQ? Related KDP/ad records will stay, but they will be unlinked from this book.');">
            <button class="danger" type="submit">Remove</button>
          </form>
        </div>
      </td>
    </tr>`).join('')}
  </tbody></table>`;
}

function allUpcomingBooks() {
  return sqlite.prepare(`
    SELECT b.*, p.display_name AS pen_name FROM books b
    LEFT JOIN pen_names p ON p.id = b.pen_name_id
    WHERE b.planned_release IS NOT NULL AND b.planned_release != ''
    ORDER BY b.planned_release ASC
  `).all();
}

function socialRunwaySection(pen, runway) {
  if (!runway.configured) {
    return `<section class="card"><h2>Social Runway - ${escapeHtml(pen.display_name)}</h2><p class="muted">No Buffer channels configured for this pen name.</p></section>`;
  }
  if (!runway.channels.length) {
    return `<section class="card"><h2>Social Runway - ${escapeHtml(pen.display_name)}</h2><p class="muted">${escapeHtml(runway.error || 'Could not load Buffer data.')}</p></section>`;
  }
  return `<section class="card">
    <div class="section-title-row"><h2>Social Runway - ${escapeHtml(pen.display_name)}</h2><a class="button secondary" href="/buffer-health">Refresh</a></div>
    <table><thead><tr><th>Platform</th><th>Scheduled Through</th><th>Days Left</th><th>Status</th></tr></thead><tbody>
      ${runway.channels.map((ch) => {
        const health = runwayHealth(ch.daysLeft, ch.scheduledThrough);
        return `<tr><td>${escapeHtml(titleCase(ch.platform))}</td><td>${escapeHtml(formatDateTime(ch.scheduledThrough))}</td><td>${escapeHtml(ch.daysLeft || 0)}</td><td><span class="status-dot ${health.className}"></span>${escapeHtml(health.label)}</td></tr>`;
      }).join('')}
    </tbody></table>
  </section>`;
}

function socialRunwayDashboard(bufferCards, { maxPens = bufferCards.length, maxChannels = 4 } = {}) {
  if (!bufferCards.length) return '<p class="muted">No pen names yet.</p>';
  const priority = [
    ...bufferCards.filter(({ runway }) => runway.configured && runway.channels?.length),
    ...bufferCards.filter(({ runway }) => !(runway.configured && runway.channels?.length))
  ].slice(0, maxPens);
  return `<div class="dashboard-runway">
    ${priority.map(({ pen, runway }) => {
      if (!runway.configured) {
        return `<div class="runway-group"><h3>${escapeHtml(pen.display_name)}</h3><p class="muted">No Buffer channels configured.</p></div>`;
      }
      if (!runway.channels.length) {
        return `<div class="runway-group"><h3>${escapeHtml(pen.display_name)}</h3><p class="muted">${escapeHtml(runway.error || 'Could not load Buffer data.')}</p></div>`;
      }
      return `<div class="runway-group">
        <h3>${escapeHtml(pen.display_name)}</h3>
        <table><thead><tr><th>Platform</th><th>Scheduled Through</th><th>Days Left</th><th>Status</th></tr></thead><tbody>
          ${runway.channels.slice(0, maxChannels).map((ch) => {
            const health = runwayHealth(ch.daysLeft, ch.scheduledThrough);
            return `<tr><td>${escapeHtml(titleCase(ch.platform))}</td><td>${escapeHtml(formatDateTime(ch.scheduledThrough))}</td><td>${escapeHtml(ch.daysLeft || 0)}</td><td><span class="status-dot ${health.className}"></span>${escapeHtml(health.label)}</td></tr>`;
          }).join('')}
        </tbody></table>
      </div>`;
    }).join('')}
  </div>`;
}

function runwayHealth(daysLeft, scheduledThrough) {
  if (!scheduledThrough || daysLeft === 0) return { label: 'Empty', className: 'empty' };
  if (daysLeft >= 21) return { label: 'Healthy', className: 'healthy' };
  if (daysLeft >= 8) return { label: 'Batch Soon', className: 'soon' };
  return { label: 'Needs Attention', className: 'attention' };
}

const releaseStatuses = ['Drafting', 'Draft Complete', 'Editing', 'Editing Complete', 'Formatting', 'Cover Ready', 'Uploaded to KDP', 'Pre-order Live'];
const releaseStatusOrder = ['Planning', ...releaseStatuses, 'Published'];

function upcomingReleasesHtml(books, limit = 8, { compact = false } = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = books
    .filter((book) => {
      const release = parseDateOnly(book.planned_release);
      return release && release > today && releaseStatuses.includes(book.status);
    })
    .sort((a, b) => parseDateOnly(a.planned_release) - parseDateOnly(b.planned_release))
    .slice(0, limit);
  if (!upcoming.length) return '<p class="muted">No upcoming releases.</p>';
  return `<div class="release-list">${upcoming.map((book) => releaseCard(book, today, { compact })).join('')}</div>`;
}

function releaseCard(book, today, { compact = false } = {}) {
  const release = parseDateOnly(book.planned_release);
  const days = Math.ceil((release - today) / 86400000);
  const nudges = releaseNudges(book.status, days);
  const visibleNudges = compact && nudges.length ? [nudges.at(-1)] : nudges;
  const allNudges = nudges.map((nudge) => `${nudge.marker} ${nudge.message}`).join(' | ');
  return `<article class="release-card">
    <div class="release-head"><strong>${escapeHtml(book.title)}</strong><span class="${days <= 21 ? 'bad' : 'blue'}">${days} days</span></div>
    <p class="tiny">${escapeHtml(formatDateTime(book.planned_release))} - ${escapeHtml(book.series || 'No series')} - <span class="pill">${escapeHtml(book.status)}</span></p>
    ${visibleNudges.length ? visibleNudges.map((nudge) => `<div class="release-nudge ${nudge.level}"${compact && nudges.length > 1 ? ` title="${escapeAttr(allNudges)}"` : ''}>${escapeHtml(nudge.marker)} ${escapeHtml(nudge.message)}${compact && nudges.length > 1 ? ` <span class="nudge-count">+${nudges.length - 1}</span>` : ''}</div>`).join('') : '<div class="release-nudge ok">On track</div>'}
  </article>`;
}

function releaseNudges(status, days) {
  const idx = releaseStatusOrder.indexOf(status);
  const statusIdx = idx < 0 ? 0 : idx;
  const nudges = [];
  if (days < 90 && statusIdx < 2) nudges.push({ level: 'warn', marker: '~', message: 'Still drafting - aim to finish the draft soon' });
  if (days < 60 && statusIdx < 4) nudges.push({ level: 'warn', marker: '~', message: 'Editing window is closing' });
  if (days < 45 && statusIdx < 6) nudges.push({ level: 'warn', marker: '~', message: 'Formatting and cover should be underway' });
  if (days < 21 && statusIdx < 7) nudges.push({ level: 'urgent', marker: '!', message: 'Should be uploaded to KDP by now' });
  if (days < 7 && statusIdx < 8) nudges.push({ level: 'urgent', marker: '!', message: 'Pre-order should be live' });
  return nudges;
}

function parseDateOnly(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function titleCase(value) {
  return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function brainRootForm() {
  return `<form class="stack compact-form" method="post" action="/brain/roots">
    <div class="field"><label>Label</label><input name="label" placeholder="Writing"></div>
      <div class="field"><label>Folder Path</label><input name="folderPath" placeholder="D:\\Writing"></div>
    <button>Save Folder</button>
  </form>`;
}

function brainNoteForm() {
  return `<form class="stack compact-form" method="post" action="/brain/notes">
    <div class="row"><div class="field"><label>Type</label><select name="noteType"><option>Decision</option><option>Canon</option><option>Correction</option><option>Fact</option><option>Process</option><option>Vocabulary</option><option>Idea</option></select></div><div class="field"><label>Status</label><select name="status"><option>Active</option><option>Resolved</option><option>Archived</option></select></div></div>
    <div class="field"><label>Title</label><input name="title" required placeholder="What changed or needs remembering?"></div>
    <textarea name="body" placeholder="Specific fact, decision, correction, or source-grounded note..." required></textarea>
    <div class="row"><div class="field"><label>Book</label><select name="bookId"><option value="">None</option>${options(allBooks(), '', { value: 'id', label: 'title' })}</select></div><div class="field"><label>Pen</label><select name="penNameId"><option value="">None</option>${options(allPenNames(), '')}</select></div></div>
    <div class="field"><label>Source Path</label><input name="sourcePath" placeholder="Optional file path or reference"></div>
    <label><input type="checkbox" name="important"> Important / canon-critical</label>
    <button>Save Note</button>
  </form>`;
}

function brainRootsTable(rows) {
  return `<table><thead><tr><th>Folder</th><th>Status</th><th>Last Scan</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><strong>${escapeHtml(row.label)}</strong><br><span class="tiny">${escapeHtml(row.folder_path)}</span></td>
      <td>${row.active ? 'Active' : 'Paused'}</td>
      <td>${escapeHtml(formatDateTime(row.last_indexed_at))}</td>
      <td><form method="post" action="/brain/roots/${escapeHtml(row.id)}/toggle"><button class="secondary">${row.active ? 'Pause' : 'Resume'}</button></form></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function improvementRunsTable(rows) {
  return `<table><thead><tr><th>Recent Runs</th><th>Output</th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><span class="pill">${escapeHtml(row.run_type)}</span> <span class="pill">${escapeHtml(row.provider)}</span><br><strong>${escapeHtml(row.summary || '')}</strong><br><span class="tiny">${escapeHtml(formatDateTime(row.created_at))}</span></td>
      <td>${row.output_path ? `<span class="tiny">${escapeHtml(row.output_path)}</span>` : ''}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function improvementSchedulePanel() {
  const settings = loadSettings();
  const enabled = settings.IMPROVEMENT_SCHEDULE_ENABLED === '1';
  const selectedDay = settings.IMPROVEMENT_SCHEDULE_DAY || '5';
  const selectedTime = settings.IMPROVEMENT_SCHEDULE_TIME || '17:00';
  const days = [
    ['0', 'Sunday'],
    ['1', 'Monday'],
    ['2', 'Tuesday'],
    ['3', 'Wednesday'],
    ['4', 'Thursday'],
    ['5', 'Friday'],
    ['6', 'Saturday']
  ];
  return `<form class="schedule-row" method="post" action="/brain/improvement-schedule">
    <label class="check-inline"><input type="checkbox" name="enabled" ${enabled ? 'checked' : ''}> Run weekly review</label>
    <select name="day">${days.map(([value, label]) => `<option value="${value}" ${selectedDay === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <input type="time" name="time" value="${escapeHtml(selectedTime)}">
    <button class="secondary">Save Schedule</button>
    <span class="tiny">${settings.IMPROVEMENT_SCHEDULE_LAST_RUN ? `Last scheduled run: ${escapeHtml(settings.IMPROVEMENT_SCHEDULE_LAST_RUN)}` : 'Runs while Author HQ is open; missed runs catch up on launch.'}</span>
  </form>`;
}

function improvementFilterForm(filters) {
  const statuses = ['Proposed', 'Planned', 'Applied', 'Resolved', 'Dismissed', 'All'];
  const buckets = ['All', 'Auto-Approve', 'Needs Sign-Off', 'More Context Required', 'Needs Review'];
  return `<form class="row review-filter" method="get" action="/brain/improvements">
    <div class="field"><label>Status</label><select name="status">${statuses.map((status) => `<option value="${escapeHtml(status)}" ${filters.status === status ? 'selected' : ''}>${escapeHtml(status)}</option>`).join('')}</select></div>
    <div class="field"><label>Bucket</label><select name="bucket">${buckets.map((bucket) => `<option value="${escapeHtml(bucket)}" ${filters.bucket === bucket ? 'selected' : ''}>${escapeHtml(bucket)}</option>`).join('')}</select></div>
    <button class="secondary">Filter</button>
  </form>`;
}

function knowledgeBaseMoveForm() {
  return `<details class="kb-move-panel" id="brain-storage" open>
    <summary>Move Brain knowledge base to another drive</summary>
    <form class="stack compact-form" method="post" action="/brain/kb/move">
      <p class="tiny">Current: ${escapeHtml(knowledgeBaseRoot())}</p>
      <div class="field"><label>New Knowledge Base Folder</label><input name="knowledgeBaseRoot" placeholder="E:\\Author HQ Knowledge Base"></div>
      <div class="field"><label>Old Folder Cleanup</label><select name="cleanupMode"><option value="archive" selected>Archive old folder after copy</option><option value="keep">Keep old folder</option><option value="delete">Delete old folder after copy</option></select></div>
      <button class="secondary">Move Knowledge Base</button>
    </form>
  </details>`;
}

function improvementItemsTable(rows, { compact = false, full = false } = {}) {
  return `<table><thead><tr><th>Review Queue</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><span class="pill">${escapeHtml(row.bucket)}</span><br><strong>${escapeHtml(row.title)}</strong>${row.body && !compact ? `<p class="tiny">${escapeHtml(row.body)}</p>` : ''}${full ? `<p class="tiny">Created ${escapeHtml(formatDateTime(row.created_at))}${row.resolved_at ? ` · Resolved ${escapeHtml(formatDateTime(row.resolved_at))}` : ''}</p>` : ''}</td>
      <td>${escapeHtml(row.status)}<br><span class="tiny">${escapeHtml(row.run_type || '')}</span></td>
      <td><div class="action-row">${String(row.status).toLowerCase() === 'proposed' ? `<a class="button secondary" href="/brain/improvements/${escapeHtml(row.id)}/resolve">Resolve</a>` : `${row.resolution_note_id ? '<span class="pill">Noted</span>' : ''}<form method="post" action="/brain/improvements/${escapeHtml(row.id)}/reopen"><button class="secondary">Bring Back</button></form>`}</div></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function improvementResolutionForm(item) {
  const supported = improvementBuiltInLabel(item);
  return `<form class="stack" method="post" action="/brain/improvements/${escapeHtml(item.id)}/resolve">
    ${supported ? `<div class="notice good">Built-in action available: ${escapeHtml(supported)}</div>` : '<p class="muted">No automatic fix exists for this one yet. Applying it will save a planned implementation note.</p>'}
    <div class="field">
      <label>Your answer / decision</label>
      <textarea name="answer" placeholder="Example: Royalties stay separate from income. Income is only direct payouts/manual income, while royalty reporting tracks title performance.">${escapeHtml(defaultImprovementAnswer(item))}</textarea>
    </div>
    <div class="row">
      <button name="action" value="apply">Apply Built-In Fix</button>
      <button name="action" value="resolved">Save Decision</button>
      <button class="secondary" name="action" value="planned">Mark Planned</button>
      <button class="secondary" name="action" value="dismissed">Dismiss</button>
    </div>
  </form>`;
}

function improvementBuiltInLabel(item) {
  const text = `${item.title || ''} ${item.body || ''}`.toLowerCase();
  if (text.includes('expense category')) return 'show this-month expense category rollups on the Expenses page';
  if (text.includes('income') && text.includes('royalt')) return 'save the royalty-vs-income policy as a Brain decision';
  if (text.includes('brain notes') && text.includes('brain documents')) return 'save the Brain notes/documents distinction as a workflow decision';
  if (text.includes('improvement run')) return 'save manual improvement runs as the current workflow policy';
  if (text.includes('manuscript status') || text.includes('progress')) return 'save Books as the source of truth for manuscript status';
  if (text.includes('doc count') || text.includes('categorized index') || text.includes('index page to brain')) return 'generate a categorized Brain document index';
  if (text.includes('duplicate brain docs') || text.includes('timestamp')) return 'remove duplicate timestamped rows from the Brain index without deleting source files';
  if (text.includes('copyedit') && text.includes('archive')) return 'generate a copyedit archive candidate report without moving files';
  if (text.includes('verified live')) return 'add a Verified Live field to content posts';
  return '';
}

function defaultImprovementAnswer(item) {
  const text = `${item.title || ''} ${item.body || ''}`.toLowerCase();
  if (text.includes('income') && text.includes('royalt')) {
    return 'Royalties and income stay separate by design. Royalties track book performance over reporting periods; income is for actual payouts or manual non-royalty income entries.';
  }
  if (text.includes('brain notes') && text.includes('brain documents')) {
    return 'Brain documents are indexed source files from writing folders. Brain notes are explicit decisions, corrections, and workflow memories captured inside Author HQ.';
  }
  if (text.includes('improvement run')) {
    return 'Improvement runs are manual for now. I will run them when I want a review pass, not on a schedule.';
  }
  if (text.includes('manuscript status') || text.includes('progress')) {
    return 'The Books table is the source of truth for public workflow status. Draft/progress files in the Brain are supporting context, not authoritative status.';
  }
  if (text.includes('social proof') || text.includes('verified live')) {
    return 'This is useful later, but Buffer scheduling is enough for now. A verified-live workflow can wait until social posting failures become a real problem.';
  }
  if (text.includes('expense category')) {
    return 'Planned: add category rollups to monthly financial review so software, marketing, cover/design, and other costs are easier to scan.';
  }
  if (text.includes('doc count') || text.includes('categorized index') || text.includes('index page to brain')) {
    return 'Generate a categorized Brain document index so the indexed files are easier to browse by chapters, logs, metadata, editing/proofing, launch, newsletter, outlines, and story bible material.';
  }
  if (text.includes('duplicate brain docs') || text.includes('timestamp')) {
    return 'Remove duplicate timestamped rows from the Brain index only. Do not delete the source files automatically.';
  }
  if (text.includes('copyedit') && text.includes('archive')) {
    return 'Generate a copyedit archive candidate report first. Do not move manuscript files automatically without a separate review.';
  }
  if (text.includes('verified live')) {
    return 'Add a Verified Live field to content posts so scheduled social posts can be distinguished from confirmed-published posts.';
  }
  return '';
}

function brainNotesTable(rows) {
  return `<table><thead><tr><th>Note</th><th>Context</th><th>Status</th><th>Updated</th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><span class="pill">${escapeHtml(row.note_type)}</span> ${row.important ? '<span class="pill">Important</span>' : ''}<br><strong>${escapeHtml(row.title)}</strong><p class="tiny">${escapeHtml(row.body)}</p>${row.source_path ? `<p class="tiny">${escapeHtml(row.source_path)}</p>` : ''}</td>
      <td>${escapeHtml(row.book_title || '')}<br><span class="tiny">${escapeHtml(row.pen_name || '')}</span></td>
      <td>${escapeHtml(row.status)}</td>
      <td>${escapeHtml(formatDateTime(row.updated_at))}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function brainDocumentsTable(rows) {
  return `<table><thead><tr><th>Document</th><th>Book / Pen</th><th>Tags</th><th>Modified</th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><strong>${escapeHtml(row.title || row.file_name)}</strong><br><span class="tiny">${escapeHtml(row.file_path)}</span>${row.snippet ? `<p class="tiny">${escapeHtml(row.snippet)}</p>` : ''}</td>
      <td>${escapeHtml(row.book_title || '')}<br><span class="tiny">${escapeHtml(row.pen_name || row.root_label || '')}</span></td>
      <td>${brainTagPills(row.tags)}</td>
      <td>${escapeHtml(formatDateTime(row.modified_at))}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function brainTagPills(value) {
  const tags = parseJson(value, []);
  return tags.length ? tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join(' ') : '';
}

function morningBriefingHero({ today, todaysEvents, nextEvents, coTeaching }) {
  const todayLine = todaysEvents.length ? calendarMiniList(todaysEvents) : '<p class="muted">No events scheduled today.</p>';
  const next = nextEvents.find((event) => event.event_date !== today) || nextEvents[0];
  return `<div class="briefing-blocks">
    <section class="next-event-card"><span class="eyebrow">Today</span><strong>${escapeHtml(today)}</strong>${todayLine}</section>
    <section class="next-event-card"><span class="eyebrow">Next</span>${next ? `<strong>${escapeHtml(next.title)}</strong><small>${escapeHtml(next.event_date)} - ${escapeHtml(next.event_type || 'Event')}</small>` : '<strong>No upcoming events</strong><small>Add your schedule on the Calendar page.</small>'}</section>
    <section class="next-event-card"><span class="eyebrow">Co-teaching</span>${coTeaching[0] ? `<strong>${escapeHtml(coTeaching[0].title)}</strong><small>${escapeHtml(coTeaching[0].event_date)}${coTeaching[0].event_time ? ` at ${escapeHtml(coTeaching[0].event_time)}` : ''}</small>${coTeachingCreditsButton()}` : '<strong>Nothing scheduled</strong><small>Add co-teaching days as calendar events.</small>'}</section>
  </div>`;
}

function calendarMiniList(events) {
  return `<div class="stack-page">${events.map((event) => `<div><strong>${escapeHtml(event.title)}</strong><br><span class="tiny">${escapeHtml(event.event_date)}${event.event_time ? ` ${escapeHtml(event.event_time)}` : ''} - ${escapeHtml(event.event_type || '')}</span></div>`).join('')}</div>`;
}

function coTeachingCreditsButton() {
  const url = getSetting('CO_TEACHING_CREDITS_URL');
  return url
    ? `<a class="button secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Claim Credits</a>`
    : '';
}

function calendarMonthData(monthValue) {
  const base = parseMonthValue(monthValue || todayIso().slice(0, 7));
  const monthStart = new Date(base.getFullYear(), base.getMonth(), 1);
  const monthEnd = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
  const startIso = dateToIso(gridStart);
  const endIso = dateToIso(gridEnd);
  const events = combinedCalendarEventsRange(startIso, endIso);
  const grouped = events.reduce((map, event) => {
    if (!map.has(event.event_date)) map.set(event.event_date, []);
    map.get(event.event_date).push(event);
    return map;
  }, new Map());
  const days = [];
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const iso = dateToIso(cursor);
    days.push({
      iso,
      day: cursor.getDate(),
      inMonth: cursor.getMonth() === monthStart.getMonth(),
      isToday: iso === todayIso(),
      events: grouped.get(iso) || []
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return {
    days,
    label: monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    month: dateToMonth(monthStart),
    prevMonth: dateToMonth(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1)),
    nextMonth: dateToMonth(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1))
  };
}

function calendarMonthView(data) {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `<div class="calendar-month">
    <div class="calendar-month-head">
      <div>
        <span class="eyebrow">Month View</span>
        <strong>${escapeHtml(data.label)}</strong>
      </div>
      <div class="action-row">
        <a class="button secondary" href="/calendar?month=${escapeHtml(data.prevMonth)}">Previous</a>
        <a class="button secondary" href="/calendar?month=${escapeHtml(todayIso().slice(0, 7))}">Today</a>
        <a class="button secondary" href="/calendar?month=${escapeHtml(data.nextMonth)}">Next</a>
      </div>
    </div>
    <div class="month-grid weekdays">${weekdays.map((day) => `<div>${day}</div>`).join('')}</div>
    <div class="month-grid month-days-grid">
      ${data.days.map((day) => `<div class="month-day ${day.inMonth ? '' : 'other-month'} ${day.isToday ? 'today' : ''} ${day.events.length > 4 ? 'show-all' : ''}" data-calendar-date="${escapeHtml(day.iso)}" data-event-count="${escapeHtml(day.events.length)}">
        <div class="month-day-number">${escapeHtml(day.day)}</div>
        <div class="month-events">${day.events.map(calendarMonthChip).join('')}${day.events.length > 4 ? `<span class="month-more">+${day.events.length - 4} more</span>` : ''}</div>
        <template class="day-detail-template">${calendarDayDetails(day)}</template>
      </div>`).join('')}
    </div>
  </div>`;
}

function calendarDayDetails(day) {
  if (!day.events.length) return '<p class="muted">No events yet.</p>';
  return `<div class="day-detail-list">${day.events.map((event) => `<div class="day-detail-item">
    <span class="pill">${escapeHtml(event.event_type || 'Event')}</span>
    <strong>${escapeHtml(event.title)}</strong>
    <small>${event.event_time ? `${escapeHtml(event.event_time)} - ` : ''}${escapeHtml(event.book_title || event.pen_name || event.source || '')}</small>
    ${event.notes ? `<p class="tiny">${escapeHtml(event.notes)}</p>` : ''}
    <div class="action-row">
      ${(event.source === 'manual' || event.source === 'google') && event.id ? `<a class="button secondary" href="/calendar/events/${escapeHtml(event.id)}/edit">Edit</a>` : ''}
      ${event.local_key ? `<button class="danger" type="button" data-delete-event-key="${escapeHtml(event.local_key)}" data-delete-event-source="${escapeHtml(event.source || '')}">Delete</button>` : ''}
    </div>
  </div>`).join('')}</div>`;
}

function calendarMonthChip(event) {
  const text = `${event.event_time ? `${event.event_time} ` : ''}${event.title}`;
  const chip = `<span class="month-event type-${slugify(event.event_type || 'general')}"><small>${escapeHtml(event.event_type || 'Event')}</small>${escapeHtml(text)}</span>`;
  const localKey = event.local_key || '';
  if ((event.source === 'manual' || event.source === 'google') && event.id) {
    return `<a class="month-event-link" draggable="false" data-event-key="${escapeHtml(localKey)}" href="/calendar/events/${escapeHtml(event.id)}/edit">${chip}</a>`;
  }
  if ((event.source === 'book' || event.source === 'goal') && localKey) {
    return `<span class="month-event-link generated" data-event-key="${escapeHtml(localKey)}" title="Drag to reschedule">${chip}</span>`;
  }
  return chip;
}

function calendarEventModal() {
  return `<div class="modal-backdrop" id="calendar-event-modal" hidden>
    <section class="modal-panel">
      <div class="section-title-row">
        <h2>Add Event</h2>
        <button class="secondary icon-button" type="button" data-close-event-modal aria-label="Close">X</button>
      </div>
      ${calendarEventForm({}, { compact: true })}
    </section>
  </div>
  <div class="modal-backdrop" id="calendar-day-modal" hidden>
    <section class="modal-panel">
      <div class="section-title-row">
        <h2 id="calendar-day-title">Day</h2>
        <button class="secondary icon-button" type="button" data-close-day-modal aria-label="Close">X</button>
      </div>
      <div id="calendar-day-events"></div>
      <div class="action-row modal-actions">
        <button type="button" data-day-add-event>Add Event</button>
      </div>
    </section>
  </div>
  <script>
    (() => {
      const modal = document.getElementById('calendar-event-modal');
      const dayModal = document.getElementById('calendar-day-modal');
      if (!modal) return;
      const dateInput = modal.querySelector('input[name="eventDate"]');
      const titleInput = modal.querySelector('input[name="title"]');
      const dayTitle = document.getElementById('calendar-day-title');
      const dayEvents = document.getElementById('calendar-day-events');
      let selectedDay = '';
      const openModal = (date) => {
        if (dateInput && date) dateInput.value = date;
        modal.hidden = false;
        setTimeout(() => titleInput?.focus(), 0);
      };
      const closeModal = () => { modal.hidden = true; };
      const closeDayModal = () => { if (dayModal) dayModal.hidden = true; };
      const openDayModal = (day) => {
        if (!dayModal || !dayTitle || !dayEvents) return;
        selectedDay = day.dataset.calendarDate;
        dayTitle.textContent = selectedDay;
        dayEvents.innerHTML = day.querySelector('.day-detail-template')?.innerHTML || '<p class="muted">No events yet.</p>';
        dayModal.hidden = false;
      };
      document.querySelectorAll('[data-open-event-modal]').forEach((button) => {
        button.addEventListener('click', () => openModal(button.dataset.openEventModal));
      });
      document.querySelectorAll('[data-calendar-date]').forEach((day) => {
        day.addEventListener('click', (event) => {
          if (event.target.closest('.month-event-link')) return;
          if (Number(day.dataset.eventCount || 0) > 0) openDayModal(day);
          else openModal(day.dataset.calendarDate);
        });
      });
      let dragState = null;
      let suppressChipClick = false;
      const clearDropTargets = () => document.querySelectorAll('.month-day.drop-target').forEach((day) => day.classList.remove('drop-target'));
      const moveEvent = async (localKey, date) => {
        const response = await fetch('/calendar/events/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localKey, eventDate: date })
        });
        if (response.ok) {
          window.location.reload();
        } else {
          const payload = await response.json().catch(() => ({}));
          alert(payload.error || 'Could not move that event.');
        }
      };
      const deleteEvent = async (localKey, source) => {
        const warning = source === 'google'
          ? 'Delete this local event? If it still exists in Google Calendar, a future sync may bring it back.'
          : source === 'book'
            ? 'Remove this book date from Author HQ? This clears the matching date field on the book.'
            : source === 'goal'
              ? 'Remove this goal from the calendar? This clears the goal target date.'
              : 'Delete this event from Author HQ?';
        if (!confirm(warning)) return;
        const response = await fetch('/calendar/events/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localKey })
        });
        if (response.ok) {
          window.location.reload();
        } else {
          const payload = await response.json().catch(() => ({}));
          alert(payload.error || 'Could not delete that event.');
        }
      };
      document.querySelectorAll('.month-event-link[data-event-key]').forEach((chip) => {
        chip.addEventListener('click', (event) => {
          if (suppressChipClick) event.preventDefault();
        });
        chip.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          dragState = {
            chip,
            localKey: chip.dataset.eventKey,
            startX: event.clientX,
            startY: event.clientY,
            dragging: false,
            ghost: null
          };
          chip.setPointerCapture?.(event.pointerId);
        });
      });
      document.addEventListener('pointermove', (event) => {
        if (!dragState) return;
        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;
        if (!dragState.dragging && Math.hypot(dx, dy) < 6) return;
        event.preventDefault();
        if (!dragState.dragging) {
          dragState.dragging = true;
          dragState.chip.classList.add('dragging');
          dragState.ghost = dragState.chip.cloneNode(true);
          dragState.ghost.classList.add('drag-ghost');
          dragState.ghost.removeAttribute('href');
          document.body.appendChild(dragState.ghost);
        }
        dragState.ghost.style.left = event.clientX + 12 + 'px';
        dragState.ghost.style.top = event.clientY + 12 + 'px';
        dragState.ghost.hidden = true;
        const targetDay = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-calendar-date]');
        dragState.ghost.hidden = false;
        clearDropTargets();
        targetDay?.classList.add('drop-target');
      }, { passive: false });
      document.addEventListener('pointerup', async (event) => {
        if (!dragState) return;
        const state = dragState;
        dragState = null;
        state.chip.classList.remove('dragging');
        state.ghost?.remove();
        const targetDay = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-calendar-date]');
        clearDropTargets();
        if (state.dragging && targetDay?.dataset.calendarDate) {
          event.preventDefault();
          suppressChipClick = true;
          setTimeout(() => { suppressChipClick = false; }, 0);
          await moveEvent(state.localKey, targetDay.dataset.calendarDate);
        }
      });
      document.addEventListener('pointercancel', () => {
        if (!dragState) return;
        dragState.chip.classList.remove('dragging');
        dragState.ghost?.remove();
        dragState = null;
        clearDropTargets();
      });
      modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-event-modal]')) closeModal();
      });
      dayModal?.addEventListener('click', (event) => {
        if (event.target === dayModal || event.target.closest('[data-close-day-modal]')) closeDayModal();
        if (event.target.closest('[data-day-add-event]')) {
          closeDayModal();
          openModal(selectedDay);
        }
        const deleteButton = event.target.closest('[data-delete-event-key]');
        if (deleteButton) {
          deleteEvent(deleteButton.dataset.deleteEventKey, deleteButton.dataset.deleteEventSource);
        }
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !modal.hidden) closeModal();
        if (event.key === 'Escape' && dayModal && !dayModal.hidden) closeDayModal();
      });
    })();
  </script>`;
}

function weeklySummaryForm() {
  const defaultWeekEnding = mostRecentSaturdayIso();
  return `<form class="stack compact-form" method="post" action="/briefing/week-summary">
    <div class="field"><label>Week Ending</label><input type="date" name="weekEnding" value="${escapeHtml(defaultWeekEnding)}"><span class="tiny">Use the Saturday for the week you are summarizing; you can backdate this anytime.</span></div>
    <label class="check-inline"><input type="checkbox" name="includeJournal" checked> Include journal entries from that week</label>
    <textarea name="summary" placeholder="What did you work on this week? Drafting, launches, admin, co-teaching days, decisions, things to remember..."></textarea>
    <button>Save Weekly Summary</button>
  </form>`;
}

function journalEntryForm() {
  return `<form class="stack journal-form" method="post" action="/journal">
    <div class="row">
      <div class="field"><label>Date</label><input type="date" name="entryDate" value="${escapeHtml(todayIso())}"></div>
      <div class="field"><label>Title</label><input name="title" placeholder="Today, launch brain, rough energy, etc."></div>
    </div>
    <div class="row">
      <div class="field"><label>Mood</label><select name="mood"><option value="">Not tracking</option><option>Good</option><option>Okay</option><option>Rough</option><option>Overwhelmed</option><option>Hopeful</option></select></div>
      <div class="field"><label>Energy</label><select name="energy"><option value="">Not tracking</option><option>Low</option><option>Medium</option><option>High</option><option>Scattered</option></select></div>
      <div class="field"><label>Tags</label><input name="tags" placeholder="writing, health, money"></div>
    </div>
    <textarea class="journal-editor" name="body" required placeholder="Write whatever needs somewhere to land..."></textarea>
    <button>Save Journal Entry</button>
  </form>`;
}

function journalEntriesList(rows) {
  return `<div class="stack-page">
    ${rows.map((row) => `<article class="journal-entry">
      <div class="section-title-row">
        <div><h3>${escapeHtml(row.title)}</h3><p class="tiny">${escapeHtml(row.entry_date)}${row.mood || row.energy ? ` - ${escapeHtml([row.mood, row.energy].filter(Boolean).join(' / '))}` : ''}</p></div>
      </div>
      <p class="muted">${escapeHtml(row.body).slice(0, 360)}${row.body && row.body.length > 360 ? '...' : ''}</p>
      ${journalTagPills(row.tags)}
    </article>`).join('')}
  </div>`;
}

function journalTagPills(value) {
  const tags = parseJson(value, []);
  return tags.length ? `<p>${tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join(' ')}</p>` : '';
}

function dashboardModeSwitch(activeMode) {
  const modes = [
    ['author', 'Author Mode'],
    ['life', 'Life Mode'],
    ['everything', 'Everything Mode']
  ];
  return `<div class="mode-switch">
    ${modes.map(([mode, label]) => `<a class="button ${activeMode === mode ? '' : 'secondary'}" href="/?mode=${mode}">${escapeHtml(label)}</a>`).join('')}
  </div>`;
}

function lifeTaskForm() {
  return `<form class="stack compact-form" method="post" action="/life/tasks">
    <div class="field"><label>Task</label><input name="title" required placeholder="Call dentist, prep co-teaching, pay bill..."></div>
    <div class="row"><div class="field"><label>Category</label><select name="category">${lifeCategoryOptions()}</select></div><div class="field"><label>Due</label><input type="date" name="dueDate"></div></div>
    <div class="row"><div class="field"><label>Priority</label><select name="priority"><option>Normal</option><option>High</option><option>Low</option></select></div><div class="field"><label>Energy</label><select name="energy"><option value="">Any</option><option>Low</option><option>Medium</option><option>High</option></select></div></div>
    <textarea name="notes" placeholder="Notes, context, links, why this matters..."></textarea>
    <button>Save Open Loop</button>
  </form>`;
}

function lifeRoutineForm() {
  return `<form class="stack compact-form" method="post" action="/life/routines">
    <div class="field"><label>Routine</label><input name="title" required placeholder="Weekly review, laundry reset, co-teaching prep..."></div>
    <div class="row"><div class="field"><label>Category</label><select name="category">${lifeCategoryOptions()}</select></div><div class="field"><label>Cadence</label><select name="cadence"><option>Daily</option><option selected>Weekly</option><option>Weekdays</option><option>Monthly</option><option>As Needed</option></select></div></div>
    <div class="field"><label>Next Due</label><input type="date" name="nextDue"></div>
    <textarea name="notes" placeholder="What does done look like?"></textarea>
    <button>Save Routine</button>
  </form>`;
}

function lifeCategoryOptions(selected = 'General') {
  return ['General', 'Co-teaching', 'Money', 'Health', 'Home', 'Errands', 'Energy', 'Social', 'Admin'].map((category) => `<option ${category === selected ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('');
}

function lifeTasksTable(rows, { compact = false } = {}) {
  return `<table><thead><tr><th>Task</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><span class="pill">${escapeHtml(row.category)}</span> <span class="pill">${escapeHtml(row.priority)}</span><br><strong>${escapeHtml(row.title)}</strong>${!compact && row.notes ? `<p class="tiny">${escapeHtml(row.notes)}</p>` : ''}</td>
      <td>${escapeHtml(row.due_date || '')}<br><span class="tiny">${escapeHtml(row.energy || '')}</span></td>
      <td>${escapeHtml(row.status)}</td>
      <td>${String(row.status).toLowerCase() === 'open' ? `<form method="post" action="/life/tasks/${escapeHtml(row.id)}/complete"><input type="hidden" name="returnTo" value="${compact ? '/?mode=life' : '/life/tasks'}"><button class="secondary">Done</button></form>` : '<span class="pill">Done</span>'}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function lifeRoutinesTable(rows, { compact = false } = {}) {
  return `<table><thead><tr><th>Routine</th><th>Cadence</th><th>Next</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><span class="pill">${escapeHtml(row.category)}</span><br><strong>${escapeHtml(row.title)}</strong>${!compact && row.notes ? `<p class="tiny">${escapeHtml(row.notes)}</p>` : ''}</td>
      <td>${escapeHtml(row.cadence)}</td>
      <td>${escapeHtml(row.next_due || '')}<br><span class="tiny">${escapeHtml(row.status)}</span></td>
      <td><form method="post" action="/life/routines/${escapeHtml(row.id)}/toggle"><button class="secondary">${row.status === 'Active' ? 'Pause' : 'Resume'}</button></form></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function lifeLogsTable(rows) {
  return `<table><thead><tr><th>Life Log</th><th>Category</th><th>Date</th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><strong>${escapeHtml(row.title)}</strong>${row.body ? `<p class="tiny">${escapeHtml(row.body)}</p>` : ''}</td>
      <td><span class="pill">${escapeHtml(row.category)}</span><br><span class="tiny">${escapeHtml([row.mood, row.energy].filter(Boolean).join(' / '))}</span></td>
      <td>${escapeHtml(row.log_date)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function logEntryForm({ returnTo = 'chat', compact = false } = {}) {
  const examples = [
    ['Expense', '$20.19 Sudowrite credits today, one-time'],
    ['Income', '$47.32 KDP payout June'],
    ['Subscription', 'Add Claude Pro, $21.25 monthly, renews June 15'],
    ['Book', "Night's Own is now in editing"],
    ['Milestone', "Milestone: finished draft of Night's Own today"],
    ['Task', 'Task: call dentist tomorrow'],
    ['Life', 'Life log: low energy today but got admin done'],
    ['Weekly', 'Weekly summary: drafted two chapters, updated launch checklist, and co-taught Wednesday']
  ];
  return `<form class="stack log-entry-form ${compact ? 'compact-form' : ''}" method="post" action="/chat">
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
    <textarea name="text" placeholder="Example: Add Claude Pro, $21.25 monthly, renews June 15"></textarea>
    <div class="example-pills">
      ${examples.map(([label, text]) => `<button type="button" class="pill-button" data-log-example="${escapeHtml(text)}">${escapeHtml(label)}</button>`).join('')}
    </div>
    <button>${compact ? 'Save Log' : 'Parse and Save'}</button>
  </form>
  ${logExampleScript()}`;
}

function logGuideDetails({ compact = false } = {}) {
  const groups = [
    ['Money', ['$20.19 Sudowrite credits today, one-time', '$80 cover design for Selena Monroe', '$47.32 KDP payout June']],
    ['Subscriptions', ['Add Claude Pro, $21.25 monthly, renews June 15', 'Change Carrd Pro to $19 yearly, renews May 1', 'Cancel Buffer']],
    ['Books', ["Night's Own is now in editing", 'The Tide Keeps is uploaded to KDP', 'Add new book Holdfast for R.A. Lorne, status planning']],
    ['Milestones', ["Milestone: finished draft of Night's Own today", 'Hit 100 subscribers for Selena Monroe']],
    ['Weekly Recap', ['Weekly summary: drafted chapters, fixed categories, updated launch tasks', 'End of week: co-taught twice and planned next release']]
  ];
  return `<details class="log-guide ${compact ? 'compact-guide' : ''}">
    <summary>What can I enter here?</summary>
    <div class="log-guide-grid">
      ${groups.map(([title, items]) => `<div class="log-guide-group">
        <h3>${escapeHtml(title)}</h3>
        ${items.map((item) => `<button type="button" class="guide-example" data-log-example="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')}
      </div>`).join('')}
    </div>
  </details>`;
}

function logExampleScript() {
  return `<script>
    (() => {
      if (window.__authorHqLogExamplesBound) return;
      window.__authorHqLogExamplesBound = true;
      document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-log-example]');
        if (!button) return;
        const root = button.closest('.card') || document;
        const textarea = root.querySelector('textarea[name="text"]');
        if (!textarea) return;
        textarea.value = button.dataset.logExample || '';
        textarea.focus();
      });
    })();
  </script>`;
}

function calendarEventsTable(events) {
  return `<table><thead><tr><th>Date</th><th>Type</th><th>Title</th><th>Context</th><th>Source</th><th></th></tr></thead><tbody>
    ${events.map((event) => `<tr>
      <td>${escapeHtml(event.event_date)}${event.event_time ? `<br><span class="tiny">${escapeHtml(event.event_time)}</span>` : ''}</td>
      <td>${escapeHtml(event.event_type || '')}</td>
      <td><strong>${escapeHtml(event.title)}</strong>${event.notes ? `<p class="tiny">${escapeHtml(event.notes)}</p>` : ''}</td>
      <td>${escapeHtml(event.book_title || '')}<br><span class="tiny">${escapeHtml(event.pen_name || '')}</span></td>
      <td>${escapeHtml(event.source || '')}</td>
      <td>${event.source === 'manual' || event.source === 'google' ? `<div class="action-row"><a class="button secondary" href="/calendar/events/${escapeHtml(event.id)}/edit">Edit</a><form method="post" action="/calendar/events/${escapeHtml(event.id)}/delete" onsubmit="return confirm('Delete this event? Google-imported events may come back if they still exist in Google Calendar.');"><button class="danger">Delete</button></form></div>` : '<span class="tiny">Generated</span>'}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function calendarEventForm(event = {}) {
  const action = event.id ? `/calendar/events/${escapeHtml(event.id)}` : '/calendar';
  const eventTypes = ['General', 'Co-teaching', 'Release', 'Launch', 'Newsletter', 'Promo', 'Drafting', 'Admin'];
  const statuses = ['Planned', 'Done', 'Moved'];
  return `<form class="stack compact-form" method="post" action="${action}">
    <div class="field"><label>Title</label><input name="title" required value="${escapeHtml(event.title || '')}" placeholder="Newsletter send, co-teaching, cover reveal..."></div>
    <div class="row"><div class="field"><label>Date</label><input name="eventDate" type="date" value="${escapeHtml(event.event_date || todayIso())}"></div><div class="field"><label>Time</label><input name="eventTime" type="time" value="${escapeHtml(event.event_time || '')}"></div></div>
    <div class="row"><div class="field"><label>Type</label><select name="eventType">${eventTypes.map((type) => `<option ${String(event.event_type || 'General') === type ? 'selected' : ''}>${type}</option>`).join('')}</select></div><div class="field"><label>Status</label><select name="status">${statuses.map((status) => `<option ${String(event.status || 'Planned') === status ? 'selected' : ''}>${status}</option>`).join('')}</select></div></div>
    <div class="row"><div class="field"><label>Book</label><select name="bookId"><option value="">None</option>${options(allBooks(), event.book_id || '', { value: 'id', label: 'title' })}</select></div><div class="field"><label>Pen</label><select name="penNameId"><option value="">None</option>${options(allPenNames(), event.pen_name_id || '')}</select></div></div>
    <textarea name="notes" placeholder="Notes">${escapeHtml(event.notes || '')}</textarea>
    <button>${event.id ? 'Save Event' : 'Add Event'}</button>
  </form>`;
}

function googleCalendarPanel(calendars = [], error = '', connectUrl = '') {
  const configured = googleCalendarConfigured();
  const connected = googleCalendarConnected();
  const selectedId = googleCalendarId();
  return `<div class="section-title-row">
    <div>
      <h2>Google Calendar Sync</h2>
      <p class="muted">Two-way sync for this calendar. Google events come into Author HQ, and Author HQ edits go back to Google.</p>
    </div>
    <div class="action-row">
      ${connectUrl ? `<a class="button" href="${escapeHtml(connectUrl)}" target="_blank" rel="noreferrer">Connect Google</a>` : ''}
      ${connected ? '<form method="post" action="/integrations/google/disconnect"><button class="secondary">Disconnect</button></form>' : ''}
      ${!configured ? '<a class="button secondary" href="/settings">Add OAuth JSON</a>' : ''}
    </div>
  </div>
  ${connected ? `<form class="row" method="post" action="/calendar/google-calendar">
    <div class="field"><label>Sync Calendar</label>${calendars.length ? `<select name="calendarId">${calendars.map((calendar) => `<option value="${escapeHtml(calendar.id)}" ${calendar.id === selectedId ? 'selected' : ''}>${escapeHtml(calendar.summary || calendar.id)}</option>`).join('')}</select>` : `<input name="calendarId" value="${escapeHtml(selectedId)}" placeholder="primary or calendar ID">`}</div>
    <button class="secondary">Save Calendar</button>
    <button formaction="/calendar/sync/google">Sync Both Ways</button>
  </form>` : '<p class="muted">Paste the OAuth client JSON in Settings, then connect Google here.</p>'}
  ${error ? `<p class="tiny bad">${escapeHtml(error)}</p>` : ''}
  <p class="tiny">Sync checks the selected Google calendar from 45 days ago through the next year. Events imported from Google are editable here and stay matched by Google event ID.</p>`;
}

function calendarTimeline(events) {
  if (!events.length) return '<p class="muted">No upcoming calendar items yet.</p>';
  return `<div class="release-list">${events.map((event) => `<article class="release-card">
    <div class="release-head"><strong>${escapeHtml(event.title)}</strong><span class="pill">${escapeHtml(event.event_type)}</span></div>
    <p class="tiny">${escapeHtml(event.event_date)}${event.event_time ? ` ${escapeHtml(event.event_time)}` : ''} - ${escapeHtml(event.book_title || event.pen_name || event.source || '')}</p>
    ${event.notes ? `<p class="tiny">${escapeHtml(event.notes)}</p>` : ''}
  </article>`).join('')}</div>`;
}

function calendarIcs(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Author HQ//Author Calendar//EN', 'CALSCALE:GREGORIAN'];
  events.forEach((event, index) => {
    const date = String(event.event_date || '').replace(/-/g, '');
    if (!date) return;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:author-hq-${date}-${index}@local`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${date}`);
    lines.push(`SUMMARY:${icsEscape(event.title)}`);
    const description = [event.event_type, event.book_title, event.pen_name, event.notes].filter(Boolean).join(' - ');
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function icsEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

const defaultChecklist = [
  'Cover posted to Instagram',
  'Pre-order live on KDP',
  'Pre-order announced on Instagram',
  'Newsletter drafted',
  'Newsletter sent',
  'Release day post scheduled',
  'KDP page proofed',
  'Price confirmed correct',
  'Book available in Kindle Unlimited'
];

const launchStatuses = [
  'draft complete',
  'editing',
  'editing complete',
  'formatting',
  'cover ready',
  'uploaded to kdp',
  'pre-order live',
  'preorder live'
];

function shouldShowLaunchChecklist(book) {
  return launchStatuses.includes(String(book.status || '').trim().toLowerCase());
}

function launchChecklistCard(book, byBook) {
  const states = defaultChecklist.map((item) => byBook.get(`${book.title}::${item}`));
  const done = states.filter((row) => row?.checked).length;
  return `<section class="card span-6">
    <h2>${escapeHtml(book.title)}</h2>
    <p class="tiny">${escapeHtml(book.pen_name || 'Unassigned')} - ${escapeHtml(book.status || '')} - ${done}/${defaultChecklist.length} complete</p>
    <div class="progress"><span style="width:${Math.round((done / defaultChecklist.length) * 100)}%"></span></div>
    <div class="checks">
      ${defaultChecklist.map((item) => {
        const row = byBook.get(`${book.title}::${item}`);
        const checked = Boolean(row?.checked);
        return `<form class="check-row ${checked ? 'done' : ''}" method="post" action="/launch-checklists/toggle">
          <input type="hidden" name="bookId" value="${escapeHtml(book.id)}">
          <input type="hidden" name="item" value="${escapeHtml(item)}">
          <input type="checkbox" name="checked" ${checked ? 'checked' : ''} onchange="this.form.submit()">
          <span>${escapeHtml(item)}</span>
        </form>`;
      }).join('')}
    </div>
  </section>`;
}

function penNameCard(row) {
  const brand = parseJson(row.brand_details, {});
  const channels = parseJson(row.buffer_channels, {});
  const palette = parseJson(row.color_palette, {});
  const channelNames = Object.keys(channels);
  const linked = penNameLinkedCounts(row.id).reduce((sum, item) => sum + item.count, 0);
  return `<section class="card span-6 pen-card">
    <h2>${escapeHtml(row.display_name)}</h2>
    ${row.active ? '' : '<p class="pill">Inactive</p>'}
    <div class="brand-lines">
      <div><span class="tiny">Genre</span><strong>${escapeHtml(brand.genre || 'Not set')}</strong></div>
      <div><span class="tiny">Voice</span><strong>${escapeHtml(brand.voice || 'Not set')}</strong></div>
      <div><span class="tiny">Newsletter</span><strong>${row.email_octopus_list_id ? 'Connected' : 'Not connected'}</strong></div>
      <div><span class="tiny">Buffer</span><strong>${channelNames.length ? channelNames.map((name) => escapeHtml(name)).join(', ') : 'Not connected'}</strong></div>
    </div>
    ${penNameForm({ mode: 'edit', action: `/pen-names/${escapeHtml(row.id)}`, row })}
    <div class="action-row">
      ${row.active ? `<form method="post" action="/pen-names/${escapeHtml(row.id)}/retire" onsubmit="return confirm('Retire this pen name? It will disappear from normal dropdowns, but history stays intact.');"><button class="secondary" type="submit">Retire</button></form>` : `<form method="post" action="/pen-names/${escapeHtml(row.id)}/restore"><button class="secondary" type="submit">Restore</button></form>`}
      <form method="post" action="/pen-names/${escapeHtml(row.id)}/delete" onsubmit="return confirm('Permanently remove this pen name only if it has no linked records. Retire is safer. Continue?');">
        <button class="danger" type="submit">Remove</button>
      </form>
      <span class="tiny">${linked ? `${linked} linked records` : 'No linked records'}</span>
    </div>
    ${Object.keys(palette).length ? `<div class="swatches">${Object.entries(palette).map(([name, value]) => `<span title="${escapeHtml(name)}: ${escapeHtml(value)}" style="background:${escapeHtml(value)}"></span>`).join('')}</div>` : '<p class="muted">No palette saved.</p>'}
  </section>`;
}

function penNameForm({ mode, action, row = {} }) {
  const brand = parseJson(row.brand_details, {});
  const channels = parseJson(row.buffer_channels, {});
  const palette = parseJson(row.color_palette, {});
  const handles = parseJson(row.social_handles, {});
  const isAdd = mode === 'add';
  return `<form class="stack compact-form" method="post" action="${action}">
    <div class="row">
      <div class="field"><label>Name</label><input name="displayName" value="${escapeHtml(row.display_name || '')}" placeholder="Pen name" required></div>
      <div class="field"><label>Genre</label><input name="genre" value="${escapeHtml(brand.genre || '')}" placeholder="Romance, thriller, horror..."></div>
      <div class="field"><label>Voice</label><input name="voice" value="${escapeHtml(brand.voice || '')}" placeholder="lush, sharp, playful..."></div>
    </div>
    <div class="row">
      <div class="field"><label>EmailOctopus List ID</label><input name="emailOctopusListId" value="${escapeHtml(row.email_octopus_list_id || '')}" placeholder="List UUID"></div>
      <div class="field"><label>Amazon Ads Profile ID</label><input name="amazonAdsProfileId" value="${escapeHtml(row.amazon_ads_profile_id || '')}" placeholder="Profile ID"></div>
      <div class="field"><label>Website</label><input name="website" value="${escapeHtml(handles.website || '')}" placeholder="https://..."></div>
    </div>
    <div class="row">
      <div class="field"><label>Active</label><select name="active"><option value="1" ${row.active !== 0 ? 'selected' : ''}>Active</option><option value="0" ${row.active === 0 ? 'selected' : ''}>Inactive</option></select></div>
    </div>
    <div class="row">
      <div class="field"><label>Instagram Buffer ID</label><input name="bufferInstagram" value="${escapeHtml(channels.instagram || '')}"></div>
      <div class="field"><label>Threads Buffer ID</label><input name="bufferThreads" value="${escapeHtml(channels.threads || '')}"></div>
      <div class="field"><label>Bluesky Buffer ID</label><input name="bufferBluesky" value="${escapeHtml(channels.bluesky || '')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Instagram Handle</label><input name="handleInstagram" value="${escapeHtml(handles.instagram || '')}"></div>
      <div class="field"><label>Threads Handle</label><input name="handleThreads" value="${escapeHtml(handles.threads || '')}"></div>
      <div class="field"><label>Bluesky Handle</label><input name="handleBluesky" value="${escapeHtml(handles.bluesky || '')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Accent Color</label><input name="colorAccent" value="${escapeHtml(palette.accent || '')}" placeholder="#8b4a2f"></div>
      <div class="field"><label>Ink Color</label><input name="colorInk" value="${escapeHtml(palette.ink || '')}" placeholder="#1a1612"></div>
      <div class="field"><label>Paper Color</label><input name="colorPaper" value="${escapeHtml(palette.paper || '')}" placeholder="#faf8f5"></div>
    </div>
    <button>${isAdd ? 'Add Pen Name' : 'Save Pen Name'}</button>
  </form>`;
}

function newsletterStatsCard(pen, stats) {
  if (!pen.email_octopus_list_id) {
    return `<section class="card span-4"><h2>${escapeHtml(pen.display_name)}</h2><p class="metric">Off</p><p class="muted">Add this pen name's EmailOctopus List ID on the Pen Names page.</p></section>`;
  }
  if (!stats.configured && stats.missing === 'apiKey') {
    return `<section class="card span-4"><h2>${escapeHtml(pen.display_name)}</h2><p class="metric">Off</p><p class="muted">Add your EmailOctopus API key on the Settings page.</p><p class="tiny">List ID: ${escapeHtml(pen.email_octopus_list_id)}</p></section>`;
  }
  if (stats.error) {
    return `<section class="card span-4"><h2>${escapeHtml(pen.display_name)}</h2><p class="metric">Error</p><p class="muted">${escapeHtml(stats.error)}</p><p class="tiny">List ID: ${escapeHtml(pen.email_octopus_list_id)}</p></section>`;
  }
  const latest = stats.latestCampaign;
  const report = latest?.report;
  return `<section class="card span-4">
    <h2>${escapeHtml(pen.display_name)}</h2>
    <p class="metric">${Number(stats.subscriberCount || 0).toLocaleString()}</p>
    <p class="tiny">${escapeHtml(stats.listName || 'EmailOctopus list')} subscribers</p>
    <div class="brand-lines">
      <div><span class="tiny">List ID</span><strong>${escapeHtml(stats.listId || pen.email_octopus_list_id)}</strong></div>
      <div><span class="tiny">Pending / Unsubscribed</span><strong>${Number(stats.pendingCount || 0).toLocaleString()} / ${Number(stats.unsubscribedCount || 0).toLocaleString()}</strong></div>
      <div><span class="tiny">Latest sent campaign</span><strong>${latest ? `${escapeHtml(latest.subject || latest.name || 'Untitled')} (${escapeHtml(formatDateTime(latest.sentAt))})` : 'None found for this list'}</strong></div>
      ${report ? `<div><span class="tiny">Sent / Opens / Clicks</span><strong>${Number(report.sent || 0).toLocaleString()} / ${Number(report.opened?.unique || 0).toLocaleString()} / ${Number(report.clicked?.unique || 0).toLocaleString()}</strong></div>` : ''}
      ${latest?.reportError ? `<div><span class="tiny">Report</span><strong>${escapeHtml(latest.reportError)}</strong></div>` : ''}
    </div>
  </section>`;
}

function newsletterProjects() {
  return sqlite.prepare(`
    SELECT n.*, p.display_name AS pen_name
    FROM newsletter_projects n
    JOIN pen_names p ON p.id = n.pen_name_id
    ORDER BY n.updated_at DESC, n.id DESC
    LIMIT 40
  `).all();
}

function newsletterProjectById(id) {
  return sqlite.prepare(`
    SELECT n.*, p.display_name, p.brand_details, p.email_octopus_list_id,
      p.color_palette, p.fonts, p.social_handles
    FROM newsletter_projects n
    JOIN pen_names p ON p.id = n.pen_name_id
    WHERE n.id = ?
  `).get(id);
}

function newsletterMessages(projectId) {
  return sqlite.prepare('SELECT * FROM newsletter_messages WHERE project_id = ? ORDER BY id').all(projectId);
}

function newsletterUpcomingEvents(penNameId) {
  return sqlite.prepare(`
    SELECT * FROM calendar_events
    WHERE event_date BETWEEN ? AND ?
      AND (pen_name_id = ? OR pen_name_id IS NULL)
    ORDER BY event_date, COALESCE(event_time, ''), id
    LIMIT 30
  `).all(todayIso(), addDaysIso(todayIso(), 90), penNameId);
}

function newsletterProjectForm() {
  return `<form class="stack" method="post" action="/newsletter/projects">
    <div class="field"><label>Pen Name</label><select name="penNameId" required>${options(allPenNames(), '')}</select></div>
    <div class="field"><label>Workspace Name</label><input name="title" placeholder="July reader letter"></div>
    <div class="field"><label>Starting Topic</label><input name="topic" placeholder="Release update, behind the scenes, a personal note..."></div>
    <button>Open Newsletter Workspace</button>
  </form>`;
}

function newsletterProjectTable(rows) {
  if (!rows.length) return '<p class="muted">No newsletter conversations yet.</p>';
  return `<table><thead><tr><th>Workspace</th><th>Pen</th><th>Draft</th><th>Updated</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><a href="/newsletter/projects/${escapeHtml(row.id)}"><strong>${escapeHtml(row.title)}</strong></a><br><span class="tiny">${escapeHtml(row.topic || '')}</span></td>
      <td>${escapeHtml(row.pen_name || '')}</td>
      <td>${row.draft_text || row.draft_html ? '<span class="pill">Shaped</span>' : '<span class="tiny">Planning</span>'}</td>
      <td>${escapeHtml(formatDateTime(row.updated_at))}</td>
      <td><form method="post" action="/newsletter/projects/${escapeHtml(row.id)}/delete" onsubmit="return confirm('Delete this newsletter workspace and its conversation?');"><button class="danger">Delete</button></form></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function newsletterWorkspaceView(project, messages) {
  const provider = getSetting('OPENROUTER_API_KEY')
    ? 'OpenRouter Claude: Haiku chat, Sonnet draft'
    : getSetting('ANTHROPIC_API_KEY') ? 'Direct Claude fallback' : 'Add an OpenRouter key in Settings';
  const contextBooks = allBooks().filter((book) => String(book.pen_name_id || '') === String(project.pen_name_id));
  const upcoming = newsletterUpcomingEvents(project.pen_name_id).slice(0, 8);
  return `<div class="newsletter-workspace">
    <section class="card newsletter-chat-card">
      <div class="section-title-row">
        <div><h2>${escapeHtml(project.title)}</h2><p class="muted">${escapeHtml(project.display_name)} &middot; ${escapeHtml(project.topic || 'Open planning')}</p></div>
        <a class="button secondary" href="/newsletter">All Workspaces</a>
      </div>
      <div class="newsletter-chat" id="newsletter-chat" aria-live="polite">
        ${messages.length ? messages.map(newsletterMessageBubble).join('') : '<div class="newsletter-empty"><strong>Start anywhere.</strong><p class="muted">Tell Claude what has been happening, what you might want readers to feel, or what you absolutely do not want this newsletter to become.</p></div>'}
      </div>
      <form class="newsletter-chat-form" id="newsletter-chat-form" method="post" action="/newsletter/projects/${escapeHtml(project.id)}/messages">
        <textarea name="message" id="newsletter-message" placeholder="Talk through the newsletter with Claude..." required></textarea>
        <div class="section-title-row newsletter-composer-row"><span class="tiny" id="newsletter-provider">${escapeHtml(provider)}</span><button id="newsletter-send">Send</button></div>
      </form>
    </section>
    <aside class="newsletter-side">
      <section class="card side-card">
        <h2>Shape the Draft</h2>
        <p class="muted">When the angle feels right, Claude will turn this conversation into the finished newsletter.</p>
        <form method="post" action="/newsletter/projects/${escapeHtml(project.id)}/draft"><button data-shape-newsletter>${project.draft_text || project.draft_html ? 'Regenerate From Conversation' : 'Shape Newsletter Draft'}</button></form>
        ${project.draft_provider ? `<p class="tiny">Last shaped with ${escapeHtml(project.draft_provider)}.</p>` : ''}
      </section>
      <section class="card side-card"><h2>Project Context</h2>
        <p class="tiny">Claude can see this pen name's brand voice, books, statuses, and the next 90 days of calendar entries.</p>
        <div class="newsletter-context-list">
          ${contextBooks.slice(0, 10).map((book) => `<div><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.status || '')}${book.planned_release ? ` &middot; ${escapeHtml(book.planned_release)}` : ''}</span></div>`).join('') || '<p class="muted">No books linked yet.</p>'}
          ${upcoming.map((event) => `<div><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.event_date)} &middot; ${escapeHtml(event.event_type)}</span></div>`).join('')}
        </div>
      </section>
    </aside>
  </div>
  ${project.draft_text || project.draft_html ? newsletterProjectDraft(project) : ''}
  ${newsletterWorkspaceScript()}`;
}

function newsletterMessageBubble(message) {
  const role = message.role === 'user' ? 'user' : 'assistant';
  return `<div class="newsletter-message ${role}" data-message-id="${escapeHtml(message.id)}"><span class="newsletter-role">${role === 'user' ? 'You' : 'Claude'}</span><div>${escapeHtml(message.content).replaceAll('\n', '<br>')}</div></div>`;
}

function newsletterProjectDraft(project) {
  const previewId = `newsletter-preview-${project.id}`;
  return `<section class="card newsletter-draft" id="newsletter-draft">
    <div class="section-title-row"><div><h2>Newsletter Draft</h2><p class="muted">Edit anything here and save before copying it into EmailOctopus.</p></div><span class="pill">${escapeHtml(project.draft_provider || 'Draft')}</span></div>
    ${project.draft_warning ? `<p class="notice">${escapeHtml(project.draft_warning)}</p>` : ''}
    <form class="stack" method="post" action="/newsletter/projects/${escapeHtml(project.id)}/draft/save">
      <div class="row"><div class="field"><label>Subject</label><input name="subject" value="${escapeHtml(project.draft_subject || '')}"></div><div class="field"><label>Preview Text</label><input name="preview" value="${escapeHtml(project.draft_preview || '')}"></div></div>
      <div class="field"><label>Editable Text</label><textarea class="copybox" name="text">${escapeHtml(project.draft_text || '')}</textarea></div>
      ${project.draft_html ? `<div class="newsletter-live-editor">
        <div class="field newsletter-html-editor"><label>EmailOctopus HTML</label><textarea class="copybox htmlbox" name="html" data-newsletter-html data-preview-target="${previewId}">${escapeHtml(project.draft_html)}</textarea></div>
        <div class="newsletter-preview-panel">
          <div class="newsletter-preview-toolbar">
            <div class="preview-switch" role="group" aria-label="Preview size">
              <button type="button" class="active" data-preview-size="desktop" data-preview-target="${previewId}" aria-pressed="true">Desktop</button>
              <button type="button" data-preview-size="mobile" data-preview-target="${previewId}" aria-pressed="false">Mobile</button>
            </div>
            <span class="tiny" data-preview-status>Live preview</span>
          </div>
          <div class="newsletter-preview-stage"><iframe id="${previewId}" class="newsletter-preview" sandbox srcdoc="${escapeAttr(project.draft_html)}"></iframe></div>
        </div>
      </div>` : '<input type="hidden" name="html" value="">'}
      <button>Save Draft Changes</button>
    </form>
  </section>`;
}

function newsletterWorkspaceScript() {
  return `<script>
  (() => {
    const form = document.getElementById('newsletter-chat-form');
    const chat = document.getElementById('newsletter-chat');
    const input = document.getElementById('newsletter-message');
    const button = document.getElementById('newsletter-send');
    if (form && chat && input && button) {
      const addBubble = (role, text, extraClass = '') => {
        const bubble = document.createElement('div');
        bubble.className = 'newsletter-message ' + role + (extraClass ? ' ' + extraClass : '');
        const label = document.createElement('span');
        label.className = 'newsletter-role';
        label.textContent = role === 'user' ? 'You' : 'Claude';
        const body = document.createElement('div');
        body.textContent = text;
        bubble.append(label, body);
        chat.appendChild(bubble);
        chat.scrollTop = chat.scrollHeight;
        return bubble;
      };
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text || button.disabled) return;
        const empty = chat.querySelector('.newsletter-empty');
        if (empty) empty.remove();
        addBubble('user', text);
        input.value = '';
        input.disabled = true;
        button.disabled = true;
        button.textContent = 'Thinking...';
        const thinking = addBubble('assistant', 'Claude is thinking...', 'thinking');
        try {
          const response = await fetch(form.action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ message: text })
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || 'Claude could not respond.');
          thinking.querySelector('div').textContent = data.message.content;
          thinking.classList.remove('thinking');
        } catch (error) {
          thinking.querySelector('div').textContent = 'Could not get a reply: ' + error.message;
          thinking.classList.remove('thinking');
          thinking.classList.add('error');
        } finally {
          input.disabled = false;
          button.disabled = false;
          button.textContent = 'Send';
          input.focus();
          chat.scrollTop = chat.scrollHeight;
        }
      });
    }
    document.querySelectorAll('[data-shape-newsletter]').forEach((shapeButton) => {
      shapeButton.closest('form')?.addEventListener('submit', () => {
        shapeButton.disabled = true;
        shapeButton.textContent = 'Claude is shaping the draft...';
      });
    });
    document.querySelectorAll('[data-newsletter-html]').forEach((editor) => {
      const preview = document.getElementById(editor.dataset.previewTarget);
      const status = editor.closest('.newsletter-live-editor')?.querySelector('[data-preview-status]');
      if (!preview) return;
      let previewTimer;
      editor.addEventListener('input', () => {
        if (status) status.textContent = 'Updating...';
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
          preview.srcdoc = editor.value;
          if (status) status.textContent = 'Preview updated';
        }, 220);
      });
    });
    document.querySelectorAll('[data-preview-size]').forEach((sizeButton) => {
      sizeButton.addEventListener('click', () => {
        const preview = document.getElementById(sizeButton.dataset.previewTarget);
        if (!preview) return;
        const group = sizeButton.closest('.preview-switch');
        group?.querySelectorAll('[data-preview-size]').forEach((button) => {
          const selected = button === sizeButton;
          button.classList.toggle('active', selected);
          button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
        preview.classList.toggle('mobile', sizeButton.dataset.previewSize === 'mobile');
      });
    });
  })();
  </script>`;
}

function newsletterDraftView(draft) {
  const hasHtml = Boolean(draft.html);
  return `<section class="card">
    <h2>Newsletter Draft</h2>
    ${draft.subject ? `<p><strong>Subject:</strong> ${escapeHtml(draft.subject)}</p>` : ''}
    ${draft.preview ? `<p><strong>Preview:</strong> ${escapeHtml(draft.preview)}</p>` : ''}
    ${draft.warning ? `<p class="muted">Generator note: ${escapeHtml(draft.warning)}</p>` : ''}
    <div class="row">
      <a class="button secondary" href="/newsletter">Back</a>
    </div>
  </section>
  <section class="card">
    <h2>Editable Text</h2>
    <textarea class="copybox">${escapeHtml(draft.text || '')}</textarea>
  </section>
  ${hasHtml ? `<section class="card"><h2>EmailOctopus HTML</h2><p class="muted">Copy this into the EmailOctopus HTML editor.</p><textarea class="copybox htmlbox">${escapeHtml(draft.html)}</textarea></section>
  <section class="card"><h2>Rendered Preview</h2><iframe class="newsletter-preview" sandbox srcdoc="${escapeAttr(draft.html)}"></iframe></section>` : ''}`;
}

function manuscriptUploadForm() {
  return `<form class="stack" method="post" action="/kdp-manuscripts/upload" enctype="multipart/form-data">
    <div class="field"><label>Book</label><select name="bookId" required><option value="">Choose a book</option>${options(allBooks(), '', { value: 'id', label: 'title' })}</select></div>
    <div class="field"><label>Manuscript</label><input type="file" name="manuscript" accept=".docx,.epub,.pdf,.txt,.md,.html,.htm" required></div>
    <label class="check-inline"><input type="checkbox" name="force" value="1"> Reanalyze even if this file is unchanged</label>
    <p class="tiny">The manuscript text is sent to Claude for analysis. The original file is not retained by Author HQ. A novel uses several Claude calls and API credits.</p>
    <button data-analysis-submit>Analyze Manuscript</button>
  </form>${analysisSubmitScript()}`;
}

function manuscriptFolderForm() {
  return `<form class="stack" method="post" action="/kdp-manuscripts/folder" enctype="multipart/form-data">
    <div class="field"><label>Book</label><select name="bookId" required><option value="">Choose a book</option>${options(allBooks(), '', { value: 'id', label: 'title' })}</select></div>
    <div class="field"><label>Chapter Folder</label><input type="file" name="chapters" webkitdirectory directory multiple required></div>
    <label class="check-inline"><input type="checkbox" name="force" value="1"> Reanalyze even if these chapters are unchanged</label>
    <p class="tiny">Readable chapter files are naturally sorted by filename. Unsupported files are ignored. A novel uses several Claude calls and API credits.</p>
    <button data-analysis-submit>Analyze Chapter Folder</button>
  </form>${analysisSubmitScript()}`;
}

function analysisSubmitScript() {
  return `<script>
    document.currentScript?.previousElementSibling?.addEventListener('submit', (event) => {
      const button = event.currentTarget.querySelector('[data-analysis-submit]');
      if (button) { button.disabled = true; button.textContent = 'Preparing analysis...'; }
    });
  </script>`;
}

function manuscriptAnalysesTable(rows) {
  if (!rows.length) return '<p class="muted">No manuscript briefs yet.</p>';
  return `<table><thead><tr><th>Book</th><th>Source</th><th>Words</th><th>Chapters</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><strong>${escapeHtml(row.book_title)}</strong><br><span class="tiny">${escapeHtml(row.pen_name || '')}</span></td>
      <td>${escapeHtml(row.source_name)}</td>
      <td>${Number(row.word_count || 0).toLocaleString()}</td>
      <td>${Number(row.chapter_count || 1).toLocaleString()}</td>
      <td><span class="pill">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(formatDateTime(row.updated_at))}</td>
      <td><a class="button secondary" href="/kdp-manuscripts/${escapeHtml(row.id)}">${row.status === 'Processing' ? 'View Progress' : 'Review Brief'}</a></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function manuscriptAnalysisView(row) {
  if (row.status === 'Processing') {
    return `<section class="card"><h2>Analyzing ${escapeHtml(row.book_title)}</h2><p class="muted">Claude is reading the manuscript in sections and building an evidence-based book brief. Long manuscripts can take several minutes.</p><div class="progress indeterminate"><span></span></div><p class="tiny">You can leave this page; analysis continues while Author HQ stays open.</p><p><a class="button secondary" href="/kdp-listings">Back to KDP Listings</a></p></section><script>setTimeout(() => location.reload(), 5000)</script>`;
  }
  if (row.status === 'Error') {
    return `<section class="card"><h2>Analysis Could Not Finish</h2><p class="muted">${escapeHtml(row.error_message || 'Unknown analysis error.')}</p><p><a class="button secondary" href="/kdp-listings">Back and Try Again</a></p></section>`;
  }
  const brief = effectiveManuscriptBrief(row);
  const warnings = parseJson(row.extraction_warnings, []);
  return `<section class="card">
    <div class="section-title-row"><div><h2>${escapeHtml(row.book_title)} Manuscript Brief</h2><p class="muted">${Number(row.word_count || 0).toLocaleString()} extracted words &middot; ${Number(row.chapter_count || 1).toLocaleString()} ${Number(row.chapter_count || 1) === 1 ? 'file' : 'chapter files'} &middot; ${escapeHtml(brief.analysis_meta?.coverage || '')}</p></div><div class="action-row"><a class="button" href="/kdp-listings?bookId=${escapeHtml(row.book_id)}">Generate Packet</a><a class="button secondary" href="/kdp-listings">Back</a></div></div>
    ${warnings.length ? `<div class="notice">${warnings.map((warning) => escapeHtml(warning)).join('<br>')}</div>` : ''}
    <p>${escapeHtml(brief.summary || '')}</p>
    ${manuscriptConfidenceGrid(brief)}
  </section>
  <section class="card">
    <h2>Review Positioning</h2>
    <p class="muted">Author HQ prefilled these fields from the manuscript. Correct only what needs author judgment; saved corrections take priority during packet generation.</p>
    ${manuscriptReviewForm(row, brief)}
  </section>`;
}

function manuscriptConfidenceGrid(brief) {
  const facts = [
    ['Positioning', brief.positioning],
    ['Emotional Promise', brief.emotional_promise],
    ['Tone', brief.tone],
    ['Heat / Darkness', brief.heat_darkness],
    ['Ending', brief.ending_type],
    ['Target Reader', brief.target_reader]
  ];
  return `<div class="grid">${facts.map(([label, fact]) => `<article class="release-card span-6"><div class="release-head"><strong>${escapeHtml(label)}</strong><span class="pill">${escapeHtml(fact?.confidence || 'unrated')}</span></div><p>${escapeHtml(factValue(fact))}</p>${fact?.evidence ? `<p class="tiny">${escapeHtml(fact.evidence)}</p>` : ''}</article>`).join('')}</div>`;
}

function manuscriptReviewForm(row, brief) {
  return `<form class="stack" method="post" action="/kdp-manuscripts/${escapeHtml(row.id)}/review">
    <div class="row"><div class="field"><label>Primary Positioning</label><input name="positioning" value="${escapeHtml(factValue(brief.positioning))}"></div><div class="field"><label>Alternate Positioning</label><input name="alternatePositioning" value="${escapeHtml(brief.positioning?.alternate || '')}"></div></div>
    <div class="row"><div class="field"><label>Genres / Subgenres</label><textarea name="genres">${escapeHtml(factList(brief.genres).join('\n'))}</textarea></div><div class="field"><label>Tropes</label><textarea name="tropes">${escapeHtml(factList(brief.tropes).join('\n'))}</textarea></div></div>
    <div class="row"><div class="field"><label>Emotional Promise</label><textarea name="emotionalPromise">${escapeHtml(factValue(brief.emotional_promise))}</textarea></div><div class="field"><label>Target Reader</label><textarea name="targetReader">${escapeHtml(factValue(brief.target_reader))}</textarea></div></div>
    <div class="row"><div class="field"><label>Tone</label><input name="tone" value="${escapeHtml(factValue(brief.tone))}"></div><div class="field"><label>Heat / Darkness</label><input name="heatDarkness" value="${escapeHtml(factValue(brief.heat_darkness))}"></div><div class="field"><label>Ending Type</label><input name="endingType" value="${escapeHtml(factValue(brief.ending_type))}"></div></div>
    <div class="row"><div class="field"><label>Distinctive Hooks</label><textarea name="differentiators">${escapeHtml(listValue(brief.differentiators).join('\n'))}</textarea></div><div class="field"><label>Searchable Concepts</label><textarea name="searchableConcepts">${escapeHtml(listValue(brief.searchable_concepts).join('\n'))}</textarea></div></div>
    <div class="row"><div class="field"><label>Emphasize</label><textarea name="recommendedEmphasis">${escapeHtml(brief.recommended_emphasis || '')}</textarea></div><div class="field"><label>Do Not Promise</label><textarea name="avoidPromises">${escapeHtml(listValue(brief.avoid_promises).join('\n'))}</textarea></div></div>
    <textarea name="reviewerNotes" placeholder="Optional author notes for future packet generations">${escapeHtml(brief.reviewer_notes || '')}</textarea>
    <button>Save Reviewed Brief</button>
  </form>`;
}

function manuscriptReviewFromBody(body) {
  return {
    positioning: { primary: body.positioning || '', alternate: body.alternatePositioning || '', confidence: 'author confirmed', evidence: 'Reviewed by author.' },
    genres: lines(body.genres).map((value) => ({ value, confidence: 'author confirmed', evidence: 'Reviewed by author.' })),
    tropes: lines(body.tropes).map((value) => ({ value, confidence: 'author confirmed', evidence: 'Reviewed by author.' })),
    emotional_promise: { value: body.emotionalPromise || '', confidence: 'author confirmed', evidence: 'Reviewed by author.' },
    target_reader: { value: body.targetReader || '', confidence: 'author confirmed', evidence: 'Reviewed by author.' },
    tone: { value: body.tone || '', confidence: 'author confirmed', evidence: 'Reviewed by author.' },
    heat_darkness: { value: body.heatDarkness || '', confidence: 'author confirmed', evidence: 'Reviewed by author.' },
    ending_type: { value: body.endingType || '', confidence: 'author confirmed', evidence: 'Reviewed by author.' },
    differentiators: lines(body.differentiators),
    searchable_concepts: lines(body.searchableConcepts),
    recommended_emphasis: body.recommendedEmphasis || '',
    avoid_promises: lines(body.avoidPromises),
    reviewer_notes: body.reviewerNotes || ''
  };
}

function factValue(value) {
  return typeof value === 'object' && value ? value.primary || value.value || '' : String(value || '');
}

function factList(value) {
  return listValue(value).map(factValue).filter(Boolean);
}

function listValue(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function lines(value) {
  return String(value || '').split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function kdpListingForm({ selectedBookId = '', analyses = [] } = {}) {
  const penNames = allPenNames();
  const books = allBooks();
  const selectedBook = selectedBookId ? books.find((book) => String(book.id) === String(selectedBookId)) : null;
  const firstPen = selectedBook?.pen_name_id ? penNameById(selectedBook.pen_name_id) : penNames[0];
  const firstConfig = firstPen ? kdpGenreConfigForPen(firstPen.id) : null;
  const usableAnalyses = analyses.filter((row) => ['Complete', 'Reviewed'].includes(row.status));
  const selectedAnalysis = usableAnalyses.find((row) => String(row.book_id) === String(selectedBookId)) || null;
  return `<form class="stack" method="post" action="/kdp-listings">
    <div class="row">
      <div class="field"><label>Book</label><select name="bookId"><option value="">New / not in Books yet</option>${options(books, selectedBookId, { value: 'id', label: 'title' })}</select></div>
      <div class="field"><label>Pen Name</label><select name="penNameId" id="kdp-pen-select" onchange="applyKdpDefaults()">${kdpPenOptions(penNames, firstPen?.id || '')}</select></div>
      <div class="field"><label>Format</label><select name="format"><option value="ebook">ebook</option><option value="paperback">paperback</option><option value="hardcover">hardcover</option></select></div>
    </div>
    <div class="field"><label>Manuscript Brief</label><select name="manuscriptAnalysisId"><option value="">No manuscript brief - use manual inputs</option>${usableAnalyses.map((row) => `<option value="${escapeHtml(row.id)}" ${String(row.id) === String(selectedAnalysis?.id) ? 'selected' : ''}>${escapeHtml(row.book_title)} - ${escapeHtml(row.status)} (${Number(row.word_count || 0).toLocaleString()} words)</option>`).join('')}</select><span class="tiny">A reviewed brief is selected automatically when available.</span></div>
    <div class="row">
      <div class="field"><label>Title</label><input name="title" placeholder="Leave blank if selecting an existing book"></div>
      <div class="field"><label>Subtitle</label><input name="subtitle"></div>
      <div class="field"><label>Series Number</label><input name="seriesNumber" placeholder="1, 2, 3..."></div>
    </div>
    <div class="row">
      <div class="field"><label>Series Name</label><input name="seriesName" placeholder="Leave blank to use book series"></div>
      <div class="field"><label>Price USD</label><input name="priceUsd" id="kdp-price" value="${escapeHtml(firstConfig?.default_price_usd || '4.99')}"></div>
      <div class="field"><label>KDP Select / KU</label><select name="kuEnrolled" id="kdp-ku"><option value="1" ${firstConfig?.default_ku_enrolled ? 'selected' : ''}>Yes</option><option value="0" ${firstConfig?.default_ku_enrolled ? '' : 'selected'}>No</option></select></div>
    </div>
    <textarea name="blurbDraft" placeholder="Raw back-cover-style pitch or messy notes. The generator turns this into KDP-safe description HTML."></textarea>
    <textarea name="compTitles" placeholder="Comp titles/authors or tone references, optional"></textarea>
    <textarea name="targetCategories" placeholder="Manual category override, optional. One category path per line."></textarea>
    <div class="row">
      <div class="field"><label>AI Generated?</label><select name="aiGenerated" id="kdp-ai-generated"><option value="0">No</option><option value="1">Yes</option></select></div>
      <div class="field"><label>AI Assisted?</label><select name="aiAssisted" id="kdp-ai-assisted"><option value="1">Yes</option><option value="0">No</option></select></div>
      <div class="field"><label>Language</label><input name="language" value="English"></div>
      <div class="field"><label>Reading Age</label><input name="readingAge" value="18+"></div>
    </div>
    <input name="publicationRights" value="I own the copyright and hold necessary publishing rights">
    <p class="tiny">Pricing note: KDP's 70% royalty band is generally $2.99-$9.99. Anything outside that range may fall to 35%.</p>
    <p class="tiny bad">AI disclosure is a required confirmation. Check this every time before publishing.</p>
    <button>Generate Packet</button>
  </form>
  <script>
    function applyKdpDefaults() {
      const option = document.getElementById('kdp-pen-select')?.selectedOptions[0];
      if (!option) return;
      document.getElementById('kdp-price').value = option.dataset.price || '4.99';
      document.getElementById('kdp-ku').value = option.dataset.ku || '0';
      document.getElementById('kdp-ai-generated').value = option.dataset.aiGenerated || '0';
      document.getElementById('kdp-ai-assisted').value = option.dataset.aiAssisted || '1';
    }
    applyKdpDefaults();
  </script>`;
}

function kdpPenOptions(rows, selected = '') {
  return rows.map((row) => {
    const config = kdpGenreConfigForPen(row.id) || {};
    return `<option value="${escapeHtml(row.id)}" ${String(row.id) === String(selected) ? 'selected' : ''} data-price="${escapeHtml(config.default_price_usd || '4.99')}" data-ku="${escapeHtml(config.default_ku_enrolled || 0)}" data-ai-generated="${escapeHtml(config.ai_generated_default || 0)}" data-ai-assisted="${escapeHtml(config.ai_assisted_default ?? 1)}">${escapeHtml(row.display_name)}</option>`;
  }).join('');
}

function savedKdpListingsTable(rows) {
  if (!rows.length) return '<p class="muted">No KDP listing packets yet.</p>';
  return `<table><thead><tr><th>Title</th><th>Pen</th><th>Format</th><th>Status</th><th>Provider</th><th>Updated</th><th>Actions</th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><a href="/kdp-listings/${escapeHtml(row.id)}">${escapeHtml(row.title)}</a></td>
      <td>${escapeHtml(row.pen_name || '')}</td>
      <td>${escapeHtml(row.format)}</td>
      <td>${escapeHtml(row.status)}</td>
      <td>${escapeHtml(row.provider)}</td>
      <td>${escapeHtml(formatDateTime(row.updated_at))}</td>
      <td>
        <div class="action-row">
          <a class="button secondary" href="/kdp-listings/${escapeHtml(row.id)}">Open</a>
          <form method="post" action="/kdp-listings/${escapeHtml(row.id)}/regenerate" onsubmit="return confirm('Regenerate this packet using the current KDP rules and category filters?');">
            <button class="secondary" type="submit">Regenerate</button>
          </form>
        </div>
      </td>
    </tr>`).join('')}
  </tbody></table>`;
}

function categorySearchTable(rows) {
  if (!rows.length) return '<p class="muted">No category matches found.</p>';
  return table(['Category', 'Rating', 'Node ID', 'Rank #20 ABSR'], rows.map((row) => [row.path, row.overall_rating || '', row.node_id || '', row.rank20_absr || '']));
}

function kdpPacketView(row, packet) {
  const flatText = packetToFlatText(packet);
  return `<section class="card">
    <div class="section-title-row"><h2>${escapeHtml(row.title)}</h2><a class="button secondary" href="/kdp-listings">Back</a></div>
    <p class="tiny">${escapeHtml(row.pen_name || 'Unassigned')} - ${escapeHtml(row.format)} - generated by ${escapeHtml(row.provider)}</p>
    <div class="row">
      <button type="button" class="secondary" onclick="copyText('packet-all')">Copy All</button>
      <a class="button secondary" href="/kdp-listings/${escapeHtml(row.id)}/text">Export .txt</a>
      <form method="post" action="/kdp-listings/${escapeHtml(row.id)}/regenerate" onsubmit="return confirm('Regenerate this packet using the current KDP rules and category filters?');">
        <button class="secondary" type="submit">Regenerate</button>
      </form>
    </div>
    <textarea id="packet-all" class="copybox">${escapeHtml(flatText)}</textarea>
  </section>
  <section class="grid">
    ${copyField('Title', packet.title)}
    ${copyField('Subtitle', packet.subtitle || '')}
    ${copyField('Description HTML', packet.description_html || '', 'span-12 htmlbox')}
    ${(packet.description_options || []).map((option, index) => copyField(`Description Option ${index + 1} - ${titleCase(option.approach || '')}`, `${option.description_html || ''}\n\nWhy this angle: ${option.rationale || ''}`, 'span-4')).join('')}
    ${copyField('Keyword Slots', (packet.keywords || []).map((keyword, index) => `${index + 1}. ${keyword}`).join('\n'), 'span-6')}
    ${(packet.keyword_sets || []).map((set, index) => copyField(`Keyword Set - ${set.label || `Option ${index + 1}`}`, `${(set.keywords || []).map((keyword, keywordIndex) => `${keywordIndex + 1}. ${keyword}`).join('\n')}\n\n${set.rationale || ''}`, 'span-6')).join('')}
    ${copyField('Suggested Categories', (packet.categories_suggested || []).map((category, index) => `${index + 1}. ${category.path} [${category.rating || 'Unrated'}]\n${category.rationale || ''}`).join('\n\n'), 'span-6')}
    ${copyField('Category Strategy', categoryStrategyText(packet.category_strategy), 'span-12')}
    ${copyField('Pricing / KU / AI Disclosure', [
      `Price: $${packet.price_usd}`,
      packet.royalty_note || '',
      `KDP Select / KU: ${packet.ku_enrolled ? 'Yes' : 'No'}`,
      `AI generated: ${packet.ai_disclosure?.ai_generated ? 'Yes' : 'No'}`,
      `AI assisted: ${packet.ai_disclosure?.ai_assisted ? 'Yes' : 'No'}`
    ].join('\n'), 'span-6')}
    ${copyField('Warnings', (packet.warnings || []).map((warning) => `- ${warning}`).join('\n'), 'span-6')}
    ${copyField('Marketing Validation', marketingValidationText(packet.marketing_validation), 'span-6')}
  </section>
  <section class="card">
    <h2>Manual KDP Steps Still Required</h2>
    <ol>
      <li>Log into KDP and create the title manually.</li>
      <li>Upload manuscript and cover files.</li>
      <li>Paste in each generated field.</li>
      <li>Run the KDP Previewer check.</li>
      <li>Confirm AI disclosure toggles match this packet.</li>
      <li>Hit Publish.</li>
    </ol>
  </section>
  <script>
    function copyText(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.select();
      navigator.clipboard?.writeText(el.value);
    }
  </script>`;
}

function copyField(label, value, span = 'span-4') {
  const id = `copy-${slugify(label)}`;
  return `<section class="card ${span}">
    <div class="section-title-row"><h2>${escapeHtml(label)}</h2><button type="button" class="secondary" onclick="copyText('${id}')">Copy</button></div>
    <textarea id="${id}" class="copybox">${escapeHtml(value || '')}</textarea>
  </section>`;
}

function marketingValidationText(validation = {}) {
  if (!validation || typeof validation !== 'object' || !Object.keys(validation).length) return 'No separate validation report was generated.';
  return [
    validation.accuracy ? `Accuracy: ${validation.accuracy}` : '',
    validation.spoiler_safety ? `Spoiler safety: ${validation.spoiler_safety}` : '',
    validation.positioning_strength ? `Positioning: ${validation.positioning_strength}` : '',
    validation.keyword_coverage ? `Keyword coverage: ${validation.keyword_coverage}` : '',
    ...(validation.changes_made || []).map((item) => `Changed: ${item}`),
    ...(validation.warnings || []).map((item) => `Warning: ${item}`)
  ].filter(Boolean).join('\n');
}

function categoryStrategyText(strategy = {}) {
  return [
    strategy.summary || '',
    '',
    ...(strategy.no_ads_plan || []).map((item) => `- ${item}`),
    '',
    strategy.avoid ? `Avoid: ${strategy.avoid}` : '',
    strategy.manual_review ? `Review: ${strategy.manual_review}` : ''
  ].filter((line, index, arr) => line || arr[index - 1]).join('\n');
}

function formatDateTime(value) {
  if (!value) return 'no date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function expenseForm() {
  return `<form class="stack" method="post" action="/expenses">
    <div class="row"><div class="field"><label>Date</label><input name="date" type="date" value="${todayIso()}"></div><div class="field"><label>Vendor</label><input name="vendor" required></div><div class="field"><label>Amount</label><input name="amount" required></div></div>
    <div class="row"><div class="field"><label>Category</label><input name="category" value="Miscellaneous"></div><div class="field"><label>Pen Name</label><select name="penNameId"><option value="">General</option>${options(allPenNames(), '')}</select></div><div class="field"><label>Payment</label><input name="paymentMethod" value="Credit Card"></div></div>
    <label><input type="checkbox" name="recurring"> Recurring</label><textarea name="description" placeholder="Description"></textarea><textarea name="notes" placeholder="Notes"></textarea><button>Save Expense</button>
  </form>`;
}

function incomeForm() {
  return `<form class="stack" method="post" action="/income">
    <div class="row"><div class="field"><label>Date</label><input name="date" type="date" value="${todayIso()}"></div><div class="field"><label>Platform</label><input name="platform" value="Amazon KDP"></div><div class="field"><label>Type</label><input name="incomeType" value="Combined Payout"></div><div class="field"><label>Amount</label><input name="amount" required></div></div>
    <textarea name="notes" placeholder="Notes"></textarea><button>Save Income</button>
  </form>`;
}

function royaltyForm() {
  return `<form class="stack" method="post" action="/royalties">
    <div class="row"><div class="field"><label>Report Date</label><input name="reportDate" type="date" value="${todayIso()}"></div><div class="field"><label>Book</label><select name="bookId"><option value="">Match by title</option>${options(allBooks(), '', { value: 'id', label: 'title' })}</select></div></div>
    <div class="row"><div class="field"><label>Title</label><input name="title" placeholder="Used if no book selected"></div><div class="field"><label>Pen Name</label><select name="penNameId"><option value="">Use book pen name</option>${options(allPenNames(), '')}</select></div></div>
    <div class="row"><div class="field"><label>Paid Sales</label><input name="units" type="number" value="0"></div><div class="field"><label>Free Downloads</label><input name="freeUnits" type="number" value="0"></div><div class="field"><label>KENP Read</label><input name="kenpRead" type="number" value="0"></div><div class="field"><label>Royalty</label><input name="royalty" required></div><div class="field"><label>Currency</label><input name="currency" value="USD"></div></div>
    <div class="row"><div class="field"><label>Marketplace</label><input name="marketplace" placeholder="US, UK, CA"></div><div class="field"><label>Format</label><input name="format" placeholder="ebook, KU, paperback"></div></div>
    <textarea name="notes" placeholder="Notes"></textarea><button>Save Royalty Row</button>
  </form>`;
}

function royaltyImportForm() {
  return `<form class="stack" method="post" action="/royalties/import" enctype="multipart/form-data">
    <p class="muted">Upload a KDP royalty report as XLSX, CSV, or TSV. Paid sales, free promotion downloads, and KENP are tracked separately.</p>
    <div class="field"><label>Royalty Report</label><input type="file" name="royalties" accept=".xlsx,.xls,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values"></div>
    <div class="field"><label>KENP Rate</label><input name="kenpRate" inputmode="decimal" value="${DEFAULT_KENP_RATE}" placeholder="Optional, e.g. 0.00469"></div>
    <p class="tiny">Combined Sales is the source for paid copies. Orders Processed contributes only free downloads, preventing KDP's repeated order sheets from double-counting sales. Uses ${DEFAULT_KENP_RATE} for KENP unless overwritten.</p>
    <button>Import Royalty Report</button>
  </form>`;
}

function bookForm(book = {}) {
  const statuses = ['Planning','Drafting','Draft Complete','Editing','Editing Complete','Formatting','Cover Ready','Uploaded to KDP','Pre-order Live','Published'];
  return `<form class="stack" method="post" action="/books">
    ${book.id ? `<input type="hidden" name="id" value="${escapeHtml(book.id)}">` : ''}
    <div class="row"><div class="field"><label>Title</label><input name="title" value="${escapeHtml(book.title || '')}" required></div><div class="field"><label>Series</label><input name="series" value="${escapeHtml(book.series || '')}"></div><div class="field"><label>Pen Name</label><select name="penNameId"><option value="">Unassigned</option>${options(allPenNames(), book.pen_name_id || '')}</select></div></div>
    <div class="row"><div class="field"><label>Status</label><select name="status">${statuses.map((s) => `<option ${String(book.status || 'Planning') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="field"><label>Planned Release</label><input type="date" name="plannedRelease" value="${escapeHtml(book.planned_release || '')}"></div><div class="field"><label>Actual Release</label><input type="date" name="actualRelease" value="${escapeHtml(book.actual_release || '')}"></div></div>
    <div class="row"><div class="field"><label>Word Count</label><input name="wordCount" type="number" min="0" step="1" value="${escapeHtml(book.word_count || '')}" placeholder="72000"></div><div class="field"><label>Series Position</label><input name="seriesPosition" type="number" min="1" value="${escapeHtml(book.series_position || '')}"></div><div class="field"><label>Website Slug</label><input name="publicSlug" value="${escapeHtml(book.public_slug || '')}" placeholder="auto-generated from title if blank"></div></div>
    <div class="field"><label>Cover Image Path</label><input name="coverImage" value="${escapeHtml(book.cover_image || '')}" placeholder="images/book-cover.jpg"></div>
    <textarea name="blurb" placeholder="Public blurb used for website export and KDP packet drafts">${escapeHtml(book.blurb || '')}</textarea>
    <textarea name="notes" placeholder="Notes">${escapeHtml(book.notes || '')}</textarea><button>${book.id ? 'Save Changes' : 'Save Book'}</button>
  </form>`;
}

function goalsTable(rows) {
  return `<table><thead><tr><th>Goal</th><th>Pen</th><th>Category</th><th>Status</th><th>Target</th><th>Progress</th><th>Notes</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><strong>${escapeHtml(row.title)}</strong>${row.auto_label ? `<br><span class="pill">${escapeHtml(row.auto_label)}</span>` : ''}</td>
      <td>${escapeHtml(row.pen_name || 'All')}</td>
      <td>${escapeHtml(row.category || '')}</td>
      <td>${escapeHtml(row.status || '')}</td>
      <td>${escapeHtml(row.target_date || '')}</td>
      <td><strong>${escapeHtml(row.progress_display || `${row.progress || 0}%`)}</strong><div class="progress"><span style="width:${Math.max(0, Math.min(100, Number(row.progress || 0)))}%"></span></div></td>
      <td>${row.auto_note ? `<p class="tiny good">${escapeHtml(row.auto_note)}</p>` : ''}${row.notes ? `<p class="tiny">${escapeHtml(row.notes)}</p>` : ''}</td>
      <td><div class="action-row"><a class="button secondary" href="/goals/${escapeHtml(row.id)}/edit">Edit</a><form method="post" action="/goals/${escapeHtml(row.id)}/delete" onsubmit="return confirm('Remove this goal?');"><button class="danger">Remove</button></form></div></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function goalForm(goal = {}) {
  const action = goal.id ? `/goals/${escapeHtml(goal.id)}` : '/goals';
  const statuses = ['Active', 'Planned', 'In Progress', 'Complete', 'Paused'];
  return `<form class="stack" method="post" action="${action}">
    <div class="row"><div class="field"><label>Goal</label><input name="title" required value="${escapeHtml(goal.title || '')}"></div><div class="field"><label>Pen Name</label><select name="penNameId"><option value="">All</option>${options(allPenNames(), goal.pen_name_id || '')}</select></div><div class="field"><label>Category</label><input name="category" value="${escapeHtml(goal.category || 'General')}"></div></div>
    <div class="row"><div class="field"><label>Status</label><select name="status">${statuses.map((status) => `<option ${String(goal.status || 'Active') === status ? 'selected' : ''}>${status}</option>`).join('')}</select></div><div class="field"><label>Target Date</label><input type="date" name="targetDate" value="${escapeHtml(goal.target_date || '')}"></div><div class="field"><label>Progress %</label><input name="progress" type="number" min="0" max="100" value="${escapeHtml(goal.progress ?? 0)}"></div></div>
    <textarea name="notes" placeholder="Notes">${escapeHtml(goal.notes || '')}</textarea><button>${goal.id ? 'Save Goal' : 'Save Goal'}</button>
  </form>`;
}

function milestoneForm() {
  return `<form class="stack" method="post" action="/milestones">
    <div class="row"><div class="field"><label>Date</label><input type="date" name="date" value="${todayIso()}"></div><div class="field"><label>Marker</label><input name="emoji" value="*"></div><div class="field"><label>Title</label><input name="title" required></div><div class="field"><label>Pen Name</label><select name="penNameId"><option value="">All</option>${options(allPenNames(), '')}</select></div></div>
    <textarea name="description" placeholder="Description"></textarea><textarea name="notes" placeholder="Notes"></textarea><button>Save Milestone</button>
  </form>`;
}

function importInput(name, label) {
  const accept = name === 'royalties'
    ? '.xlsx,.xls,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values'
    : '.csv,.tsv,text/csv,text/tab-separated-values';
  return `<div class="field"><label>${escapeHtml(label)} ${name === 'royalties' ? 'Report' : 'CSV'}</label><input type="file" name="${escapeHtml(name)}" accept="${accept}"></div>`;
}

function settingsInput(key, label, settings) {
  return `<div class="field"><label>${escapeHtml(label)}</label><input name="${escapeHtml(key)}" value="${escapeHtml(settings[key] || '')}"></div>`;
}

function settingsTextarea(key, label, settings) {
  return `<div class="field"><label>${escapeHtml(label)}</label><textarea name="${escapeHtml(key)}" placeholder="Paste JSON here">${escapeHtml(settings[key] || '')}</textarea></div>`;
}

function subscriptionForm(row = {}) {
  const cycles = ['Monthly', 'Yearly', 'Quarterly', 'Weekly', 'One-time'];
  return `<form class="stack" method="post" action="/subscriptions">
    ${row.id ? `<input type="hidden" name="id" value="${escapeHtml(row.id)}">` : ''}
    <div class="row"><div class="field"><label>Service</label><input name="service" value="${escapeHtml(row.service || '')}" required></div><div class="field"><label>Category</label><input name="category" value="${escapeHtml(row.category || 'Software')}"></div><div class="field"><label>Billing Amount</label><input name="monthlyCost" inputmode="decimal" value="${escapeHtml(row.monthly_cost ?? '')}" required></div></div>
    <div class="row"><div class="field"><label>Billing Cycle</label><select name="billingCycle">${cycles.map((cycle) => `<option ${String(row.billing_cycle || 'Monthly') === cycle ? 'selected' : ''}>${cycle}</option>`).join('')}</select></div><div class="field"><label>Renewal Date</label><input type="date" name="renewalDate" value="${escapeHtml(row.renewal_date || '')}"></div><div class="field"><label>Payment</label><input name="paymentMethod" value="${escapeHtml(row.payment_method || 'Credit Card')}"></div></div>
    <label><input type="checkbox" name="active" ${row.id ? (row.active ? 'checked' : '') : 'checked'}> Active</label><textarea name="notes" placeholder="Notes">${escapeHtml(row.notes || '')}</textarea><button>${row.id ? 'Save Changes' : 'Save Subscription'}</button>
  </form>`;
}

function subscriptionsTable(rows) {
  if (!rows.length) return '<p class="muted">No subscriptions yet.</p>';
  return `<table><thead><tr><th>Service</th><th>Category</th><th>Billing</th><th>Monthly</th><th>Renewal</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><strong>${escapeHtml(row.service)}</strong></td>
      <td>${escapeHtml(row.category || '')}</td>
      <td>${money(row.monthly_cost)} ${escapeHtml(String(row.billing_cycle || '').toLowerCase())}</td>
      <td>${money(billingMonthlyEquivalent(row.monthly_cost, row.billing_cycle))}</td>
      <td>${escapeHtml(row.renewal_date || '')}</td>
      <td>${row.active ? '<span class="pill">Active</span>' : '<span class="pill">Paused</span>'}</td>
      <td><div class="action-row"><a class="button secondary" href="/subscriptions/${escapeHtml(row.id)}/edit">Edit</a><form method="post" action="/subscriptions/${escapeHtml(row.id)}/delete" onsubmit="return confirm('Remove this subscription?');"><button class="danger">Remove</button></form></div></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function contentForm() {
  return `<form class="stack" method="post" action="/content"><div class="row"><div class="field"><label>Pen Name</label><select name="penNameId">${options(allPenNames(), '')}</select></div><div class="field"><label>Platform</label><input name="platform" required></div><div class="field"><label>Scheduled For</label><input name="scheduledFor" type="datetime-local"></div></div><textarea name="content" required></textarea><input name="channelId" placeholder="Buffer channel ID, optional"><input name="status" value="draft"><label><input type="checkbox" name="verifiedLive"> Verified live</label><textarea name="notes" placeholder="Notes"></textarea><button>Save Post</button></form>`;
}

function newsletterForm() {
  return `<form class="stack" method="post" action="/newsletter"><div class="row"><div class="field"><label>Pen Name</label><select name="penNameId">${options(allPenNames(), '')}</select></div><div class="field"><label>Topic</label><input name="topic" placeholder="Monthly update"></div></div><textarea name="notes" placeholder="Launches, personal notes, links, book updates"></textarea><button>Draft Newsletter</button></form>`;
}

function adForm() {
  return `<form class="stack" method="post" action="/ads"><div class="row"><div class="field"><label>Campaign</label><input name="campaignName" required></div><div class="field"><label>Platform</label><select name="platform"><option>Amazon</option><option>Meta</option></select></div><div class="field"><label>Pen Name</label><select name="penNameId">${options(allPenNames(), '')}</select></div><div class="field"><label>Book</label><select name="bookId"><option value="">None</option>${options(allBooks(), '', { value: 'id', label: 'title' })}</select></div></div><div class="row"><div class="field"><label>Start</label><input type="date" name="dateStart"></div><div class="field"><label>End</label><input type="date" name="dateEnd"></div><div class="field"><label>Spend</label><input name="spend" value="0"></div><div class="field"><label>Revenue</label><input name="revenue" value="0"></div></div><div class="row"><div class="field"><label>Clicks</label><input name="clicks" type="number" value="0"></div><div class="field"><label>Conversions</label><input name="conversions" type="number" value="0"></div><div class="field"><label>Sales</label><input name="sales" type="number" value="0"></div><div class="field"><label>Profile ID</label><input name="profileId" placeholder="Amazon only, optional"></div></div><textarea name="notes" placeholder="Notes"></textarea><button>Save Ad Entry</button></form>`;
}

function amazonAdsImportForm() {
  const eligiblePens = allPenNames().filter((pen) => pen.display_name !== 'R.A. Lorne');
  return `<form class="stack" method="post" action="/ads/amazon/import" enctype="multipart/form-data">
    <p class="muted">Upload an Amazon Ads campaign performance export. Duplicate campaign/date/profile rows update instead of duplicating.</p>
    <div class="field"><label>Amazon Ads Report</label><input type="file" name="amazonAds" accept=".xlsx,.xls,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values" required></div>
    <div class="row"><div class="field"><label>Fallback Pen Name</label><select name="penNameId"><option value="">Match by Profile ID</option>${options(eligiblePens, '')}</select></div><div class="field"><label>Fallback Profile ID</label><input name="profileId" placeholder="Optional if the file lacks a profile column"></div></div>
    <button>Import Amazon Ads Report</button>
  </form>`;
}

function adIntegrationPanels() {
  const amazonUrl = getAmazonAdsAuthUrl();
  return `<div class="grid">
    <section class="span-6">
      <h2>Amazon Ads API</h2>
      <p class="muted">Reporting-only v1. Campaigns still stay in Amazon Ads; Author HQ ingests performance data here.</p>
      <div class="action-row">
        ${amazonAdsConfigured() ? `<a class="button secondary" href="${escapeHtml(amazonUrl || '/integrations/amazon-ads/start')}">Connect Amazon Ads</a>` : '<a class="button secondary" href="/settings">Add Amazon Ads credentials</a>'}
        ${amazonAdsConnected() ? '<a class="button secondary" href="/ads/amazon/profiles">Load Profiles</a>' : ''}
      </div>
      <p class="tiny">${amazonAdsConnected() ? 'Refresh token saved locally.' : 'Backend is ready; connect after Amazon approves the app. Report import works now.'}</p>
      ${amazonAdsConnected() ? amazonAdsPullForm() : ''}
    </section>
    <section class="span-6">
      <h2>Meta API</h2>
      <p class="muted">Manual entries and future API rows share the same ad table.</p>
      <p>${metaConfigured() ? `<a class="button secondary" href="${escapeHtml(getMetaAuthUrl())}">Connect Meta</a>` : '<a class="button secondary" href="/settings">Add Meta credentials</a>'}</p>
    </section>
  </div>`;
}

function amazonAdsPullForm() {
  const pens = allPenNames().filter((pen) => pen.amazon_ads_profile_id && pen.display_name !== 'R.A. Lorne');
  return `<form class="stack compact-form" method="post" action="/ads/amazon/pull">
    <div class="row">
      <div class="field"><label>Pen</label><select name="penNameId"><option value="">All mapped profiles</option>${options(pens, '')}</select></div>
      <div class="field"><label>Start</label><input type="date" name="startDate" value="${addDaysIso(todayIso(), -7)}"></div>
      <div class="field"><label>End</label><input type="date" name="endDate" value="${todayIso()}"></div>
    </div>
    <button class="secondary" ${pens.length ? '' : 'disabled'}>Pull Campaign Report</button>
    ${pens.length ? '' : '<p class="tiny">Add Amazon Ads Profile IDs to pen names before pulling API reports.</p>'}
  </form>`;
}

function adCopyForm() {
  return `<form class="stack" method="post" action="/ad-copy"><div class="row"><div class="field"><label>Pen Name</label><select name="penNameId">${options(allPenNames(), '')}</select></div><div class="field"><label>Book</label><select name="bookId"><option value="">None</option>${options(allBooks(), '', { value: 'id', label: 'title' })}</select></div><div class="field"><label>Platform</label><select name="platform"><option>Amazon</option><option>Meta</option></select></div></div><textarea name="angle" placeholder="Reader hook, trope, fear, desire, comparison, creative angle"></textarea><button>Draft Ad Copy</button></form>`;
}

function importCsvFiles(files) {
  const results = {};
  const specs = {
    books: importBooks,
    launchChecklists: importLaunchChecklists,
    goals: importGoals,
    milestones: importMilestones,
    expenses: importExpenses,
    income: importIncome,
    royalties: importRoyalties,
    subscriptions: importSubscriptions
  };
  Object.entries(specs).forEach(([key, importer]) => {
    const file = files[key]?.[0];
    if (!file) return;
    results[key] = key === 'royalties'
      ? importer(parseSpreadsheetRows(file.buffer, file.originalname), file.originalname)
      : importer(parseCsv(file.buffer.toString('utf8')));
  });
  return results;
}

function parseSpreadsheetRows(buffer, filename = '') {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return parseXlsx(buffer);
  return parseDelimited(buffer.toString('utf8'), filename);
}

function parseXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return workbook.SheetNames.flatMap((sheetName) => {
    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
    const headerIndex = findSpreadsheetHeaderIndex(rawRows);
    if (headerIndex < 0) return [];
    const headers = rawRows[headerIndex].map(normalizeHeader);
    return rawRows.slice(headerIndex + 1)
      .filter((row) => row.some((value) => String(value || '').trim()))
      .map((values) => {
        const out = { sourcesheet: sheetName };
        headers.forEach((header, index) => {
          if (header) out[header] = String(values[index] || '').trim();
        });
        return out;
      });
  });
}

function findSpreadsheetHeaderIndex(rows) {
  const likely = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    const hasTitle = headers.some((header) => ['title', 'booktitle', 'producttitle', 'asintitle'].includes(header));
    const hasRoyalty = headers.some((header) => ['royalty', 'royalties', 'royaltyearned', 'earnings', 'amount'].includes(header));
    const hasUnits = headers.some((header) => ['units', 'netunitssold', 'unitssold', 'paidunits', 'freeunits', 'quantity', 'sales', 'kenpread', 'kenppagesread'].includes(header) || header.includes('kenp'));
    return hasTitle && (hasRoyalty || hasUnits);
  });
  if (likely >= 0) return likely;
  return -1;
}

function parseDelimited(text, filename = '') {
  const firstLine = String(text || '').split(/\r?\n/).find((line) => line.trim()) || '';
  const delimiter = filename.toLowerCase().endsWith('.tsv') || firstLine.includes('\t') ? '\t' : ',';
  return parseCsv(text, delimiter);
}

function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim())) rows.push(row);
  const headers = rows.shift()?.map(normalizeHeader) || [];
  return rows.map((values) => {
    const out = {};
    headers.forEach((header, index) => {
      out[header] = String(values[index] || '').trim();
    });
    return out;
  });
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(row, names, fallback = '') {
  for (const name of names) {
    const value = row[normalizeHeader(name)];
    if (value != null && value !== '') return value;
  }
  return fallback;
}

function normalizeDate(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

function parseInteger(value) {
  return Number(String(value || '').replace(/[^0-9-]/g, '')) || 0;
}

function formatKenpRate(value) {
  return `$${Number(value || 0).toFixed(5)}`;
}

function royaltyIdentity(payload) {
  return {
    reportDate: payload.reportDate || todayIso(),
    title: String(payload.title || '').trim().toLowerCase(),
    marketplace: String(payload.marketplace || '').trim().toLowerCase(),
    format: String(payload.format || '').trim().toLowerCase(),
    currency: String(payload.currency || 'USD').trim().toUpperCase(),
    periodStart: payload.periodStart || '',
    periodEnd: payload.periodEnd || ''
  };
}

function isKenpFormat(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('kenp') || normalized.includes('kindle edition normalized page');
}

function royaltyMonth(value) {
  const date = normalizeDate(value);
  return date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : '';
}

function removeSupersededKenpRows(payload) {
  const month = royaltyMonth(payload.reportDate || payload.periodEnd || payload.periodStart);
  if (!month || !payload.title || !isKenpFormat(payload.format)) return 0;
  const result = sqlite.prepare(`
    DELETE FROM royalty_entries
    WHERE substr(report_date, 1, 7) = @month
      AND lower(title) = lower(@title)
      AND lower(COALESCE(marketplace, '')) = lower(COALESCE(@marketplace, ''))
      AND upper(COALESCE(currency, 'USD')) = upper(COALESCE(@currency, 'USD'))
      AND (lower(COALESCE(format, '')) LIKE '%kenp%' OR lower(COALESCE(format, '')) LIKE '%kindle edition normalized page%')
  `).run({
    month,
    title: payload.title,
    marketplace: payload.marketplace || '',
    currency: payload.currency || 'USD'
  });
  return result.changes || 0;
}

function upsertRoyaltyEntry(payload) {
  const identity = royaltyIdentity(payload);
  const existing = sqlite.prepare(`
    SELECT id FROM royalty_entries
    WHERE report_date = @reportDate
      AND lower(title) = @title
      AND lower(COALESCE(marketplace, '')) = @marketplace
      AND lower(COALESCE(format, '')) = @format
      AND upper(COALESCE(currency, 'USD')) = @currency
      AND COALESCE(period_start, '') = @periodStart
      AND COALESCE(period_end, '') = @periodEnd
    LIMIT 1
  `).get(identity);
  if (existing) {
    sqlite.prepare(`
      UPDATE royalty_entries SET
        platform=@platform,
        pen_name_id=@penNameId,
        book_id=@bookId,
        author=@author,
        units=@units,
        free_units=@freeUnits,
        kenp_read=@kenpRead,
        royalty=@royalty,
        source_file=@sourceFile,
        notes=@notes,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=@id
    `).run({ ...payload, id: existing.id });
    return 'updated';
  }
  sqlite.prepare(`
    INSERT INTO royalty_entries (period_start, period_end, report_date, platform, marketplace, pen_name_id, book_id, title, author, format, units, free_units, kenp_read, royalty, currency, source_file, notes)
    VALUES (@periodStart, @periodEnd, @reportDate, @platform, @marketplace, @penNameId, @bookId, @title, @author, @format, @units, @freeUnits, @kenpRead, @royalty, @currency, @sourceFile, @notes)
  `).run(payload);
  return 'inserted';
}

function importBooks(rows) {
  const stmt = sqlite.prepare(`
    INSERT INTO books (pen_name_id, title, series, series_position, word_count, public_slug, blurb, cover_image, status, planned_release, actual_release, draft_complete, editing_complete, cover_ready, formatted, uploaded_kdp, preorder_live, published_live, notes)
    VALUES (@penNameId, @title, @series, @seriesPosition, @wordCount, @publicSlug, @blurb, @coverImage, @status, @plannedRelease, @actualRelease, @draftComplete, @editingComplete, @coverReady, @formatted, @uploadedKdp, @preorderLive, @publishedLive, @notes)
  `);
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => {
      const title = pick(row, ['Title', 'Book Title']);
      if (!title) return;
      const pen = findPenName(pick(row, ['Pen Name', 'Pen']));
      stmt.run({
        penNameId: pen?.id || null,
        title,
        series: pick(row, ['Series']),
        seriesPosition: Number(pick(row, ['Series Position', 'Series Number'], '')) || null,
        wordCount: Math.max(0, Math.round(Number(String(pick(row, ['Word Count', 'Words', 'Published Words'], '0')).replaceAll(',', '')) || 0)),
        publicSlug: pick(row, ['Website Slug', 'Public Slug', 'Slug']) || slugify(title),
        blurb: pick(row, ['Blurb', 'Public Blurb', 'Description']),
        coverImage: pick(row, ['Cover Image', 'Cover Image Path', 'Website Cover']),
        status: pick(row, ['Status'], 'Planning'),
        plannedRelease: normalizeDate(pick(row, ['Planned Release'])),
        actualRelease: normalizeDate(pick(row, ['Actual Release'])),
        draftComplete: normalizeDate(pick(row, ['Draft Complete'])),
        editingComplete: normalizeDate(pick(row, ['Editing Complete'])),
        coverReady: normalizeDate(pick(row, ['Cover Ready'])),
        formatted: normalizeDate(pick(row, ['Formatted'])),
        uploadedKdp: normalizeDate(pick(row, ['Uploaded to KDP', 'Uploaded KDP'])),
        preorderLive: normalizeDate(pick(row, ['Pre-order Live', 'Preorder Live'])),
        publishedLive: normalizeDate(pick(row, ['Published / Live', 'Published Live'])),
        notes: pick(row, ['Notes'])
      });
    });
  });
  tx(rows);
  return rows.length;
}

function importAmazonAdsRows(rows, defaults = {}) {
  const fallbackPenId = defaults.penNameId || null;
  const fallbackProfileId = String(defaults.profileId || '').trim();
  const pensByProfile = new Map(allPenNames().filter((pen) => pen.amazon_ads_profile_id).map((pen) => [String(pen.amazon_ads_profile_id), pen]));
  const removeExisting = sqlite.prepare(`
    DELETE FROM ad_entries
    WHERE platform = 'Amazon'
      AND source = 'amazon_report'
      AND profile_id = @profileId
      AND campaign_name = @campaignName
      AND COALESCE(date_start, '') = COALESCE(@dateStart, '')
      AND COALESCE(date_end, '') = COALESCE(@dateEnd, '')
  `);
  const insert = sqlite.prepare(`
    INSERT INTO ad_entries (campaign_name, platform, source, pen_name_id, date_start, date_end, spend, clicks, conversions, sales, revenue, profile_id, external_id, notes)
    VALUES (@campaignName, 'Amazon', 'amazon_report', @penNameId, @dateStart, @dateEnd, @spend, @clicks, @conversions, @sales, @revenue, @profileId, @externalId, @notes)
  `);
  let upserted = 0;
  let skipped = 0;
  const tx = sqlite.transaction((items) => {
    items.forEach((rawRow) => {
      const row = normalizedImportRow(rawRow);
      const campaignName = pick(row, ['Campaign Name', 'Campaign', 'Campaigns', 'Name']);
      if (!campaignName) {
        skipped += 1;
        return;
      }
      const profileId = String(pick(row, ['Profile ID', 'ProfileId', 'Advertiser ID', 'Account ID'], fallbackProfileId) || '').trim();
      const dateStart = normalizeDate(pick(row, ['Date', 'Start Date', 'Date Start', 'Report Date']));
      const dateEnd = normalizeDate(pick(row, ['Date', 'End Date', 'Date End', 'Report Date'])) || dateStart;
      const matchedPen = profileId ? pensByProfile.get(profileId) : null;
      const payload = {
        campaignName,
        penNameId: matchedPen?.id || fallbackPenId,
        dateStart,
        dateEnd,
        spend: parseMoney(pick(row, ['Spend', 'Cost', 'Total Spend'], '0')),
        clicks: Number(pick(row, ['Clicks'], '0')) || 0,
        conversions: Number(pick(row, ['Orders', 'Purchases', 'Conversions'], '0')) || 0,
        sales: Number(pick(row, ['Orders', 'Purchases', 'Sales'], '0')) || 0,
        revenue: parseMoney(pick(row, ['Sales', 'Revenue', 'Total Sales', '14 Day Total Sales', '7 Day Total Sales'], '0')),
        profileId,
        externalId: pick(row, ['Campaign ID', 'CampaignId', 'Campaign Id']),
        notes: profileId ? `Amazon Ads profile ${profileId}` : 'Amazon Ads report import'
      };
      removeExisting.run(payload);
      insert.run(payload);
      upserted += 1;
    });
  });
  tx(rows);
  return { upserted, skipped };
}

function normalizedImportRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [normalizeHeader(key), value]));
}

function importLaunchChecklists(rows) {
  const stmt = sqlite.prepare(`
    INSERT INTO launch_checklists (book_id, book_title, item, checked, updated)
    VALUES (@bookId, @bookTitle, @item, @checked, @updated)
    ON CONFLICT(book_title, item) DO UPDATE SET checked=@checked, updated=@updated, updated_at=CURRENT_TIMESTAMP
  `);
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => {
      const bookTitle = pick(row, ['Book Title', 'Title']);
      const item = pick(row, ['Item', 'Checklist Item']);
      if (!bookTitle || !item) return;
      const book = sqlite.prepare('SELECT * FROM books WHERE lower(title) = lower(?)').get(bookTitle);
      stmt.run({ bookId: book?.id || null, bookTitle, item, checked: truthy(pick(row, ['Checked', 'Done'])), updated: normalizeDate(pick(row, ['Updated', 'Date'])) });
    });
  });
  tx(rows);
  return rows.length;
}

function importGoals(rows) {
  const stmt = sqlite.prepare(`
    INSERT INTO goals (pen_name_id, title, category, status, target_date, progress, notes)
    VALUES (@penNameId, @title, @category, @status, @targetDate, @progress, @notes)
  `);
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => {
      const title = pick(row, ['Goal', 'Title']);
      if (!title) return;
      const pen = findPenName(pick(row, ['Pen Name', 'Pen']));
      stmt.run({
        penNameId: pen?.id || null,
        title,
        category: pick(row, ['Category'], 'General'),
        status: pick(row, ['Status'], 'Active'),
        targetDate: normalizeDate(pick(row, ['Target Date', 'Due Date'])),
        progress: Number(pick(row, ['Progress', 'Progress %'], '0').replace('%', '')) || 0,
        notes: pick(row, ['Notes'])
      });
    });
  });
  tx(rows);
  return rows.length;
}

function importMilestones(rows) {
  const stmt = sqlite.prepare(`
    INSERT INTO milestones (date, emoji, title, description, notes, pen_name_id, pen_name_label)
    VALUES (@date, @emoji, @title, @description, @notes, @penNameId, @penNameLabel)
  `);
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => {
      const title = pick(row, ['Title']);
      if (!title) return;
      const label = pick(row, ['Pen Name', 'Pen'], 'All');
      const pen = findPenName(label);
      stmt.run({
        date: normalizeDate(pick(row, ['Date'], todayIso())),
        emoji: pick(row, ['Emoji', 'Marker'], '*'),
        title,
        description: pick(row, ['Description'], title),
        notes: pick(row, ['Notes']),
        penNameId: pen?.id || null,
        penNameLabel: pen?.display_name || label || 'All'
      });
    });
  });
  tx(rows);
  return rows.length;
}

function importExpenses(rows) {
  const stmt = sqlite.prepare(`
    INSERT INTO expenses (date, vendor, description, category, pen_name_id, payment_method, recurring, amount, receipt_saved, notes)
    VALUES (@date, @vendor, @description, @category, @penNameId, @paymentMethod, @recurring, @amount, @receiptSaved, @notes)
  `);
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => {
      const vendor = pick(row, ['Vendor']);
      if (!vendor) return;
      const pen = findPenName(pick(row, ['Pen Name', 'Pen']));
      stmt.run({
        date: normalizeDate(pick(row, ['Date'], todayIso())),
        vendor,
        description: pick(row, ['Description']),
        category: pick(row, ['Category'], 'Miscellaneous'),
        penNameId: pen?.id || null,
        paymentMethod: pick(row, ['Payment Method', 'Payment'], 'Credit Card'),
        recurring: truthy(pick(row, ['Recurring'])),
        amount: parseMoney(pick(row, ['Amount'], '0')),
        receiptSaved: pick(row, ['Receipt Saved'], 'No'),
        notes: pick(row, ['Notes'])
      });
    });
  });
  tx(rows);
  return rows.length;
}

function importIncome(rows) {
  const stmt = sqlite.prepare('INSERT INTO income (date, platform, income_type, amount, notes) VALUES (@date, @platform, @incomeType, @amount, @notes)');
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => {
      const amount = parseMoney(pick(row, ['Amount'], '0'));
      if (!amount) return;
      stmt.run({
        date: normalizeDate(pick(row, ['Date'], todayIso())),
        platform: pick(row, ['Platform'], 'Amazon KDP'),
        incomeType: pick(row, ['Income Type', 'Type'], 'Combined Payout'),
        amount,
        notes: pick(row, ['Notes'])
      });
    });
  });
  tx(rows);
  return rows.length;
}

function importRoyalties(rows, sourceFile = '', { kenpRate = 0 } = {}) {
  let imported = 0;
  const seen = new Set();
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => {
      const sourceSheet = pick(row, ['Source Sheet']);
      const sheetMode = royaltySheetMode(sourceSheet);
      if (sheetMode === 'skip') return;
      const title = pick(row, ['Title', 'Book Title', 'Product Title', 'Name', 'ASIN Title']);
      if (!title) return;
      const book = findBookByTitle(title);
      const author = pick(row, ['Author', 'Pen Name', 'Author Name']);
      const pen = findPenName(pick(row, ['Pen Name', 'Author', 'Author Name']));
      const periodEnd = normalizeDate(pick(row, ['Period End', 'End Date', 'Royalty Date', 'Date', 'Month']));
      const reportDate = normalizeDate(pick(row, ['Report Date', 'Royalty Date', 'Date', 'Month'], periodEnd || todayIso()));
      const paidUnits = parseInteger(pick(row, ['Paid Units'], '0'));
      const freeUnits = parseInteger(pick(row, ['Free Units'], '0'));
      const netUnits = parseInteger(pick(row, ['Net Units Sold', 'Units', 'Units Sold', 'Quantity', 'Sales'], '0'));
      const unitBreakdown = royaltyUnitBreakdown({ sourceSheet, netUnits, paidUnits, freeUnits });
      if (unitBreakdown.skip) return;
      const kenpRead = parseInteger(pick(row, ['KENP Read', 'KENP Pages Read', 'KENP', 'Pages Read', 'Kindle Edition Normalized Page (KENP) Read'], '0'));
      const format = unitBreakdown.mode === 'free-downloads'
        ? 'Free Promotion'
        : pick(row, ['Format', 'Transaction Type', 'Royalty Type', 'Type'], kenpRead ? 'KENP Read' : sourceSheet);
      const importedRoyalty = parseMoney(pick(row, ['Royalty', 'Royalties', 'Royalty Earned', 'Earnings', 'Amount'], '0'));
      const estimatedKenpRoyalty = !importedRoyalty && kenpRead && kenpRate ? Number((kenpRead * kenpRate).toFixed(4)) : 0;
      const notes = pick(row, ['Notes'], sourceSheet ? `Imported from ${sourceSheet}` : '');
      const finalizedKenpRoyalty = importedRoyalty && kenpRead && isKenpFormat(format);
      const payload = {
        periodStart: normalizeDate(pick(row, ['Period Start', 'Start Date'])),
        periodEnd,
        reportDate: reportDate || periodEnd || todayIso(),
        platform: pick(row, ['Platform', 'Storefront'], 'Amazon KDP'),
        marketplace: pick(row, ['Marketplace', 'Market', 'Store', 'Country']),
        penNameId: book?.pen_name_id || pen?.id || null,
        bookId: book?.id || null,
        title,
        author,
        format,
        units: unitBreakdown.paid,
        freeUnits: unitBreakdown.free,
        kenpRead,
        royalty: importedRoyalty || estimatedKenpRoyalty,
        currency: pick(row, ['Currency'], 'USD'),
        sourceFile,
        notes: finalizedKenpRoyalty
          ? `${notes}${notes ? '; ' : ''}Finalized KENP royalty`
          : estimatedKenpRoyalty ? `${notes}${notes ? '; ' : ''}Estimated KENP royalty at ${kenpRate} per page` : notes
      };
      const key = JSON.stringify(royaltyIdentity(payload));
      if (seen.has(key)) return;
      seen.add(key);
      if (finalizedKenpRoyalty) removeSupersededKenpRows(payload);
      upsertRoyaltyEntry(payload);
      imported += 1;
    });
  });
  tx(rows);
  return imported;
}

function importSubscriptions(rows) {
  const stmt = sqlite.prepare(`
    INSERT INTO subscriptions (service, category, monthly_cost, billing_cycle, renewal_date, payment_method, active, notes, annualized_cost)
    VALUES (@service, @category, @monthlyCost, @billingCycle, @renewalDate, @paymentMethod, @active, @notes, @annualizedCost)
  `);
  const tx = sqlite.transaction((items) => {
    items.forEach((row) => {
      const service = pick(row, ['Service', 'Name']);
      if (!service) return;
      const monthlyCost = parseMoney(pick(row, ['Monthly Cost', 'Amount', 'Cost'], '0'));
      const billingCycle = pick(row, ['Billing Cycle', 'Cycle'], 'Monthly');
      stmt.run({
        service,
        category: pick(row, ['Category'], 'Software'),
        monthlyCost,
        billingCycle,
        renewalDate: normalizeDate(pick(row, ['Renewal Date', 'Next Billing Date'])),
        paymentMethod: pick(row, ['Payment Method', 'Payment'], 'Credit Card'),
        active: truthy(pick(row, ['Active', 'Status'], 'Yes')) ? 1 : 0,
        notes: pick(row, ['Notes']),
        annualizedCost: billingMonthlyEquivalent(monthlyCost, billingCycle) * 12
      });
    });
  });
  tx(rows);
  return rows.length;
}

function truthy(value) {
  return ['true', 'yes', 'y', '1', 'active', 'checked', 'done'].includes(String(value || '').trim().toLowerCase()) ? 1 : 0;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFoundPage(label, backHref = '/', active = 'dashboard') {
  return layout(`${label} Not Found`, `
    <section class="card">
      <h2>${escapeHtml(label)} not found</h2>
      <p class="muted">It may have been removed or changed in another view.</p>
      <p><a class="button secondary" href="${escapeHtml(backHref)}">Go Back</a></p>
    </section>
  `, { active });
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers.host || `127.0.0.1:${process.env.PORT || 3131}`;
  return `${proto}://${host}`;
}
