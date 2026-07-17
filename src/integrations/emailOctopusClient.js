import { getSetting } from '../config.js';

const baseUrl = 'https://emailoctopus.com/api/1.6';

export async function getListStats(listId) {
  const apiKey = getSetting('EMAILOCTOPUS_API_KEY');
  if (!apiKey) return { configured: false, missing: 'apiKey' };
  if (!listId) return { configured: false, missing: 'listId' };
  const list = await requestEmailOctopus(`/lists/${encodeURIComponent(listId)}`, apiKey);
  if (list.error) return { configured: true, error: list.error };
  const latestCampaign = await getLatestSentCampaignForList(apiKey, listId);
  return {
    configured: true,
    listId,
    listName: list.name || '',
    subscriberCount: list.counts?.subscribed ?? 0,
    pendingCount: list.counts?.pending ?? 0,
    unsubscribedCount: list.counts?.unsubscribed ?? 0,
    latestCampaign,
    raw: list
  };
}

async function getLatestSentCampaignForList(apiKey, listId) {
  const result = await requestEmailOctopus('/campaigns', apiKey, { limit: 100 });
  if (result.error) return { error: result.error };
  const campaigns = Array.isArray(result.data) ? result.data : [];
  const latest = campaigns
    .filter((campaign) => campaign.status === 'SENT' && Array.isArray(campaign.to) && campaign.to.includes(listId))
    .sort((a, b) => String(b.sent_at || '').localeCompare(String(a.sent_at || '')))[0];
  if (!latest) return null;
  const report = await requestEmailOctopus(`/campaigns/${encodeURIComponent(latest.id)}/reports/summary`, apiKey);
  return {
    id: latest.id,
    name: latest.name || '',
    subject: latest.subject || '',
    sentAt: latest.sent_at || '',
    report: report.error ? null : report,
    reportError: report.error || ''
  };
}

async function requestEmailOctopus(path, apiKey, params = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const url = new URL(`${baseUrl}${path}`);
  url.searchParams.set('api_key', apiKey);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.message || data.error?.message || `EmailOctopus returned ${response.status}`;
      return { error: message, status: response.status, raw: data };
    }
    return data;
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'EmailOctopus check timed out' : error.message };
  } finally {
    clearTimeout(timeout);
  }
}
