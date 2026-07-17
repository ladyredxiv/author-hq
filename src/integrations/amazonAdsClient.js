import { gunzipSync } from 'node:zlib';
import { getSetting, saveSettings } from '../config.js';

export const AMAZON_ADS_SCOPE = 'advertising::campaign_management';
export const AMAZON_ADS_NA_ENDPOINT = 'https://advertising-api.amazon.com';
const AMAZON_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

export function amazonAdsConfigured() {
  return Boolean(
    getSetting('AMAZON_ADS_CLIENT_ID') &&
    getSetting('AMAZON_ADS_CLIENT_SECRET') &&
    getSetting('AMAZON_ADS_REDIRECT_URI')
  );
}

export function amazonAdsConnected() {
  return Boolean(getSetting('AMAZON_ADS_REFRESH_TOKEN'));
}

export function getAmazonAdsAuthUrl() {
  if (!amazonAdsConfigured()) return null;
  const params = new URLSearchParams({
    client_id: getSetting('AMAZON_ADS_CLIENT_ID'),
    scope: AMAZON_ADS_SCOPE,
    response_type: 'code',
    redirect_uri: getSetting('AMAZON_ADS_REDIRECT_URI')
  });
  return `https://www.amazon.com/ap/oa?${params.toString()}`;
}

export async function exchangeAmazonAdsCode(code) {
  const payload = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getSetting('AMAZON_ADS_REDIRECT_URI')
  });
  persistTokenPayload(payload);
  return payload;
}

export async function refreshAmazonAdsToken() {
  const refreshToken = getSetting('AMAZON_ADS_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('Amazon Ads is not connected yet.');
  const payload = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  persistTokenPayload(payload);
  return payload;
}

export async function amazonAdsAccessToken() {
  const existing = getSetting('AMAZON_ADS_ACCESS_TOKEN');
  const expiresAt = Number(getSetting('AMAZON_ADS_TOKEN_EXPIRES_AT') || 0);
  if (existing && expiresAt > Date.now() + 60000) return existing;
  const refreshed = await refreshAmazonAdsToken();
  return refreshed.access_token;
}

export async function listAmazonAdsProfiles() {
  const token = await amazonAdsAccessToken();
  return amazonAdsFetch('/v2/profiles', { token });
}

export async function requestAmazonSponsoredProductsCampaignReport({ profileId, startDate, endDate }) {
  const token = await amazonAdsAccessToken();
  const body = {
    name: `Author HQ Sponsored Products campaigns ${startDate} to ${endDate}`,
    startDate,
    endDate,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaign'],
      columns: [
        'date',
        'campaignId',
        'campaignName',
        'impressions',
        'clicks',
        'cost',
        'purchases14d',
        'sales14d'
      ],
      reportTypeId: 'spCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON'
    }
  };
  return amazonAdsFetch('/reporting/reports', { method: 'POST', token, profileId, body });
}

export async function getAmazonAdsReport(reportId) {
  const token = await amazonAdsAccessToken();
  return amazonAdsFetch(`/reporting/reports/${encodeURIComponent(reportId)}`, { token });
}

export async function waitForAmazonAdsReport(reportId, { timeoutMs = 90000, intervalMs = 5000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const report = await getAmazonAdsReport(reportId);
    const status = String(report.status || '').toUpperCase();
    if (status === 'COMPLETED' && report.url) return report;
    if (['FAILURE', 'FAILED', 'CANCELLED'].includes(status)) {
      throw new Error(`Amazon Ads report ${reportId} ended with status ${status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Amazon Ads report ${reportId} was not ready yet. Try pulling again in a minute.`);
}

export async function downloadAmazonAdsReport(reportUrl) {
  const response = await fetchWithTimeout(reportUrl, {}, 30000);
  if (!response.ok) throw new Error(`Amazon Ads report download failed: ${response.status} ${await response.text()}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = gunzipSync(buffer).toString('utf8');
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed?.results || [];
}

async function tokenRequest(extra) {
  if (!amazonAdsConfigured()) throw new Error('Amazon Ads Client ID, Client Secret, and Redirect URI are required.');
  const body = new URLSearchParams({
    client_id: getSetting('AMAZON_ADS_CLIENT_ID'),
    client_secret: getSetting('AMAZON_ADS_CLIENT_SECRET'),
    ...extra
  });
  const response = await fetchWithTimeout(AMAZON_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  }, 30000);
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) throw new Error(`Amazon token request failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function persistTokenPayload(payload) {
  const next = {};
  if (payload.access_token) next.AMAZON_ADS_ACCESS_TOKEN = payload.access_token;
  if (payload.refresh_token) next.AMAZON_ADS_REFRESH_TOKEN = payload.refresh_token;
  if (payload.expires_in) next.AMAZON_ADS_TOKEN_EXPIRES_AT = String(Date.now() + Number(payload.expires_in) * 1000);
  saveSettings(next);
}

async function amazonAdsFetch(path, { method = 'GET', token, profileId = '', body } = {}) {
  const response = await fetchWithTimeout(`${AMAZON_ADS_NA_ENDPOINT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': getSetting('AMAZON_ADS_CLIENT_ID'),
      ...(profileId ? { 'Amazon-Advertising-API-Scope': String(profileId) } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }, 30000);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) throw new Error(`Amazon Ads API request failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Amazon Ads did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
