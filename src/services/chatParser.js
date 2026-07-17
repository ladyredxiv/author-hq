import { billingMonthlyEquivalent, parseMoney, todayIso } from '../utils.js';

const bookStatuses = ['Planning', 'Drafting', 'Draft Complete', 'Editing', 'Editing Complete', 'Formatting', 'Cover Ready', 'Uploaded to KDP', 'Pre-order Live', 'Published'];

export function parseLogText(text, { penNames = [], books = [] } = {}) {
  const lower = text.toLowerCase();
  if (looksLikeLifeTask(lower)) return parseLifeTask(text);
  if (looksLikeLifeRoutine(lower)) return parseLifeRoutine(text);
  if (looksLikeLifeLog(lower)) return parseLifeLog(text);
  if (looksLikeWeeklySummary(lower)) return parseWeeklySummary(text);
  if (looksLikeSubscription(lower)) return parseSubscription(text);
  if (looksLikeIncome(lower)) return parseIncome(text);
  if (looksLikeBook(lower, books)) return parseBook(text, { penNames, books });
  if (looksLikeMilestone(lower)) return parseMilestone(text);
  return parseExpense(text, { penNames });
}

function looksLikeWeeklySummary(lower) {
  return lower.includes('weekly summary') ||
    lower.includes('week summary') ||
    lower.includes('end of week') ||
    lower.startsWith('this week ') ||
    lower.startsWith('week recap');
}

function looksLikeLifeTask(lower) {
  return lower.startsWith('task:') ||
    lower.startsWith('todo:') ||
    lower.startsWith('to do:') ||
    lower.startsWith('open loop:') ||
    lower.startsWith('remind me') ||
    lower.startsWith('need to ');
}

function looksLikeLifeRoutine(lower) {
  return lower.startsWith('routine:') ||
    lower.startsWith('recurring:') ||
    lower.startsWith('every week ') ||
    lower.startsWith('weekly routine');
}

function looksLikeLifeLog(lower) {
  return lower.startsWith('life log:') ||
    lower.startsWith('life:') ||
    lower.startsWith('note:') ||
    lower.includes('migraine') ||
    lower.includes(' tired') ||
    lower.includes(' burned out') ||
    lower.includes('burnt out');
}

function looksLikeSubscription(lower) {
  return ['subscription', 'monthly', 'yearly', 'annual', 'renew', 'cancel ', 'pause ', 'change '].some((word) => lower.includes(word)) &&
    ['claude', 'chatgpt', 'sudowrite', 'buffer', 'carrd', 'namecheap', 'subscription', 'hosting', 'domain'].some((word) => lower.includes(word));
}

function looksLikeIncome(lower) {
  return ['payout', 'royalt', 'income', 'earned', 'kdp'].some((word) => lower.includes(word)) && /\$?\d/.test(lower);
}

function looksLikeBook(lower, books) {
  return bookStatuses.some((status) => lower.includes(status.toLowerCase())) ||
    lower.includes('new book') ||
    books.some((book) => lower.includes(String(book.title).toLowerCase()));
}

function looksLikeMilestone(lower) {
  return ['first ', 'hit ', 'review', 'subscriber', 'milestone', 'launched'].some((word) => lower.includes(word));
}

function parseExpense(text) {
  const amount = findAmount(text);
  return {
    type: 'expense',
    date: todayIso(),
    vendor: firstVendor(text),
    description: text,
    category: inferCategory(text),
    paymentMethod: text.toLowerCase().includes('paypal') ? 'PayPal' : 'Credit Card',
    recurring: /recurring|monthly|yearly|annual/.test(text.toLowerCase()),
    amount,
    receiptSaved: 'No',
    notes: ''
  };
}

function parseIncome(text) {
  return {
    type: 'income',
    date: todayIso(),
    platform: text.toLowerCase().includes('kdp') || text.toLowerCase().includes('amazon') ? 'Amazon KDP' : 'Other',
    incomeType: text.toLowerCase().includes('royalt') ? 'Royalties' : 'Combined Payout',
    amount: findAmount(text),
    notes: text
  };
}

function parseSubscription(text) {
  const lower = text.toLowerCase();
  const cycle = lower.includes('year') || lower.includes('annual') ? 'Yearly' :
    lower.includes('quarter') ? 'Quarterly' :
    lower.includes('week') ? 'Weekly' : 'Monthly';
  const active = !(lower.includes('cancel') || lower.includes('pause'));
  const monthlyCost = findAmount(text);
  return {
    type: 'subscription',
    service: inferService(text),
    category: lower.includes('domain') || lower.includes('hosting') || lower.includes('carrd') ? 'Website' : 'Software',
    monthlyCost,
    billingCycle: cycle,
    renewalDate: findDate(text),
    paymentMethod: lower.includes('paypal') ? 'PayPal' : 'Credit Card',
    active,
    notes: text,
    annualizedCost: annualized(monthlyCost, cycle)
  };
}

function parseBook(text, { books }) {
  const lower = text.toLowerCase();
  const known = books.find((book) => lower.includes(String(book.title).toLowerCase()));
  const status = bookStatuses.find((candidate) => lower.includes(candidate.toLowerCase())) || null;
  const wordMatch = /([\d,]+)\s*words?\b/i.exec(text);
  return {
    type: 'book',
    title: known?.title || inferTitle(text),
    status,
    wordCount: wordMatch ? Number(wordMatch[1].replaceAll(',', '')) : null,
    notes: text
  };
}

function parseMilestone(text) {
  return {
    type: 'milestone',
    date: todayIso(),
    title: text.slice(0, 80),
    description: text,
    notes: ''
  };
}

function parseWeeklySummary(text) {
  return {
    type: 'weekly-summary',
    weekEnding: todayIso(),
    summary: text.replace(/^(weekly summary|week summary|end of week|week recap)\s*:?\s*/i, '').trim() || text
  };
}

function parseLifeTask(text) {
  const cleaned = text.replace(/^(task|todo|to do|open loop)\s*:?\s*/i, '').replace(/^remind me\s+(to\s+)?/i, '').trim();
  const lower = text.toLowerCase();
  return {
    type: 'life-task',
    title: cleaned || text,
    category: inferLifeCategory(text),
    status: 'Open',
    dueDate: findDate(text),
    priority: lower.includes('urgent') || lower.includes('asap') ? 'High' : 'Normal',
    energy: inferEnergy(text),
    notes: text
  };
}

function parseLifeRoutine(text) {
  const cleaned = text.replace(/^(routine|recurring|weekly routine)\s*:?\s*/i, '').trim();
  return {
    type: 'life-routine',
    title: cleaned || text,
    category: inferLifeCategory(text),
    cadence: inferCadence(text),
    nextDue: findDate(text),
    status: 'Active',
    notes: text
  };
}

function parseLifeLog(text) {
  const cleaned = text.replace(/^(life log|life|note)\s*:?\s*/i, '').trim();
  return {
    type: 'life-log',
    logDate: todayIso(),
    category: inferLifeCategory(text),
    title: cleaned.slice(0, 90) || text.slice(0, 90),
    body: cleaned || text,
    mood: inferMood(text),
    energy: inferEnergy(text),
    source: 'quick-log'
  };
}

function findAmount(text) {
  const match = /(?:\$)?([0-9]+(?:\.[0-9]{1,2})?)/.exec(text);
  return match ? parseMoney(match[1]) : 0;
}

function findDate(text) {
  const lower = text.toLowerCase();
  if (lower.includes('tomorrow')) {
    const date = new Date(`${todayIso()}T00:00:00`);
    date.setDate(date.getDate() + 1);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  }
  if (lower.includes('today')) return todayIso();
  const iso = /\d{4}-\d{2}-\d{2}/.exec(text);
  if (iso) return iso[0];
  const monthDay = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/i.exec(text);
  if (!monthDay) return '';
  const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(monthDay[1].slice(0, 3).toLowerCase()) + 1;
  return `${new Date().getFullYear()}-${String(month).padStart(2, '0')}-${String(monthDay[2]).padStart(2, '0')}`;
}

function annualized(amount, cycle) {
  return billingMonthlyEquivalent(amount, cycle) * 12;
}

function inferCategory(text) {
  const lower = text.toLowerCase();
  if (lower.includes('cover')) return 'Cover Design';
  if (lower.includes('edit')) return 'Editing';
  if (lower.includes('website') || lower.includes('domain') || lower.includes('hosting')) return 'Website/Domain';
  if (lower.includes('ad') || lower.includes('marketing')) return 'Marketing/Ads';
  if (lower.includes('software') || lower.includes('subscription')) return 'Software/Subscriptions';
  return 'Miscellaneous';
}

function inferLifeCategory(text) {
  const lower = text.toLowerCase();
  if (lower.includes('teach') || lower.includes('class')) return 'Co-teaching';
  if (lower.includes('bill') || lower.includes('bank') || lower.includes('pay ')) return 'Money';
  if (lower.includes('doctor') || lower.includes('dentist') || lower.includes('migraine') || lower.includes('med')) return 'Health';
  if (lower.includes('clean') || lower.includes('laundry') || lower.includes('kitchen') || lower.includes('home')) return 'Home';
  if (lower.includes('errand') || lower.includes('grocery') || lower.includes('pickup')) return 'Errands';
  if (lower.includes('rest') || lower.includes('burn') || lower.includes('tired')) return 'Energy';
  return 'General';
}

function inferCadence(text) {
  const lower = text.toLowerCase();
  if (lower.includes('daily') || lower.includes('every day')) return 'Daily';
  if (lower.includes('monthly') || lower.includes('every month')) return 'Monthly';
  if (lower.includes('weekday')) return 'Weekdays';
  return 'Weekly';
}

function inferMood(text) {
  const lower = text.toLowerCase();
  if (lower.includes('overwhelm') || lower.includes('burn')) return 'Overwhelmed';
  if (lower.includes('good') || lower.includes('great') || lower.includes('better')) return 'Good';
  if (lower.includes('sad') || lower.includes('rough')) return 'Rough';
  return '';
}

function inferEnergy(text) {
  const lower = text.toLowerCase();
  if (lower.includes('low energy') || lower.includes('tired') || lower.includes('migraine') || lower.includes('burn')) return 'Low';
  if (lower.includes('high energy') || lower.includes('focused')) return 'High';
  return '';
}

function inferService(text) {
  const known = ['Claude Pro', 'ChatGPT Plus', 'Sudowrite', 'Buffer', 'Carrd Pro', 'NameCheap Domain', 'NameCheap Site Hosting'];
  const lower = text.toLowerCase();
  return known.find((name) => lower.includes(name.toLowerCase())) || firstVendor(text);
}

function firstVendor(text) {
  return text.replace(/^\$?\d+(?:\.\d{1,2})?\s*/, '').split(/,| for | today | renews /i)[0].trim() || 'Unknown';
}

function inferTitle(text) {
  return text.split(/ is | status | now /i)[0].trim();
}
