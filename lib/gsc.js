// gsc.js
// Google Search Console OAuth2 authentication + Search Analytics API.
//
// Uses axios (already a project dependency) — no extra packages required.
//
// Required .env variables:
//   GSC_CLIENT_ID       — from Google Cloud Console OAuth2 credentials
//   GSC_CLIENT_SECRET   — from Google Cloud Console OAuth2 credentials
//   GSC_REDIRECT_URI    — optional, defaults to http://localhost:3000/auth/google/callback
//
// Token persistence: tokens are saved to tokens.json at the project root.
// This file is gitignored. The access token is refreshed automatically when
// it expires (Google access tokens last 1 hour; the refresh token is permanent).

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const TOKEN_FILE   = path.join(__dirname, '..', 'tokens.json');
const REDIRECT_URI = process.env.GSC_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';
const SCOPES       = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const API_BASE     = 'https://searchconsole.googleapis.com/webmasters/v3';

// ── Token store ───────────────────────────────────────────────────────────────
// In-memory cache so we don't hit disk on every request.
let _tokens = null;

function loadTokens() {
  if (_tokens) return _tokens;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      _tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch { _tokens = null; }
  return _tokens;
}

function saveTokens(t) {
  _tokens = t;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), 'utf8');
}

function clearTokens() {
  _tokens = null;
  try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch {}
}

// ── Credential checks ─────────────────────────────────────────────────────────
function hasCredentials() {
  return !!(process.env.GSC_CLIENT_ID && process.env.GSC_CLIENT_SECRET);
}

function isConnected() {
  const t = loadTokens();
  if (!t || !t.access_token) return false;
  // A refresh token lets us always get a new access token, so we're "connected"
  if (t.refresh_token) return true;
  // No refresh token — only connected if access token hasn't expired
  return !t.expiry_date || t.expiry_date > Date.now() + 60_000;
}

// ── OAuth2 ────────────────────────────────────────────────────────────────────
function getAuthUrl() {
  const params = new URLSearchParams({
    client_id:     process.env.GSC_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent', // ensures we always receive a refresh token
  });
  return `${AUTH_URL}?${params}`;
}

async function exchangeCode(code) {
  const { data } = await axios.post(TOKEN_URL,
    new URLSearchParams({
      code,
      client_id:     process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  saveTokens({ ...data, expiry_date: Date.now() + data.expires_in * 1000 });
}

// Returns a valid access token, refreshing if necessary.
async function getAccessToken() {
  const t = loadTokens();
  if (!t) throw new Error('Not authenticated with Google');

  const expired = t.expiry_date && t.expiry_date < Date.now() + 60_000;
  if (!expired) return t.access_token;

  if (!t.refresh_token) {
    throw new Error('Access token expired and no refresh token available. Please reconnect.');
  }

  const { data } = await axios.post(TOKEN_URL,
    new URLSearchParams({
      client_id:     process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const updated = { ...t, access_token: data.access_token, expiry_date: Date.now() + data.expires_in * 1000 };
  saveTokens(updated);
  return updated.access_token;
}

// ── Search Console API ────────────────────────────────────────────────────────

// Returns all verified Search Console properties for the authenticated account.
async function getSites() {
  const token = await getAccessToken();
  const { data } = await axios.get(`${API_BASE}/sites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (data.siteEntry || []).map(s => ({
    siteUrl:         s.siteUrl,
    permissionLevel: s.permissionLevel,
  }));
}

// Runs a searchAnalytics.query request.
// opts: { siteUrl, startDate, endDate, dimensions, rowLimit, filters }
//   dimensions : array of 'query' | 'page' | 'country' | 'device'
//   filters    : array of { dimension, operator, expression } — optional
async function querySearchAnalytics(opts) {
  const {
    siteUrl,
    startDate,
    endDate,
    dimensions = ['query', 'page', 'country'],
    rowLimit   = 1000,
    filters    = [],
  } = opts;

  const token = await getAccessToken();

  const body = { startDate, endDate, dimensions, rowLimit, dataState: 'all' };
  if (filters.length) {
    body.dimensionFilterGroups = [{ groupType: 'and', filters }];
  }

  // siteUrl must be URL-encoded when used as a path segment
  const encoded = encodeURIComponent(siteUrl);
  const { data } = await axios.post(
    `${API_BASE}/sites/${encoded}/searchAnalytics/query`,
    body,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data.rows || [];
}

module.exports = {
  hasCredentials,
  isConnected,
  getAuthUrl,
  exchangeCode,
  clearTokens,
  getSites,
  querySearchAnalytics,
};
