// fetcher.js
// Downloads the target page, robots.txt, and sitemap.xml

const axios = require('axios');

// We pretend to be a real browser so sites don't block us
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0; +https://example.com/bot)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function fetchPage(url) {
  const baseUrl = new URL(url).origin; // e.g. https://example.com

  // ── 1. Fetch the main page ────────────────────────────────────────────────
  const t0 = Date.now();
  const response = await axios.get(url, {
    headers: HEADERS,
    timeout: 15000, // give up after 15 seconds
  });
  const responseTimeMs = Date.now() - t0;
  const html = response.data;

  // ── 2. Try to fetch robots.txt ────────────────────────────────────────────
  let robotsTxt = null;
  try {
    const r = await axios.get(`${baseUrl}/robots.txt`, {
      headers: HEADERS,
      timeout: 5000,
    });
    robotsTxt = r.data;
  } catch {
    // Not found or blocked — that's fine, we just note it
    robotsTxt = null;
  }

  // ── 3. Try to fetch sitemap.xml ───────────────────────────────────────────
  let sitemap = null;
  try {
    const s = await axios.get(`${baseUrl}/sitemap.xml`, {
      headers: HEADERS,
      timeout: 5000,
    });
    sitemap = s.data;
  } catch {
    sitemap = null;
  }

  return {
    html,           // full HTML of the page
    url,            // the original URL
    baseUrl,        // https://example.com  (used to detect internal links)
    robotsTxt,      // content of /robots.txt, or null
    sitemap,        // content of /sitemap.xml, or null
    responseTimeMs, // how long the page took to load in ms
  };
}

module.exports = { fetchPage };
