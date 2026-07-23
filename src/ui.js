import { escapeHtml, money } from './utils.js';
import { getSetting } from './config.js';

export { escapeHtml, money };

export function layout(title, body, { active = 'dashboard' } = {}) {
  const navGroups = [
    {
      label: 'Command',
      items: [
        ['dashboard', '/', 'Dashboard'],
        ['life', '/life', 'Today'],
        ['journal', '/journal', 'Journal'],
        ['tasks', '/life/tasks', 'Open Loops'],
        ['routines', '/life/routines', 'Routines'],
        ['chat', '/chat', 'Log Chat'],
        ['briefing', '/briefing', 'Briefing'],
        ['books', '/books', 'Books'],
        ['launch', '/launch-checklists', 'Launch'],
        ['brain', '/brain', 'Brain'],
        ['calendar', '/calendar', 'Calendar']
      ]
    },
    {
      label: 'Business',
      items: [
        ['expenses', '/expenses', 'Expenses'],
        ['income', '/income', 'Income'],
        ['royalties', '/royalties', 'Royalties'],
        ['subscriptions', '/subscriptions', 'Subscriptions'],
        ['goals', '/goals', 'Goals'],
        ['milestones', '/milestones', 'Milestones']
      ]
    },
    {
      label: 'Marketing',
      items: [
        ['content', '/content', 'Content'],
        ['health', '/buffer-health', 'Social Health'],
        ['newsletter', '/newsletter', 'Newsletter'],
        ['ads', '/ads', 'Ads'],
        ['copy', '/ad-copy', 'Ad Copy']
      ]
    },
    {
      label: 'Publishing',
      items: [
        ['kdp', '/kdp-listings', 'KDP Listings'],
        ['exports', '/exports/books', 'Website Exports']
      ]
    },
    {
      label: 'System',
      items: [
        ['pen-names', '/pen-names', 'Pen Names'],
        ['import', '/import', 'Import'],
        ['settings', '/settings', 'Settings']
      ]
    }
  ];
  const flatNav = navGroups.flatMap((group) => group.items);
  const activeItem = flatNav.find(([key]) => key === active);
  const activeLabel = activeItem?.[2] || title || 'Dashboard';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const primaryActions = [
    ['Log Entry', '/chat'],
    ['Journal', '/journal'],
    ['Briefing', '/briefing'],
    ['Add Book', '/books'],
    ['Brain', '/brain'],
    ['Calendar', '/calendar'],
    ...(getSetting('CO_TEACHING_CREDITS_URL') ? [['Claim Credits', getSetting('CO_TEACHING_CREDITS_URL'), true]] : []),
    ['KDP Packet', '/kdp-listings'],
    ['Draft Newsletter', '/newsletter']
  ];

  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)} - Author HQ</title>
    <style>
      :root{--bg:#0d1018;--panel:#151b2b;--panel2:#101624;--line:#2a344b;--line2:#20283a;--ink:#f4f7ff;--muted:#9aa8c2;--quiet:#70809b;--accent:#e9556f;--accent2:#5ea3f2;--good:#33c27f;--warn:#e1b953;--bad:#ef6a5d;--input:#0f1421;--chip:#202840;--shadow:0 18px 40px rgba(0,0,0,.28)}
      *{box-sizing:border-box}
      body{margin:0;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--ink);letter-spacing:0}
      a{color:inherit}
      .app-shell{min-height:100vh;display:grid;grid-template-columns:248px minmax(0,1fr)}
      .sidebar{position:sticky;top:0;height:100vh;overflow:auto;background:#090d15;border-right:1px solid var(--line2);padding:22px 16px}
      .brand{display:grid;gap:4px;margin-bottom:24px;padding:0 8px}.brand-kicker{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);font-weight:800}.brand h1{font-size:22px;margin:0;line-height:1.1}.brand p{margin:0;color:var(--quiet);font-size:12px}
      .nav-group{display:grid;gap:7px;margin:0 0 22px}.nav-title{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#6f84aa;padding:0 8px;margin-bottom:2px}
      .nav-link{display:flex;align-items:center;justify-content:space-between;gap:10px;text-decoration:none;color:#c3cce0;padding:9px 10px;border:1px solid transparent;border-radius:7px;font-size:13px;line-height:1.2}
      .nav-link:hover{background:#111827;border-color:var(--line2);color:white}.nav-link.active{background:#1b2440;border-color:#314369;color:white;box-shadow:inset 3px 0 0 var(--accent2)}
      .nav-dot{width:6px;height:6px;border-radius:50%;background:transparent}.nav-link.active .nav-dot{background:var(--accent2)}
      .workspace{min-width:0}
      header{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:22px 28px;border-bottom:1px solid var(--line2);background:rgba(13,16,24,.92);backdrop-filter:blur(14px)}
      .page-title{display:grid;gap:4px}.page-title h1{font-size:22px;margin:0}.page-title p{margin:0;color:var(--muted);font-size:12px}
      .top-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.top-actions .button{padding:8px 11px;font-size:12px}
      main{max-width:1600px;margin:0 auto;padding:22px 28px;width:100%}
      .grid,.command-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}.span-3{grid-column:span 3}.span-4{grid-column:span 4}.span-5{grid-column:span 5}.span-6{grid-column:span 6}.span-7{grid-column:span 7}.span-8{grid-column:span 8}.span-9{grid-column:span 9}.span-12{grid-column:span 12}
      .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px;box-shadow:var(--shadow)}.card .card{box-shadow:none;background:var(--panel2)}
      .hero-panel{min-height:220px;display:grid;align-content:space-between}.summary-panel{display:grid;gap:16px;align-content:start;align-self:start}.side-card{padding:16px}.side-card h2{font-size:13px}
      .royalty-layout{grid-column:span 12;display:grid;grid-template-columns:minmax(0,2fr) minmax(360px,500px);gap:18px;align-items:start}.royalty-left,.royalty-right{display:grid;gap:18px;min-width:0}.royalty-form-card{min-width:0}.royalty-form-card textarea{min-height:86px}
      .dashboard-fit{height:calc(100vh - 126px);grid-template-rows:minmax(150px,.75fr) minmax(0,1fr);overflow:hidden}.dashboard-fit .card{min-height:0;overflow:hidden}.dashboard-fit .hero-panel{min-height:0}.dashboard-fit .dashboard-panel{display:grid;grid-template-rows:auto minmax(0,1fr);align-content:start}.dashboard-fit table{height:auto}.dashboard-fit th,.dashboard-fit td{padding:6px 8px;font-size:11px}.dashboard-fit .section-title-row{margin-bottom:8px}.dashboard-fit .release-list,.dashboard-fit .dashboard-runway{gap:8px}.dashboard-fit .release-card{padding:10px;min-height:0}.dashboard-fit .release-nudge{font-size:11px;padding:7px 9px;margin-top:7px}.dashboard-fit .button{padding:7px 9px;font-size:11px}
      h2{font-size:15px;margin:0 0 14px;letter-spacing:.04em}h3{font-size:13px;margin:0 0 8px;color:#cbd6ef}.muted{color:var(--muted)}
      .metric{font-size:28px;font-weight:800;letter-spacing:.02em}.tiny{font-size:12px;color:var(--muted)}.blue{color:var(--accent2)}.good{color:var(--good)}.bad{color:var(--bad)}
      .notice{border:1px solid #24583f;background:#10291f;color:#94e0ba;border-radius:7px;padding:8px 10px;font-size:12px}.quick-log-card{display:grid;grid-template-rows:auto auto minmax(0,auto) auto;gap:10px;align-content:start;position:relative}.quick-log-card .section-title-row{align-items:start}.quick-log-card textarea{min-height:78px}.log-entry-form{min-width:0}.quick-log-card .log-entry-form{gap:10px}.quick-log-card .log-entry-form>button{width:100%;min-height:36px;justify-self:stretch;margin:2px 0 4px;position:relative;z-index:1}.example-pills{display:flex;flex-wrap:wrap;gap:6px}.pill-button,.guide-example{border:1px solid var(--line);background:var(--chip);color:#c8d3e8;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:700}.guide-example{display:block;width:100%;text-align:left;border-radius:7px;background:#101827;margin:5px 0;line-height:1.35}.log-guide{border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:9px 10px;min-width:0;position:relative;z-index:0}.log-guide summary{cursor:pointer;font-size:12px;font-weight:800;color:#dce6ff}.log-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:11px}.log-guide-group h3{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#8fa2c8;margin:0 0 6px}.compact-guide .log-guide-grid{grid-template-columns:1fr;max-height:210px;overflow:auto;padding-right:3px}.dashboard-fit .quick-log-card{overflow:visible;z-index:6}.dashboard-fit .compact-guide[open]{position:absolute;left:16px;right:16px;top:calc(100% - 86px);z-index:20;box-shadow:0 18px 40px rgba(0,0,0,.45)}.dashboard-fit .compact-guide[open] .log-guide-grid{max-height:260px}
      .metric-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.challenge-metrics,.royalty-metrics{grid-template-columns:repeat(5,minmax(0,1fr))}.metric-tile{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:15px;display:grid;gap:8px}.metric-tile strong{font-size:26px;line-height:1}.metric-tile small{color:var(--muted);font-size:11px}.eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#8fa2c8;font-weight:800}
      .mode-switch{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}.mode-switch .button{padding:8px 11px;font-size:12px}
      .next-event-card{display:grid;gap:6px;align-self:end;background:#111a2d;border:1px solid #344260;border-left:4px solid var(--accent2);border-radius:8px;padding:13px 15px}.next-event-card strong{font-size:18px;line-height:1.2}.next-event-card small{color:#b8c5df;font-size:12px}
      .briefing-blocks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.briefing-blocks .next-event-card{align-self:stretch}
      .calendar-month-card{min-height:0}.calendar-month{display:grid;gap:10px}.calendar-month-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.calendar-month-head strong{display:block;font-size:20px;margin-top:3px}.month-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}.month-days-grid{overflow:visible}.month-grid.weekdays{background:transparent;border:0;gap:1px}.month-grid.weekdays div{background:#1b2236;color:#9eb0d1;text-transform:uppercase;letter-spacing:.12em;font-size:10px;font-weight:800;padding:7px 9px}.month-day{min-height:112px;background:var(--panel2);padding:8px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:6px;min-width:0;cursor:pointer;position:relative;transition:background .12s ease,box-shadow .12s ease}.month-day:hover{background:#141d30}.month-day.other-month{background:#0d1320;color:#65728b}.month-day.today{box-shadow:inset 0 0 0 2px var(--accent2)}.month-day.drop-target{background:#17263e;box-shadow:inset 0 0 0 2px var(--good)}.month-day-number{font-weight:800;font-size:12px;color:#dfe8fb}.month-events{display:grid;gap:4px;align-content:start;min-width:0}.month-events .month-event-link:nth-child(n+5){display:none}.month-day.show-all:hover{z-index:9}.month-day.show-all:hover .month-events{position:absolute;left:7px;right:7px;top:28px;background:#111a2b;border:1px solid var(--line);border-radius:8px;padding:7px;max-height:260px;overflow:auto;box-shadow:0 18px 42px rgba(0,0,0,.42)}.month-day.show-all:hover .month-events .month-event-link{display:block}.month-day.show-all:hover .month-more{display:none}.month-event-link{text-decoration:none;min-width:0;cursor:grab;touch-action:none;user-select:none}.month-event-link.dragging{opacity:.55}.month-event-link:active{cursor:grabbing}.month-event{display:block;border-left:3px solid var(--accent2);background:#172033;border-radius:6px;padding:4px 6px;color:#edf3ff;font-size:11px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.month-event small{display:block;color:#9eb0d1;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.month-event.type-co-teaching{border-left-color:var(--good)}.month-event.type-release{border-left-color:var(--accent)}.month-event.type-launch{border-left-color:var(--warn)}.month-event.type-newsletter{border-left-color:#b08cff}.month-event.type-goal{border-left-color:#6ec8ff}.drag-ghost{position:fixed;z-index:30;pointer-events:none;width:190px;opacity:.92;box-shadow:0 14px 30px rgba(0,0,0,.35)}.month-more{font-size:10px;color:var(--muted);padding-left:6px}
      .action-stack{display:grid;gap:10px}.dashboard-runway{display:grid;gap:16px}.runway-group{display:grid;gap:8px}.runway-group h3{margin:0;color:#edf3ff}.runway-group table{margin:0}
      table{width:100%;border-collapse:collapse;background:var(--panel2);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line2);font-size:12px;vertical-align:top}th{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#8fa2c8;background:#1b2236}tr:last-child td{border-bottom:0}
      form.stack{display:grid;gap:12px}.row{display:flex;gap:12px;flex-wrap:wrap}.field{display:grid;gap:5px;flex:1;min-width:min(190px,100%)}label{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#94a5c3}
      input,select,textarea{font:inherit;width:100%;max-width:100%;min-width:0;padding:10px 11px;border:1px solid var(--line);border-radius:7px;background:var(--input);color:var(--ink)}input[type="checkbox"]{width:auto;min-width:0;max-width:none;padding:0}textarea{min-height:116px;resize:vertical}
      input::placeholder,textarea::placeholder{color:#66758f}
      button,.button{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:7px;background:var(--accent);color:white;padding:10px 13px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}button:disabled{opacity:.6;cursor:wait}
      .button.secondary,button.secondary{background:#1b2438;border-color:#303c58;color:#edf3ff}button.danger,.button.danger{background:#8f2d36;color:white}.button:hover,button:hover{filter:brightness(1.07)}
      .icon-button{width:34px;height:34px;padding:0;flex:0 0 auto}
      .action-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.action-row form{margin:0}.action-row .button,.action-row button{padding:7px 9px;font-size:12px}
      .schedule-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}.schedule-row select,.schedule-row input[type="time"]{width:auto;min-width:120px}.check-inline{display:inline-flex;align-items:center;gap:7px;text-transform:none;letter-spacing:0;color:#dce6ff;font-size:12px}
      .kb-move-panel{margin-top:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);padding:10px}.kb-move-panel summary{cursor:pointer;font-size:12px;font-weight:800;color:#dce6ff}.kb-move-panel form{margin-top:10px}
      .review-filter{margin-top:14px;align-items:end}.review-filter .field{max-width:260px}.review-queue-panel{max-height:calc(100vh - 310px);overflow:auto}.review-queue-panel table{margin:0}
      .pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:11px;background:var(--chip);border:1px solid var(--line);color:#c8d3e8}
      .review-item-focus{display:grid;gap:10px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:14px;margin:0 0 14px}.review-item-focus h3{font-size:16px;margin:0;line-height:1.35}
      .chat{display:grid;gap:12px}.bubble{max-width:780px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:13px}.user{justify-self:end;background:#202036}.assistant{justify-self:start}
      .newsletter-workspace{display:grid;grid-template-columns:minmax(0,2fr) minmax(300px,.75fr);gap:18px;align-items:start}.newsletter-chat-card{display:grid;grid-template-rows:auto minmax(300px,calc(100vh - 410px)) auto;min-height:620px}.newsletter-chat{min-height:300px;max-height:calc(100vh - 390px);overflow:auto;display:grid;align-content:start;gap:12px;padding:14px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;scrollbar-gutter:stable}.newsletter-message{max-width:min(82%,760px);display:grid;gap:6px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.newsletter-message.user{justify-self:end;background:#202036}.newsletter-message.assistant{justify-self:start;background:#111a2b}.newsletter-message.error{border-color:#7b3338;background:#331d20;color:#ffb0b3}.newsletter-role{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#8fa2c8;font-weight:800}.newsletter-message.thinking div{color:var(--muted)}.newsletter-message.thinking div::after{content:'';display:inline-block;width:20px;height:8px;margin-left:7px;background:radial-gradient(circle closest-side,var(--accent2) 90%,transparent) 0 50%/6px 6px repeat-x;animation:newsletter-thinking .9s linear infinite}@keyframes newsletter-thinking{to{background-position:20px 50%}}.newsletter-empty{align-self:center;justify-self:center;text-align:center;max-width:540px;padding:26px}.newsletter-chat-form{display:grid;gap:10px;margin-top:12px}.newsletter-chat-form textarea{min-height:100px}.newsletter-composer-row{margin:0}.newsletter-side{display:grid;gap:18px}.newsletter-side form button{width:100%}.newsletter-context-list{display:grid;gap:0}.newsletter-context-list>div{display:grid;gap:3px;padding:9px 0;border-bottom:1px solid var(--line2)}.newsletter-context-list>div:last-child{border-bottom:0}.newsletter-context-list strong{font-size:12px}.newsletter-context-list span{font-size:11px;color:var(--muted)}.newsletter-draft{margin-top:18px;scroll-margin-top:100px}
      .checks{display:grid;gap:8px}.check-row{display:flex;gap:10px;align-items:center;justify-content:flex-start;padding:9px 0;border-bottom:1px solid var(--line2)}.check-row input[type="checkbox"]{flex:0 0 auto}.check-row span{flex:1;min-width:0}.check-row.done span{text-decoration:line-through;color:var(--quiet)}
      .progress{height:8px;background:#273048;border-radius:999px;overflow:hidden}.progress span{display:block;height:100%;background:var(--good)}.progress.indeterminate span{width:38%;background:var(--accent2);animation:analysis-progress 1.4s ease-in-out infinite}@keyframes analysis-progress{0%{transform:translateX(-110%)}100%{transform:translateX(290%)}}
      .kdp-generation-status{display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid #34557d;border-radius:7px;background:#111d31;color:#e8f2ff}.kdp-generation-status[hidden]{display:none}.kdp-generation-status strong{display:block;font-size:13px}.kdp-generation-status span:not(.kdp-spinner){display:block;margin-top:2px;font-size:11px;color:#9fb5d6}.kdp-generation-status.compact{margin-top:7px;padding:8px 9px;min-width:0;max-width:260px}.kdp-spinner{width:18px;height:18px;flex:0 0 auto;border:2px solid #415778;border-top-color:var(--accent2);border-radius:50%;animation:kdp-spin .8s linear infinite}@keyframes kdp-spin{to{transform:rotate(360deg)}}
      .pen-card{display:grid;gap:14px;align-content:start}.brand-lines{display:grid;gap:10px}.brand-lines div{display:grid;gap:3px}.brand-lines strong{font-size:13px;line-height:1.35;font-weight:650}
      .swatches{display:flex;gap:8px;align-items:center}.swatches span{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
      .compact-form{gap:8px}.compact-form button{justify-self:start}.stack-page,.release-list{display:grid;gap:12px}.section-title-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.section-title-row h2{margin:0}
      .status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:7px;vertical-align:-1px}.status-dot.healthy{background:var(--good)}.status-dot.soon{background:var(--warn)}.status-dot.attention{background:var(--bad)}.status-dot.empty{background:#4a5367}
      .release-card{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:14px 16px}.release-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}.release-nudge{font-size:12px;padding:8px 10px;border-radius:6px;margin-top:8px}.release-nudge.ok{background:#102b22;border:1px solid #1d5a42;color:#8ee0b7}.release-nudge.warn{background:#302819;border:1px solid #705a24;color:#f1cd75}.release-nudge.urgent{background:#331d20;border:1px solid #7b3338;color:#ff999d}.nudge-count{float:right;border:1px solid currentColor;border-radius:999px;padding:0 5px;font-size:10px;opacity:.8}
      .copybox{width:100%;min-height:220px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5}.htmlbox{min-height:720px}.newsletter-live-editor{display:grid;grid-template-columns:minmax(0,1fr) minmax(420px,1fr);gap:16px;align-items:start}.newsletter-html-editor{min-width:0}.newsletter-preview-panel{min-width:0;position:sticky;top:100px}.newsletter-preview-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:7px}.preview-switch{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--panel2)}.preview-switch button{border:0;border-radius:0;background:transparent;color:var(--muted);padding:7px 11px;font-size:11px}.preview-switch button+button{border-left:1px solid var(--line)}.preview-switch button.active{background:#26324b;color:white}.newsletter-preview-stage{min-height:724px;display:flex;justify-content:center;align-items:flex-start;padding:0;background:#090d15;border:1px solid var(--line);border-radius:8px;overflow:auto}.newsletter-preview{display:block;width:100%;height:720px;border:0;background:#1a1212;transition:width .18s ease}.newsletter-preview.mobile{width:390px;max-width:100%}
      .modal-backdrop{position:fixed;inset:0;z-index:20;background:rgba(3,6,12,.72);display:grid;place-items:center;padding:24px}.modal-backdrop[hidden]{display:none}.modal-panel{width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px;box-shadow:0 30px 70px rgba(0,0,0,.45)}.modal-actions{margin-top:14px}.day-detail-list{display:grid;gap:10px}.day-detail-item{display:grid;gap:5px;border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:10px}.day-detail-item strong{font-size:13px}.day-detail-item small{color:var(--muted)}
      .journal-form{gap:14px}.journal-editor{min-height:360px;line-height:1.55}.journal-entry{border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:12px}.journal-entry h3{margin:0}
      code,pre{background:#0c111d;border:1px solid var(--line2);border-radius:6px;color:#dce6ff}pre{padding:12px;overflow:auto}
      @media(max-width:1100px){.metric-strip,.challenge-metrics,.royalty-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.briefing-blocks{grid-template-columns:1fr}.newsletter-live-editor{grid-template-columns:1fr}.newsletter-preview-panel{position:static}.htmlbox{min-height:480px}.month-day{min-height:92px}.month-event{font-size:10px}}
      @media(max-width:960px){.app-shell{grid-template-columns:1fr}.sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line2)}.nav-group{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));align-items:start}.nav-title{grid-column:1/-1}.top-actions{display:none}.span-3,.span-4,.span-5,.span-6,.span-7,.span-8,.span-9{grid-column:span 12}.royalty-layout,.newsletter-workspace{grid-template-columns:1fr}.newsletter-chat-card{min-height:560px}.newsletter-chat{max-height:560px}.dashboard-fit{height:auto;overflow:visible;grid-template-rows:none}main{padding:16px}header{position:static;padding:18px}}
      @media(max-width:620px){.metric-strip{grid-template-columns:1fr}.calendar-month-head{align-items:flex-start;flex-direction:column}.month-grid{overflow:auto}.month-day{min-width:112px}.newsletter-chat-card{padding:12px;min-height:520px}.newsletter-chat{padding:9px;max-height:480px}.newsletter-message{max-width:94%;padding:10px 11px}.newsletter-composer-row{align-items:stretch}.newsletter-composer-row button{width:100%}.newsletter-preview-toolbar{align-items:flex-start;flex-direction:column}.preview-switch{width:100%}.preview-switch button{flex:1}.newsletter-preview-stage{min-height:604px}.newsletter-preview{height:600px}}
    </style>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-kicker">Author HQ</div><h1>Command Center</h1><p>Local-first publishing operations</p></div>
        ${navGroups.map((group) => `<div class="nav-group"><div class="nav-title">${escapeHtml(group.label)}</div>${group.items.map(([key, href, label]) => `<a class="nav-link ${active === key ? 'active' : ''}" href="${href}"><span>${escapeHtml(label)}</span><span class="nav-dot"></span></a>`).join('')}</div>`).join('')}
      </aside>
      <div class="workspace">
        <header>
          <div class="page-title"><h1>${escapeHtml(activeLabel)}</h1><p>${escapeHtml(today)} - ${escapeHtml(title)}</p></div>
          <div class="top-actions">${primaryActions.map(([label, href, external]) => `<a class="button secondary" href="${href}" ${external ? 'target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>`).join('')}<a class="button secondary" href="/logout">Logout</a></div>
        </header>
        <main>${body}</main>
      </div>
    </div>
  </body>
  </html>`;
}

export function options(rows, selected, { value = 'id', label = 'display_name' } = {}) {
  return rows.map((row) => `<option value="${escapeHtml(row[value])}" ${String(row[value]) === String(selected) ? 'selected' : ''}>${escapeHtml(row[label])}</option>`).join('');
}

export function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}
