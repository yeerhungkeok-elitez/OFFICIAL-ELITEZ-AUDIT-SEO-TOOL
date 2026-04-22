require("dotenv").config();
// server.js
// Express web server — serves the frontend and exposes two API endpoints:
//
//   POST /api/audit              — single-page audit (returns JSON)
//   GET  /api/crawl/stream       — full site crawl (Server-Sent Events)
//
// Usage: node server.js  →  open http://localhost:3000

const express = require('express');
const path    = require('path');

const { fetchPage }           = require('./lib/fetcher');
const { runSEOChecks }        = require('./lib/seo-checks');
const { runConversionChecks } = require('./lib/conversion-checks');
const { checkBrokenLinks }    = require('./lib/link-checker');
const { SiteCrawler }         = require('./lib/crawler');
const { weightedScore, buildScoreSummary } = require('./lib/scoring');
const gsc                     = require('./lib/gsc');

const app  = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/crawl/stream
//
// Streams a full-site crawl as Server-Sent Events (SSE).
// The browser connects via EventSource and receives one event per page.
//
// Query params:
//   url       — the starting URL (required)
//   maxPages  — stop after N pages (default 50, max 100)
//
// Event types emitted:
//   start     — crawl begins, includes { url, maxPages }
//   progress  — crawler status update, includes { pagesProcessed, queueRemaining, currentBatch }
//   page      — one page result, includes { url, path, status, checks, issueCount, … }
//   done      — crawl finished, includes { summary }
//   error     — unrecoverable error, includes { message }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/crawl/stream', async (req, res) => {
  let { url, maxPages } = req.query;

  if (!url) return res.status(400).send('url query parameter is required');

  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try { new URL(url); }
  catch { return res.status(400).send('Invalid URL'); }

  const limit = Math.min(parseInt(maxPages) || 50, 100);

  // ── Set up SSE ──────────────────────────────────────────────────────────
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Helper: write one SSE event
  function send(event, data) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Track if the client disconnected mid-crawl
  let aborted = false;
  req.on('close', () => { aborted = true; });

  send('start', { url, maxPages: limit });

  // ── Run the crawl ───────────────────────────────────────────────────────
  const crawler = new SiteCrawler(url, {
    maxPages:    limit,
    concurrency: 3,
    onProgress: (data) => { if (!aborted) send('progress', data); },
    onPageDone: (result) => { if (!aborted) send('page', result); },
  });
  crawler.aborted = false;
  req.on('close', () => { crawler.aborted = true; });

  try {
    await crawler.crawl();

    if (!aborted) {
      const all = crawler.results;

      // Aggregate summary
      const summary = {
        pagesScanned: all.length,
        totalFail:    all.reduce((n, r) => n + r.issueCount.fail, 0),
        totalWarn:    all.reduce((n, r) => n + r.issueCount.warn, 0),
        totalPass:    all.reduce((n, r) => n + r.issueCount.pass, 0),
        scores:       buildScoreSummary(all),
      };

      send('done', { summary });
    }
  } catch (err) {
    if (!aborted) send('error', { message: friendlyError(err, url) });
  } finally {
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/audit  — single-page audit (kept for CLI / programmatic use)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/audit', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Please provide a URL.' });

  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch {
    return res.status(400).json({ error: `"${url}" is not a valid URL.` });
  }

  try {
    const pageData    = await fetchPage(url);
    const seoChecks   = runSEOChecks(pageData);
    const convChecks  = runConversionChecks(pageData);
    const linkResults = await checkBrokenLinks(pageData);
    const scores      = calculateScores(seoChecks, convChecks);

    res.json({ url, scannedAt: new Date().toISOString(),
               responseTimeMs: pageData.responseTimeMs,
               scores, seoChecks, convChecks, linkResults });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err, url) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Single-page score (used by POST /api/audit)
function calculateScores(seoChecks, convChecks) {
  const seo  = weightedScore(seoChecks);
  const conv = convChecks.length ? weightedScore(convChecks) : seo;
  return { overall: Math.round(seo * 0.7 + conv * 0.3), seo, conversion: conv };
}

function friendlyError(err, url) {
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')
    return `Could not reach "${url}". Check the URL and make sure the site is live.`;
  if (err.code === 'ECONNREFUSED')
    return `Connection refused by "${url}". The server may be down.`;
  if (err.response?.status === 403)
    return `"${url}" returned 403 Forbidden — the site is blocking automated requests.`;
  if (err.code === 'ETIMEDOUT' || err.message?.includes('timeout'))
    return `"${url}" timed out. The site may be very slow or unreachable.`;
  return err.message || 'Unknown error.';
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SEARCH CONSOLE — OAuth2 flow + API proxy
// ─────────────────────────────────────────────────────────────────────────────

// Kick off Google OAuth2 — redirects the browser to Google's consent screen.
app.get('/auth/google', (req, res) => {
  if (!gsc.hasCredentials()) {
    return res.status(503).send(
      'GSC credentials not configured. Add GSC_CLIENT_ID and GSC_CLIENT_SECRET to your .env file and restart the server.'
    );
  }
  res.redirect(gsc.getAuthUrl());
});

// Google redirects here after the user grants (or denies) access.
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`/?section=search-performance&gsc_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect('/?section=search-performance&gsc_error=No+authorization+code+received');
  }
  try {
    await gsc.exchangeCode(code);
    res.redirect('/?section=search-performance');
  } catch (err) {
    res.redirect(`/?section=search-performance&gsc_error=${encodeURIComponent(err.message)}`);
  }
});

// Frontend polls this to decide which GSC state to show.
app.get('/api/gsc/status', (req, res) => {
  res.json({
    hasCredentials: gsc.hasCredentials(),
    connected:      gsc.isConnected(),
  });
});

// List all Search Console properties for the authenticated account.
app.get('/api/gsc/sites', async (req, res) => {
  if (!gsc.isConnected()) return res.status(401).json({ error: 'Not connected to Google Search Console.' });
  try {
    const sites = await gsc.getSites();
    res.json({ sites });
  } catch (err) {
    res.status(500).json({ error: friendlyGSCError(err) });
  }
});

// Run a searchAnalytics.query — main data endpoint for the Search Performance tab.
// Body: { siteUrl, startDate, endDate, dimensions, rowLimit, filters }
app.post('/api/gsc/query', async (req, res) => {
  if (!gsc.isConnected()) return res.status(401).json({ error: 'Not connected to Google Search Console.' });
  const { siteUrl, startDate, endDate, dimensions, rowLimit, filters } = req.body;
  if (!siteUrl || !startDate || !endDate) {
    return res.status(400).json({ error: 'siteUrl, startDate, and endDate are required.' });
  }
  try {
    const rows = await gsc.querySearchAnalytics({ siteUrl, startDate, endDate, dimensions, rowLimit, filters });
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: friendlyGSCError(err) });
  }
});

// Clear saved tokens (disconnect).
app.post('/api/gsc/logout', (req, res) => {
  gsc.clearTokens();
  res.json({ ok: true });
});

function friendlyGSCError(err) {
  const status = err.response?.status;
  const msg    = err.response?.data?.error?.message || err.message;
  if (status === 403) return `Permission denied: ${msg}. Make sure this Google account has access to the Search Console property.`;
  if (status === 401) return 'Session expired. Please disconnect and reconnect your Google account.';
  if (status === 429) return 'Google API rate limit hit. Wait a moment and try again.';
  return msg || 'Unknown error communicating with Google Search Console.';
}

// ── POST /api/competitor/analyze ─────────────────────────────────────────────
// Fetches each submitted URL, runs SEO checks, returns structured results.
// Body: { pages: [{ url: string, label: string }] }   (max 4 entries)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/competitor/analyze', async (req, res) => {
  const { pages } = req.body;
  if (!Array.isArray(pages) || pages.length === 0) {
    return res.status(400).json({ error: 'No pages provided.' });
  }

  const limited = pages.slice(0, 4);
  const results = await Promise.all(limited.map(async ({ url, label }) => {
    try {
      if (!url || !/^https?:\/\//i.test(url)) throw new Error('Invalid URL');
      const pageData = await fetchPage(url);
      const checks   = runSEOChecks(pageData);
      return { url, label, checks, responseTimeMs: pageData.responseTimeMs, status: 'ok' };
    } catch (err) {
      return { url, label, checks: [], responseTimeMs: null, status: 'error', error: err.message };
    }
  }));

  res.json({ results });
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nSEO Audit Tool  →  http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.\n');
});
