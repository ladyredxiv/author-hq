import { google } from 'googleapis';
import { getSetting, loadSettings, saveSettings } from '../config.js';

const scopes = ['https://www.googleapis.com/auth/calendar'];

export function googleCalendarConfigured() {
  return Boolean(parseClientConfig());
}

export function googleCalendarConnected() {
  return Boolean(parseClientConfig() && parseTokenConfig());
}

export function googleCalendarId() {
  return getSetting('GOOGLE_CALENDAR_ID', 'primary') || 'primary';
}

export function googleAuthUrl(baseUrl) {
  const client = oauthClient(baseUrl);
  if (!client) return '';
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });
}

export async function handleGoogleCallback(code, baseUrl) {
  const client = oauthClient(baseUrl);
  if (!client) throw new Error('Google OAuth client JSON is not configured.');
  const { tokens } = await client.getToken(code);
  saveSettings({ GOOGLE_CALENDAR_TOKEN_JSON: JSON.stringify(tokens) });
  return tokens;
}

export async function listGoogleCalendars(baseUrl) {
  const client = authorizedClient(baseUrl);
  const calendar = google.calendar({ version: 'v3', auth: client });
  const response = await calendar.calendarList.list({ minAccessRole: 'writer' });
  return response.data.items || [];
}

export async function listGoogleCalendarEvents({ baseUrl, timeMin, timeMax }) {
  const client = authorizedClient(baseUrl);
  const calendar = google.calendar({ version: 'v3', auth: client });
  const response = await calendar.events.list({
    calendarId: googleCalendarId(),
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    showDeleted: false,
    maxResults: 2500
  });
  return response.data.items || [];
}

export async function upsertGoogleCalendarEvent(event, syncRow, baseUrl) {
  const client = authorizedClient(baseUrl);
  const calendar = google.calendar({ version: 'v3', auth: client });
  const calendarId = googleCalendarId();
  const resource = googleEventResource(event);
  if (syncRow?.google_event_id) {
    try {
      const response = await calendar.events.patch({
        calendarId,
        eventId: syncRow.google_event_id,
        requestBody: resource
      });
      return response.data;
    } catch (error) {
      if (error?.code !== 404) throw error;
    }
  }
  const response = await calendar.events.insert({ calendarId, requestBody: resource });
  return response.data;
}

export function saveGoogleCalendarId(calendarId) {
  saveSettings({ GOOGLE_CALENDAR_ID: calendarId || 'primary' });
}

export function disconnectGoogleCalendar() {
  const settings = loadSettings();
  settings.GOOGLE_CALENDAR_TOKEN_JSON = '';
  saveSettings(settings);
}

function authorizedClient(baseUrl) {
  const client = oauthClient(baseUrl);
  const tokens = parseTokenConfig();
  if (!client || !tokens) throw new Error('Google Calendar is not connected.');
  client.setCredentials(tokens);
  client.on('tokens', (nextTokens) => {
    if (nextTokens.refresh_token) {
      saveSettings({ GOOGLE_CALENDAR_TOKEN_JSON: JSON.stringify({ ...tokens, ...nextTokens }) });
    }
  });
  return client;
}

function oauthClient(baseUrl) {
  const config = parseClientConfig();
  if (!config) return null;
  const installed = config.installed || config.web || config;
  return new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    `${baseUrl.replace(/\/$/, '')}/integrations/google/callback`
  );
}

function parseClientConfig() {
  const raw = getSetting('GOOGLE_OAUTH_CLIENT_JSON');
  if (!raw || raw === '********') return null;
  try {
    const parsed = JSON.parse(raw);
    const installed = parsed.installed || parsed.web || parsed;
    if (!installed.client_id || !installed.client_secret) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseTokenConfig() {
  const raw = getSetting('GOOGLE_CALENDAR_TOKEN_JSON');
  if (!raw || raw === '********') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.access_token || parsed.refresh_token ? parsed : null;
  } catch {
    return null;
  }
}

function googleEventResource(event) {
  const description = [
    event.notes || '',
    '',
    `Author HQ source: ${event.source || 'manual'}`,
    `Author HQ key: ${event.local_key}`
  ].filter((line, index, all) => line || all[index - 1]).join('\n');
  const base = {
    summary: event.title,
    description,
    extendedProperties: {
      private: {
        authorHqKey: event.local_key,
        authorHqSource: event.source || 'manual'
      }
    }
  };
  if (event.event_time) {
    const start = `${event.event_date}T${event.event_time}:00`;
    return {
      ...base,
      start: { dateTime: start, timeZone: 'America/New_York' },
      end: { dateTime: addHours(start, 1), timeZone: 'America/New_York' }
    };
  }
  return {
    ...base,
    start: { date: event.event_date },
    end: { date: addDays(event.event_date, 1) }
  };
}

function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function addHours(dateTime, hours) {
  const date = new Date(dateTime);
  date.setHours(date.getHours() + hours);
  return date.toISOString().slice(0, 19);
}
