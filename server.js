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
app.listen(PORT, () => {
  console.log(`\nSEO Audit Tool  →  http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.\n');
});
