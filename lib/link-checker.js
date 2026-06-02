// link-checker.js
// Extracts all internal links from the page and checks each one for broken URLs.
// Runs up to 5 requests at a time to avoid hammering the server.

const axios  = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)',
};

// Maximum number of internal links to check (keep the scan fast)
const MAX_LINKS = 30;

// How many requests to fire simultaneously
const CONCURRENCY = 5;

// ── Extract unique internal links from the page ──────────────────────────────
function extractInternalLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const links = [];

  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const text  = $(el).text().trim().slice(0, 80);

    // Skip anchors, mailto, tel, javascript
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return;

    let fullUrl;
    try {
      // new URL handles both absolute and relative hrefs
      fullUrl = new URL(href, baseUrl).href;
    } catch {
      return; // malformed href — skip
    }

    // Only keep URLs on the same origin
    if (!fullUrl.startsWith(baseUrl)) return;

    // Remove fragment (#section) so we don't double-check the same page
    fullUrl = fullUrl.split('#')[0];

    if (seen.has(fullUrl)) return;
    seen.add(fullUrl);

    links.push({ url: fullUrl, text: text || '(no text)' });
  });

  return links.slice(0, MAX_LINKS);
}

// ── Check a single URL (HEAD first, GET fallback) ────────────────────────────
async function checkOneLink(linkObj) {
  const { url, text } = linkObj;

  // Try HEAD — it's faster because the server doesn't send the body
  for (const method of ['head', 'get']) {
    try {
      const res = await axios[method](url, {
        headers: HEADERS,
        timeout: 8000,
        maxRedirects: 5,
        validateStatus: () => true, // never throw on 4xx/5xx
      });
      return { url, text, status: res.status, method };
    } catch {
      // HEAD blocked by server — fall through to GET
      if (method === 'head') continue;
      // GET also failed — connection refused, DNS error, etc.
      return { url, text, status: 0, error: 'Request failed (timeout or connection error)' };
    }
  }
}

// ── Run all checks with limited concurrency ──────────────────────────────────
async function checkBrokenLinks(pageData) {
  const { html, baseUrl } = pageData;
  const links = extractInternalLinks(html, baseUrl);

  if (links.length === 0) {
    return { checked: [], broken: [], redirects: [], ok: [], skipped: 0 };
  }

  // Process in batches of CONCURRENCY
  const results = [];
  for (let i = 0; i < links.length; i += CONCURRENCY) {
    const batch = links.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(checkOneLink));
    results.push(...batchResults);
  }

  const broken    = results.filter(r => r.status === 0 || r.status >= 400);
  const redirects = results.filter(r => r.status >= 300 && r.status < 400);
  const ok        = results.filter(r => r.status >= 200 && r.status < 300);

  return {
    checked:   results,
    broken,
    redirects,
    ok,
    skipped: Math.max(0, links.length - results.length),
  };
}

module.exports = { checkBrokenLinks };
