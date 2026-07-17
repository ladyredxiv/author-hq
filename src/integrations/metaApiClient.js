import { getSetting } from '../config.js';

export function metaConfigured() {
  return Boolean(getSetting('META_APP_ID') && getSetting('META_APP_SECRET') && getSetting('META_REDIRECT_URI'));
}

export function getMetaAuthUrl() {
  if (!metaConfigured()) return null;
  const params = new URLSearchParams({
    client_id: getSetting('META_APP_ID'),
    redirect_uri: getSetting('META_REDIRECT_URI'),
    scope: 'ads_read,read_insights',
    response_type: 'code'
  });
  return `https://www.facebook.com/v20.0/dialog/oauth?${params.toString()}`;
}

export async function exchangeMetaCode() {
  throw new Error('Meta OAuth token exchange is intentionally stubbed until App ID/Secret and Marketing API access are available.');
}

export async function pullMetaAdInsights() {
  throw new Error('Meta insight pulls are stubbed. Manual ad entries use the same ad_entries table and can coexist with future meta_api rows.');
}
