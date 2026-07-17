import { generateWithLlm } from './llmClient.js';
import { escapeHtml, parseJson } from '../utils.js';

const selenaAmazonUrl = 'https://www.amazon.com/stores/Selena-Monroe/author/B0H2GBB7Z4';
const selenaHeroUrl = 'https://lh3.googleusercontent.com/d/17q41lvThGW56VUTwG7eV4vAqS1m34bqA';

export async function chatNewsletterProject({ penName, topic, messages = [], books = [], upcomingEvents = [] }) {
  const brand = parseJson(penName?.brand_details, {});
  const penId = penName?.pen_name_id || penName?.id;
  const relevantBooks = books.filter((book) => !penId || String(book.pen_name_id || '') === String(penId));
  const context = relevantBooks.map((book) => `${book.title} | ${book.status} | release ${book.planned_release || book.actual_release || 'not set'} | ${book.series || 'standalone'}`).join('\n') || 'No books recorded for this pen name.';
  const events = upcomingEvents.map((event) => `${event.event_date}: ${event.title} (${event.event_type})`).join('\n') || 'No upcoming events recorded.';
  const system = `You are the collaborative newsletter room inside Author HQ. Work like a thoughtful Claude Project partner for ${penName?.display_name || 'the author'}.

Your job during conversation is to help the author discover what this newsletter wants to be before drafting it. Discuss possible angles, emotional through-lines, reader value, what to include or leave out, and useful calls to action. Ask one or two focused questions when information is missing. Give concrete suggestions without taking over. Do not force a polished newsletter unless the author explicitly asks for one; Author HQ has a separate Shape Newsletter Draft action.

Pen-name genre: ${brand.genre || 'not specified'}
Pen-name voice: ${brand.voice || 'clear, intimate, bookish'}
Workspace topic: ${topic || 'open newsletter planning'}

Current books:
${context}

Upcoming calendar context:
${events}`;
  return generateWithLlm({
    system,
    messages: messages.slice(-30),
    maxTokens: 1200,
    timeoutMs: 90000,
    providerPreference: 'openrouter_first',
    model: 'anthropic/claude-haiku-4.5'
  });
}

export async function draftNewsletter({ penName, topic, notes, books = [] }) {
  const penId = penName?.pen_name_id || penName?.id;
  const relevantBooks = penId ? books.filter((book) => String(book.pen_name_id || '') === String(penId)) : books;
  if (penName?.display_name === 'Selena Monroe') {
    return draftSelenaNewsletter({ topic, notes, books: relevantBooks });
  }

  const brand = parseJson(penName?.brand_details, {});
  const system = `Draft author newsletters. Preserve this pen name voice: ${brand.voice || 'clear, intimate, bookish'}.`;
  const prompt = `Pen name: ${penName?.display_name || 'Author'}
Genre/brand: ${brand.genre || 'author newsletter'}
Topic: ${topic || 'monthly update'}
Notes:
${notes || 'No notes supplied.'}

Return a subject line, preview text, and email body. Keep it useful and paste-ready for EmailOctopus.`;
  return generateWithLlm({ system, prompt, providerPreference: 'openrouter_first', model: 'anthropic/claude-sonnet-4.6', maxTokens: 2400 });
}

async function draftSelenaNewsletter({ topic, notes, books }) {
  const published = books.filter((book) => book.status === 'Published');
  const preorders = books.filter((book) => book.status === 'Pre-order Live');
  const inProgress = books.filter((book) => ['Drafting', 'Draft Complete', 'Editing', 'Editing Complete', 'Formatting', 'Cover Ready', 'Uploaded to KDP'].includes(book.status));
  const featuredBook = preorders[0] || published.at(-1) || null;
  const month = topic || new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const authorNote = notes?.trim() || 'No special note this month.';

  const system = 'You write short Selena Monroe newsletters in warm, intimate, slightly mysterious sapphic dark romantasy voice.';
  const prompt = `Write a monthly newsletter for Selena Monroe.

Current publishing status:
- Published: ${published.map((book) => `${book.title} (${book.series || 'no series'})`).join(', ') || 'None yet'}
- On pre-order: ${preorders.map((book) => `${book.title} - releases ${book.planned_release || 'soon'}`).join(', ') || 'None'}
- Currently writing: ${inProgress.map((book) => `${book.title} (${book.status})`).join(', ') || 'None'}

Month/topic: ${month}
Author note: ${authorNote}

Return ONLY JSON with these exact fields:
{"subject":"Subject line","preheader":"One-line preview text, 40-60 chars","sectionLabel":"From the Author","headline":"Short italic headline, max 8 words","paragraph1":"Opening paragraph","paragraph2":"Second paragraph","buttonText":"Read on Kindle Unlimited","buttonUrl":"${selenaAmazonUrl}","tropeTag1":"First trope tag","tropeTag2":"Second trope tag","tropeTag3":"Third trope tag"}`;

  const fallback = fallbackSelenaDraft({ month, authorNote, featuredBook });
  let parsed = fallback;
  let provider = 'fallback';
  try {
    const result = await generateWithLlm({ system, prompt, providerPreference: 'openrouter_first', model: 'anthropic/claude-sonnet-4.6', maxTokens: 2400 });
    provider = result.provider;
    if (result.provider !== 'prompt_only') {
      parsed = parseNewsletterJson(result.text) || fallback;
    }
  } catch (error) {
    parsed = { ...fallback, generationWarning: error.message };
  }

  const text = `${parsed.paragraph1}\n\n${parsed.paragraph2}`;
  const html = buildSelenaNewsletterHtml({
    ...parsed,
    bookCardHtml: featuredBook ? bookCardHtml(featuredBook, books) : '',
    tropeHtml: tropeHtml(parsed),
    heroUrl: selenaHeroUrl,
    amazonUrl: selenaAmazonUrl
  });

  return {
    provider,
    subject: parsed.subject || 'A note from Selena Monroe',
    preview: parsed.preheader || '',
    text,
    html,
    warning: parsed.generationWarning || ''
  };
}

function parseNewsletterJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

function fallbackSelenaDraft({ month, authorNote, featuredBook }) {
  const bookLine = featuredBook ? `${featuredBook.title} is ${featuredBook.status === 'Pre-order Live' ? 'waiting in the dark for release day' : 'available now'}.` : 'The next door is opening soon.';
  return {
    subject: `Selena Monroe - ${month}`,
    preheader: 'A dark little note from Selena Monroe',
    sectionLabel: 'From the Author',
    headline: 'Something stirs softly',
    paragraph1: `Hello, love. ${bookLine} This month has been full of small, stubborn progress and the kind of scenes that leave fingerprints.`,
    paragraph2: authorNote === 'No special note this month.' ? 'Thank you for being here while these books become real, one haunted little step at a time.' : authorNote,
    buttonText: 'Read on Kindle Unlimited',
    buttonUrl: selenaAmazonUrl,
    tropeTag1: 'Sapphic',
    tropeTag2: 'Dark Romantasy',
    tropeTag3: 'Possessive Devotion'
  };
}

function bookCardHtml(featuredBook, books) {
  const sameSeries = books.filter((book) => book.series === featuredBook.series);
  const seriesLabel = `${featuredBook.series || 'Selena Monroe'} - Book ${Math.max(1, sameSeries.findIndex((book) => book.id === featuredBook.id || book.title === featuredBook.title) + 1)}`;
  const cta = featuredBook.status === 'Pre-order Live' ? 'Pre-order now open' : 'Available now on Kindle Unlimited';
  const button = featuredBook.status === 'Pre-order Live' ? 'Pre-order' : 'Read Now';
  return '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 8px;background-color:#0d0b0b;border:1px solid #1e1414;">' +
    '<tr><td valign="top" style="padding:22px 24px;">' +
    `<p class="font-body" style="margin:0 0 3px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#B89A6A;">${escapeHtml(seriesLabel)}</p>` +
    `<h3 class="font-display" style="margin:0 0 10px;font-size:20px;font-weight:400;color:#f0e8d8;">${escapeHtml(featuredBook.title)}</h3>` +
    `<p class="font-body" style="margin:0 0 14px;font-size:13px;color:#9a7a5a;line-height:1.7;">${escapeHtml(cta)}</p>` +
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border:1px solid #B89A6A;">' +
    `<a href="${selenaAmazonUrl}" class="font-body" style="display:inline-block;padding:8px 18px;font-size:10px;font-weight:400;letter-spacing:0.25em;text-transform:uppercase;color:#B89A6A;text-decoration:none;background-color:transparent;">${button} &rarr;</a>` +
    '</td></tr></table></td></tr></table>';
}

function tropeHtml(parsed) {
  const tags = [parsed.tropeTag1, parsed.tropeTag2, parsed.tropeTag3].filter(Boolean);
  return tags.length
    ? `${tags.map((tag) => `&#10097;&nbsp; ${escapeHtml(tag)}`).join(' &nbsp;&nbsp;')} &nbsp;&nbsp;&#10097;&nbsp; Explicit 18+`
    : '&#10097;&nbsp; Sapphic &nbsp;&nbsp;&#10097;&nbsp; Dark Romantasy &nbsp;&nbsp;&#10097;&nbsp; Explicit 18+';
}

function buildSelenaNewsletterHtml(d) {
  const paragraph1 = escapeHtml(d.paragraph1 || '').replaceAll('\n', '<br>');
  const paragraph2 = escapeHtml(d.paragraph2 || '').replaceAll('\n', '<br>');
  return '<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta http-equiv="X-UA-Compatible" content="IE=edge"><title>Selena Monroe</title>' +
    '<style>@import url(\'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Jost:wght@300;400;500&display=swap\');' +
    'body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none;}body{margin:0!important;padding:0!important;background-color:#1a1212;width:100%!important;}.font-display{font-family:\'Cormorant Garamond\',Georgia,\'Times New Roman\',serif;}.font-body{font-family:\'Jost\',Helvetica,Arial,sans-serif;}@media only screen and (max-width:620px){.email-container{width:100%!important;}.mobile-pad{padding-left:20px!important;padding-right:20px!important;}.author-name-size{font-size:28px!important;}.headline-size{font-size:22px!important;}}</style></head>' +
    '<body style="margin:0;padding:0;background-color:#1a1212;">' +
    `<div style="display:none;font-size:1px;color:#1a1212;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(d.preheader || '')}</div>` +
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#1a1212;"><tr><td align="center" style="padding:24px 10px;">' +
    '<table role="presentation" class="email-container" cellspacing="0" cellpadding="0" border="0" width="600" style="background-color:#111010;border:1px solid #2e1a1a;">' +
    '<tr><td align="center" style="background-color:#111010;padding:36px 32px 28px;border-bottom:1px solid #7A1F2B;"><h1 class="author-name-size font-display" style="margin:0;font-size:38px;font-weight:300;letter-spacing:0.12em;color:#f0e8d8;line-height:1;">Selena Monroe</h1><p class="font-body" style="margin:10px 0 0;font-size:10px;font-weight:300;letter-spacing:0.25em;text-transform:uppercase;color:#7A1F2B;">Sapphic Dark Romantasy &nbsp;&middot;&nbsp; 18+</p></td></tr>' +
    '<tr><td align="center" style="background-color:#0d0b0b;border-bottom:1px solid #1e1414;padding:12px 32px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>' +
    '<td style="padding:0 10px;"><a href="https://selenamonroe.com/#books" class="font-body" style="font-size:10px;font-weight:400;letter-spacing:0.2em;text-transform:uppercase;color:#9a7a5a;text-decoration:none;">Books</a></td>' +
    '<td style="padding:0 10px;"><a href="https://selenamonroe.com" class="font-body" style="font-size:10px;font-weight:400;letter-spacing:0.2em;text-transform:uppercase;color:#9a7a5a;text-decoration:none;">About</a></td>' +
    `<td style="padding:0 10px;"><a href="${selenaAmazonUrl}" class="font-body" style="font-size:10px;font-weight:400;letter-spacing:0.2em;text-transform:uppercase;color:#9a7a5a;text-decoration:none;">Amazon</a></td>` +
    '</tr></table></td></tr>' +
    `<tr><td style="background-color:#1a0e0e;border-bottom:1px solid #1e1414;padding:0;line-height:0;"><a href="${selenaAmazonUrl}"><img src="${d.heroUrl}" alt="Selena Monroe" width="600" style="display:block;width:100%;max-width:600px;height:auto;background-color:#1a0e0e;"></a></td></tr>` +
    '<tr><td class="mobile-pad" style="padding:36px 40px 28px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:16px;"><tr>' +
    `<td class="font-body" style="font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:#7A1F2B;white-space:nowrap;padding-right:12px;width:1%;">${escapeHtml(d.sectionLabel || 'From the Author')}</td><td style="border-top:1px solid #1e1414;"></td></tr></table>` +
    `<h2 class="headline-size font-display" style="margin:0 0 20px;font-size:28px;font-weight:300;font-style:italic;color:#f0e8d8;line-height:1.35;letter-spacing:0.02em;">${escapeHtml(d.headline || '')}</h2>` +
    `<p class="font-body" style="margin:0 0 14px;font-size:14px;font-weight:300;color:#c4a882;line-height:1.85;">${paragraph1}</p>` +
    `<p class="font-body" style="margin:0 0 14px;font-size:14px;font-weight:300;color:#c4a882;line-height:1.85;">${paragraph2}</p>` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:28px auto;"><tr><td style="border:1px solid #7A1F2B;"><a href="${escapeAttr(d.buttonUrl || selenaAmazonUrl)}" class="font-body" style="display:inline-block;padding:13px 36px;font-size:11px;font-weight:400;letter-spacing:0.3em;text-transform:uppercase;color:#f0e8d8;text-decoration:none;background-color:transparent;">${escapeHtml(d.buttonText || 'Read on Kindle Unlimited')}</a></td></tr></table>` +
    (d.bookCardHtml || '') +
    `<p class="font-body" style="margin:20px 0 0;font-size:12px;font-weight:300;color:#7a5a3a;line-height:2;">${d.tropeHtml}</p>` +
    '</td></tr><tr><td align="center" style="background-color:#0d0b0b;border-top:1px solid #1e1414;border-bottom:1px solid #1e1414;padding:18px 32px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr>' +
    '<td style="padding:0 10px;"><a href="https://www.instagram.com/selena.monroe.books/" class="font-body" style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#9a7a5a;text-decoration:none;">Instagram</a></td>' +
    '<td style="padding:0 10px;"><a href="https://www.threads.com/@selena.monroe.books" class="font-body" style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#9a7a5a;text-decoration:none;">Threads</a></td>' +
    `<td style="padding:0 10px;"><a href="${selenaAmazonUrl}" class="font-body" style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#9a7a5a;text-decoration:none;">Amazon</a></td>` +
    '</tr></table></td></tr><tr><td align="center" style="background-color:#0d0b0b;padding:24px 32px 28px;"><p class="font-display" style="margin:0 0 14px;font-size:18px;font-weight:300;letter-spacing:0.2em;color:#5a3a3a;">Selena Monroe</p><p class="font-body" style="margin:0 0 10px;font-size:10px;letter-spacing:0.1em;color:#3a2a2a;line-height:1.8;"><a href="{{UnsubscribeURL}}" style="color:#5a3a3a;text-decoration:underline;text-decoration-color:#3a2a2a;">Unsubscribe</a> &nbsp;&middot;&nbsp; <a href="{{RewardsURL}}" style="color:#5a3a3a;text-decoration:underline;text-decoration-color:#3a2a2a;">Powered by EmailOctopus</a> &nbsp;&middot;&nbsp; <a href="" style="color:#5a3a3a;text-decoration:underline;text-decoration-color:#3a2a2a;">View in browser</a></p><p class="font-body" style="margin:0 0 10px;font-size:10px;color:#3a2a2a;letter-spacing:0.05em;line-height:1.7;">{{SenderInfo}}</p><p class="font-body" style="margin:0 0 12px;font-size:10px;color:#3a2a2a;line-height:1.6;">&copy; 2026 Selena Monroe &nbsp;&middot;&nbsp; All rights reserved</p></td></tr></table></td></tr></table></body></html>';
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
