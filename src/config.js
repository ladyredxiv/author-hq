import fs from 'node:fs';
import path from 'node:path';

const defaultSettings = {
  CO_TEACHING_CREDITS_URL: 'https://airtable.com/appzYmPFcz9Wxzn0X/shr7LT3Qux2r7Vv24'
};

const settingKeys = [
  'AUTH_PASSPHRASE',
  'COOKIE_SECRET',
  'BUFFER_TOKEN',
  'BUFFER_ORGANIZATION_ID',
  'CO_TEACHING_CREDITS_URL',
  'EMAILOCTOPUS_API_KEY',
  'AMAZON_ADS_CLIENT_ID',
  'AMAZON_ADS_CLIENT_SECRET',
  'AMAZON_ADS_REDIRECT_URI',
  'AMAZON_ADS_ACCESS_TOKEN',
  'AMAZON_ADS_REFRESH_TOKEN',
  'AMAZON_ADS_TOKEN_EXPIRES_AT',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_REDIRECT_URI',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_OAUTH_CLIENT_JSON',
  'GOOGLE_CALENDAR_TOKEN_JSON',
  'GOOGLE_CALENDAR_ID',
  'KNOWLEDGE_BASE_ROOT',
  'IMPROVEMENT_SCHEDULE_ENABLED',
  'IMPROVEMENT_SCHEDULE_DAY',
  'IMPROVEMENT_SCHEDULE_TIME',
  'IMPROVEMENT_SCHEDULE_LAST_RUN'
];

export function settingsPath() {
  return process.env.AUTHOR_HQ_SETTINGS_PATH || path.resolve(process.cwd(), 'data', 'local-settings.json');
}

export function loadSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveSettings(input) {
  const current = loadSettings();
  const next = { ...current };
  settingKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      next[key] = String(input[key] || '').trim();
    }
  });
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export function getSetting(key, fallback = '') {
  const settings = loadSettings();
  return settings[key] || process.env[key] || defaultSettings[key] || fallback;
}

export function redactedSettings() {
  const settings = loadSettings();
  const out = {};
  settingKeys.forEach((key) => {
    const value = settings[key] || process.env[key] || defaultSettings[key] || '';
    out[key] = isSecret(key) && value ? '********' : value;
  });
  return out;
}

export function allSettingKeys() {
  return settingKeys.slice();
}

function isSecret(key) {
  return key.includes('KEY') || key.includes('SECRET') || key.includes('TOKEN') || key.includes('PASSPHRASE') || key.includes('OAUTH');
}
