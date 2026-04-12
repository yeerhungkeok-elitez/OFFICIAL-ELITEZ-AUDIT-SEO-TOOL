// crawler.js
// BFS site crawler — starts at a seed URL, follows internal links, runs SEO checks per page.
//
// Usage:
//   const { SiteCrawler } = require('./crawler');
//   const crawler = new SiteCrawler('https://example.com', {
//     maxPages:    50,
//     concurrency: 3,
//     onProgress: (data) => console.log(data),
//     onPageDone: (result) => console.log(result),
//   });
//   const results = await crawler.crawl();

const axios   = require('axios');
const cheerio = require('cheerio');
const { runSEOChecks }        = require('./seo-checks');
const { runConversionChecks } = require('./conversion-checks');

// ── Constants ─────────────────────────────────────────────────────────────────

// File extensions that are definitely not HTML pages — skip them
const SKIP_EXT = /\.(pdf|jpg|jpeg|png|gif|svg|webp|bmp|ico|zip|rar|doc|docx|xls|xlsx|ppt|pptx|css|js|json|xml|rss|atom|mp3|mp4|avi|mov|woff|woff2|ttf|eot)(\?.*)?$/i;

// Query-string keys that create duplicate pages (tracking params)
const STRIP_PARAMS = new Set([
  'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
  'fbclid','gclid','_ga','mc_eid','ref','source','sid','session',
  '_hsenc','_hsmi','hsCtaTracking','hsa_acc','hsa_cam','hsa_grp',
]);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
};

// ── SiteCrawler ───────────────────────────────────────────────────────────────
class SiteCrawler {
  constructor(startUrl, options = {}) {
    const parsed    = new URL(startUrl);
    this.origin     = parsed.origin;          // e.g. https://example.com
    this.startUrl   = this.normalizeUrl(startUrl);
    this.maxPages   = options.maxPages   || 50;
    this.concurrency= options.concurrency || 3;
    this.onProgress = options.onProgress || (() => {});
    this.onPageDone = options.onPageDone || (() => {});

    // Queue: ordered list of URLs to visit
    this.queue   = [];
    // queued: everything we've added (to prevent duplicates in queue + visited)
    this.queued  = new Set();
    // visited: pages we've actually fetched
    this.visited = new Set();
    // collected results
    this.results = [];
    // set to true if caller disconnects
    this.aborted = false;

    // Populated from robots.txt
    this.disallowedPaths = [];
    // Populated from sitemap.xml (raw content — passed to seo-checks)
    this.robotsTxt      = null;
    this.sitemapContent = null;
  }

  // ── URL normalization ───────────────────────────────────────────────────────
  // Returns null if the URL should be skipped, otherwise a clean canonical string.
  normalizeUrl(href) {
    try {
      const u = new URL(href, this.origin);

      // Only same origin
      if (u.origin !== this.origin) return null;

      // Skip non-HTML resources
      if (SKIP_EXT.test(u.pathname)) return null;

      // Remove fragment (#section — same page, different position)
      u.hash = '';

      // Remove tracking query params
      for (const key of [...u.searchParams.keys()]) {
        if (STRIP_PARAMS.has(key.toLowerCase())) {
          u.searchParams.delete(key);
        }
      }

      // Normalize trailing slash: /about/ → /about  (but keep root / as-is)
      if (u.pathname !== '/' && u.pathname.endsWith('/')) {
        u.pathname = u.pathname.slice(0, -1);
      }

      return u.href;
    } catch {
      return null;
    }
  }

  // ── robots.txt helpers ──────────────────────────────────────────────────────
  parseRobotsTxt(content) {
    if (!content) return [];
    const disallowed = [];
    let inGlobal = false;
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (/^user-agent:\s*\*/i.test(line))   { inGlobal = true;  continue; }
      if (/^user-agent:/i.test(line))        { inGlobal = false; continue; }
      if (inGlobal && /^disallow:\s*/i.test(line)) {
        const path = line.replace(/^disallow:\s*/i, '').trim();
        // Only add non-empty, non-root disallows
        if (path && path !== '/') disallowed.push(path);
      }
    }
    return disallowed;
  }

  isAllowed(url) {
    if (this.disallowedPaths.length === 0) return true;
    try {
      const { pathname } = new URL(url);
      return !this.disallowedPaths.some(d => pathname.startsWith(d));
    } catch {
      return false;
    }
  }

  // ── Queue management ────────────────────────────────────────────────────────
  enqueue(href) {
    const url = this.normalizeUrl(href);
    if (!url)                     return;  // skip: different origin / bad extension / malformed
    if (this.queued.has(url))     return;  // already queued or visited
    if (!this.isAllowed(url))     return;  // blocked by robots.txt
    this.queued.add(url);
    this.queue.push(url);
  }

  // ── Seeding from sitemap ────────────────────────────────────────────────────
  async seedFromSitemap() {
    try {
      const res = await axios.get(`${this.origin}/sitemap.xml`, {
        headers: HEADERS, timeout: 8000, validateStatus: () => true,
      });
      if (res.status === 200 && res.data) {
        this.sitemapContent = res.data;
        const $ = cheerio.load(res.data, { xmlMode: true });
        const locs = [];
        $('loc').each((_, el) => locs.push($(el).text().trim()));
        // Sitemap URLs are high-value — add them early in the queue
        for (const loc of locs) this.enqueue(loc);
      }
    } catch { /* No sitemap — that's fine, we'll crawl from links */ }
  }

  // ── Fetch a single page ─────────────────────────────────────────────────────
  async fetchOne(url) {
    const t0  = Date.now();
    const res = await axios.get(url, {
      headers: HEADERS,
      timeout: 15000,
      validateStatus: () => true,  // don't throw on 4xx/5xx
      maxRedirects: 5,
    });
    return {
      html:          typeof res.data === 'string' ? res.data : '',
      status:        res.status,
      contentType:   res.headers['content-type'] || '',
      responseTimeMs: Date.now() - t0,
    };
  }

  // ── Process one page: fetch → links → checks → emit ────────────────────────
  async processPage(url) {
    if (this.aborted) return;

    try {
      const { html, status, contentType, responseTimeMs } = await this.fetchOne(url);

      // Not HTML (e.g. the server returned a PDF or XML despite the URL looking like a page)
      if (!contentType.includes('text/html')) return;

      const path = (() => { try { return new URL(url).pathname || '/'; } catch { return '/'; } })();

      // If the page returned an error status, record it but don't run checks
      if (status >= 400) {
        const result = {
          url, path, status, responseTimeMs,
          checks: [], convChecks: [],
          issueCount: { fail: 1, warn: 0, pass: 0 },
          httpError: `HTTP ${status}`,
        };
        this.results.push(result);
        this.onPageDone(result);
        return;
      }

      // Extract new links and add to queue
      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) this.enqueue(href);
      });

      // Run all checks on this page
      const pageData = {
        html, url, baseUrl: this.origin,
        robotsTxt:      this.robotsTxt,
        sitemap:        this.sitemapContent,
        responseTimeMs,
      };

      const seoChecks  = runSEOChecks(pageData);
      const isHome     = path === '/' || path === '';
      const convChecks = isHome ? runConversionChecks(pageData) : [];

      const allChecks = [...seoChecks, ...convChecks];
      const result = {
        url, path, status, responseTimeMs,
        checks: seoChecks,
        convChecks,
        issueCount: {
          fail: allChecks.filter(c => c.status === 'fail').length,
          warn: allChecks.filter(c => c.status === 'warn').length,
          pass: allChecks.filter(c => c.status === 'pass').length,
        },
      };

      this.results.push(result);
      this.onPageDone(result);

    } catch (err) {
      // Connection errors, timeouts, etc.
      const path = (() => { try { return new URL(url).pathname || '/'; } catch { return url; } })();
      const result = {
        url, path, status: 0, responseTimeMs: 0,
        checks: [], convChecks: [],
        issueCount: { fail: 0, warn: 0, pass: 0 },
        fetchError: err.message,
      };
      this.results.push(result);
      this.onPageDone(result);
    }
  }

  // ── Main crawl loop ─────────────────────────────────────────────────────────
  async crawl() {
    // Step 1 — Fetch robots.txt (we need this before we start queuing)
    try {
      const r = await axios.get(`${this.origin}/robots.txt`, {
        headers: HEADERS, timeout: 5000, validateStatus: () => true,
      });
      if (r.status === 200 && r.data) {
        this.robotsTxt      = r.data;
        this.disallowedPaths = this.parseRobotsTxt(r.data);
      }
    } catch { /* robots.txt not available */ }

    // Step 2 — Seed queue from sitemap (adds high-value URLs early)
    this.onProgress({ phase: 'seeding', message: 'Reading sitemap.xml…' });
    await this.seedFromSitemap();

    // Step 3 — Make sure the start URL is first in the queue
    this.enqueue(this.startUrl);
    // Move start URL to front (it may have been appended after sitemap URLs)
    const startIdx = this.queue.indexOf(this.startUrl);
    if (startIdx > 0) {
      this.queue.splice(startIdx, 1);
      this.queue.unshift(this.startUrl);
    }

    // Step 4 — BFS loop with concurrency
    let pagesProcessed = 0;

    while (this.queue.length > 0 && pagesProcessed < this.maxPages && !this.aborted) {
      // Grab a batch from the front of the queue
      const batch = [];
      while (
        this.queue.length > 0 &&
        batch.length < this.concurrency &&
        pagesProcessed + batch.length < this.maxPages
      ) {
        const url = this.queue.shift();
        // Skip if we somehow already visited (edge case with concurrency)
        if (this.visited.has(url)) continue;
        this.visited.add(url);
        batch.push(url);
      }

      if (batch.length === 0) break;

      // Emit progress before starting the batch
      this.onProgress({
        phase:          'crawling',
        pagesProcessed,
        queueRemaining: this.queue.length,
        currentBatch:   batch,
      });

      // Process batch in parallel
      await Promise.all(batch.map(url => this.processPage(url)));
      pagesProcessed += batch.length;
    }

    return this.results;
  }
}

module.exports = { SiteCrawler };
