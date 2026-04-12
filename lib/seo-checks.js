// seo-checks.js
// Runs every on-page SEO check against the fetched page data.
//
// Each result: { category, check, status, message, detail }
//   category : used by the web UI to group results into sections
//   status   : 'pass' | 'warn' | 'fail' | 'info'
//   message  : one-line summary (shown in the results table)
//   detail   : optional longer explanation / recommendation

const cheerio = require('cheerio');

// ── robots.txt per-page evaluator ─────────────────────────────────────────────
// Parses robots.txt and returns whether the given page URL is blocked,
// and whether the block is sitewide (Disallow: /).
//
// Follows the robots exclusion protocol:
//   - Rules are grouped by User-agent block
//   - Only groups targeting '*' or 'Googlebot' are checked
//   - Longest matching path wins
//   - Allow beats Disallow on equal-length matches
//   - An empty Disallow path means "allow everything" (used to reset rules)
function checkRobotsForUrl(robotsTxt, pageUrl) {
  let urlPath;
  try { urlPath = new URL(pageUrl).pathname || '/'; } catch { urlPath = '/'; }

  // Parse into groups: [{ agents: string[], rules: {type, path}[] }]
  const groups = [];
  let agents = [], rules = [];

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim(); // strip inline comments
    if (!line) {
      // Blank line ends the current group
      if (agents.length) { groups.push({ agents, rules }); agents = []; rules = []; }
      continue;
    }
    const ua  = line.match(/^user-agent:\s*(.+)/i);
    const dis = line.match(/^disallow:\s*(.*)/i);
    const al  = line.match(/^allow:\s*(.*)/i);

    if (ua) {
      // Consecutive User-agent lines belong to the same group;
      // a new User-agent after rules starts a new group.
      if (rules.length) { groups.push({ agents, rules }); agents = []; rules = []; }
      agents.push(ua[1].trim().toLowerCase());
    } else if (dis && agents.length) {
      rules.push({ type: 'disallow', path: dis[1].trim() });
    } else if (al && agents.length) {
      rules.push({ type: 'allow', path: al[1].trim() });
    }
  }
  // Flush the last group (file may not end with a blank line)
  if (agents.length) groups.push({ agents, rules });

  // Check whether a given path is blocked by a set of rules.
  // Uses longest-match: if two rules match, the longer prefix wins.
  // On equal length, Allow beats Disallow.
  function isBlockedByRules(ruleList, path) {
    let best = null; // { len: number, type: 'allow'|'disallow' }
    for (const r of ruleList) {
      if (!r.path) continue; // empty Disallow = reset (allow all)
      // Strip trailing wildcard for prefix matching
      const prefix = r.path.endsWith('*') ? r.path.slice(0, -1) : r.path;
      if (path.startsWith(prefix)) {
        if (
          !best ||
          prefix.length > best.len ||
          (prefix.length === best.len && r.type === 'allow')
        ) {
          best = { len: prefix.length, type: r.type };
        }
      }
    }
    return best ? best.type === 'disallow' : false;
  }

  const TARGET_AGENTS = ['*', 'googlebot'];
  let pageBlocked  = false;
  let sitewideBlock = false;

  for (const g of groups) {
    if (!g.agents.some(a => TARGET_AGENTS.includes(a))) continue;

    if (isBlockedByRules(g.rules, urlPath)) pageBlocked = true;

    // Sitewide block = Disallow: / with no Allow: / override
    const hasSiteDisallow = g.rules.some(r => r.type === 'disallow' && r.path === '/');
    const hasSiteAllow    = g.rules.some(r => r.type === 'allow'    && (r.path === '/' || r.path === ''));
    if (hasSiteDisallow && !hasSiteAllow) sitewideBlock = true;
  }

  return { pageBlocked, sitewideBlock };
}

function runSEOChecks(pageData) {
  const { html, baseUrl, robotsTxt, sitemap, responseTimeMs } = pageData;
  const $ = cheerio.load(html);
  const results = [];

  // Helper — push a result with a default category
  function add(category, check, status, message, detail) {
    results.push({ category, check, status, message, detail: detail || '' });
  }

  // ═══════════════════════════════════════════════════════════
  // CATEGORY: Basic SEO
  // ═══════════════════════════════════════════════════════════

  // ── Page Title ────────────────────────────────────────────
  const title = $('title').text().trim();
  if (!title) {
    add('Basic SEO', 'Page Title', 'fail',
      'No <title> tag found.',
      'Every page needs a unique title tag. It is the single most important on-page SEO element and is displayed as the blue link in Google search results.');
  } else if (title.length < 30) {
    add('Basic SEO', 'Page Title', 'warn',
      `Title too short — ${title.length} chars: "${title}"`,
      'Aim for 30–60 characters. Short titles miss keyword opportunities and look thin in search results.');
  } else if (title.length > 60) {
    add('Basic SEO', 'Page Title', 'warn',
      `Title too long — ${title.length} chars: "${title}"`,
      'Google truncates titles after ~60 characters in search results. Shorten it so the full title is visible.');
  } else {
    add('Basic SEO', 'Page Title', 'pass',
      `Title is ${title.length} chars: "${title}"`);
  }

  // ── Meta Description ──────────────────────────────────────
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  if (!metaDesc) {
    add('Basic SEO', 'Meta Description', 'fail',
      'No meta description found.',
      'The meta description appears under your title in Google results. Without one, Google will generate its own — often pulling an unrelated snippet from your page.');
  } else if (metaDesc.length < 70) {
    add('Basic SEO', 'Meta Description', 'warn',
      `Meta description short — ${metaDesc.length} chars.`,
      'Aim for 70–160 characters. Use this space to write a compelling summary that gets people to click your listing.');
  } else if (metaDesc.length > 160) {
    add('Basic SEO', 'Meta Description', 'warn',
      `Meta description too long — ${metaDesc.length} chars.`,
      'Google cuts off meta descriptions after ~160 characters. Trim it so the full message shows.');
  } else {
    add('Basic SEO', 'Meta Description', 'pass',
      `Meta description is ${metaDesc.length} chars.`);
  }

  // ── H1 ────────────────────────────────────────────────────
  const h1s = $('h1');
  if (h1s.length === 0) {
    add('Basic SEO', 'H1 Tag', 'fail',
      'No H1 tag found.',
      'Every page should have exactly one H1. It tells search engines what the page is about and should contain your primary keyword.');
  } else if (h1s.length > 1) {
    add('Basic SEO', 'H1 Tag', 'warn',
      `Multiple H1 tags found (${h1s.length}).`,
      `Use only one H1 per page. Having multiple H1s dilutes your keyword signal. Found: ${h1s.map((_, el) => `"${$(el).text().trim()}"`).get().join(', ')}`);
  } else {
    add('Basic SEO', 'H1 Tag', 'pass',
      `H1: "${h1s.first().text().trim()}"`);
  }

  // ── noindex check ─────────────────────────────────────────
  const robotsMeta = $('meta[name="robots"]').attr('content') || '';
  const hasNoindex = /noindex/i.test(robotsMeta);
  if (hasNoindex) {
    add('Basic SEO', 'noindex Tag', 'fail',
      `noindex directive detected: "${robotsMeta}"`,
      'This page is telling Google NOT to index it. Remove the noindex directive unless you intentionally want this page hidden from search results.');
  } else {
    add('Basic SEO', 'noindex Tag', 'pass',
      'No noindex directive found — page is indexable.');
  }

  // ── Canonical Tag ─────────────────────────────────────────
  const canonical = $('link[rel="canonical"]').attr('href');
  if (!canonical) {
    add('Basic SEO', 'Canonical Tag', 'warn',
      'No canonical tag found.',
      'A canonical tag (<link rel="canonical">) prevents duplicate content issues by telling Google which version of a URL is the "real" one. Add one to every page.');
  } else {
    add('Basic SEO', 'Canonical Tag', 'pass',
      `Canonical: ${canonical}`);
  }

  // ═══════════════════════════════════════════════════════════
  // CATEGORY: Content
  // ═══════════════════════════════════════════════════════════

  // ── Heading Structure ─────────────────────────────────────
  const h2Count = $('h2').length;
  const h3Count = $('h3').length;
  const h4Count = $('h4').length;

  // Check for heading order issues (H3 before H2, etc.)
  let headingOrderIssue = false;
  let prevLevel = 1;
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = parseInt(el.tagName[1]);
    if (level > prevLevel + 1) headingOrderIssue = true;
    prevLevel = level;
  });

  if (headingOrderIssue) {
    add('Content', 'Heading Structure', 'warn',
      `Headings may be out of order. H1:${h1s.length} H2:${h2Count} H3:${h3Count} H4:${h4Count}`,
      'Headings should follow a logical order (H1 → H2 → H3). Skipping levels (e.g. H1 directly to H3) can confuse crawlers and screen readers.');
  } else {
    add('Content', 'Heading Structure', 'info',
      `H1:${h1s.length}  H2:${h2Count}  H3:${h3Count}  H4:${h4Count}`);
  }

  // ── Word Count / Thin Content ─────────────────────────────
  const bodyClone = $('body').clone();
  bodyClone.find('script, style, noscript').remove();
  const bodyText  = bodyClone.text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(' ').filter(w => w.length > 1).length;

  if (wordCount < 300) {
    add('Content', 'Word Count', 'fail',
      `Very thin content — ${wordCount} words.`,
      'Google consistently ranks pages with more content higher. Aim for at least 600 words on key pages. Add useful information that answers your clients\' questions.');
  } else if (wordCount < 600) {
    add('Content', 'Word Count', 'warn',
      `${wordCount} words — could be thicker.`,
      'You have the basics, but pages with 600–1500 words tend to rank better. Consider expanding with FAQs, case study snippets, or more detail about your services.');
  } else {
    add('Content', 'Word Count', 'pass',
      `${wordCount} words — solid content length.`);
  }

  // ── Image Alt Text ────────────────────────────────────────
  const images = $('img');
  const missingAltImgs = [];
  images.each((_, img) => {
    const alt = $(img).attr('alt');
    const src = $(img).attr('src') || '(no src)';
    if (alt === undefined || alt.trim() === '') {
      missingAltImgs.push(src.split('/').pop().split('?')[0]); // just filename
    }
  });

  if (images.length === 0) {
    add('Content', 'Image Alt Text', 'info', 'No images found on the page.');
  } else if (missingAltImgs.length > 0) {
    add('Content', 'Image Alt Text', 'fail',
      `${missingAltImgs.length} of ${images.length} images missing alt text.`,
      `Alt text helps Google understand your images and is required for accessibility. Missing alt text on: ${missingAltImgs.slice(0, 5).join(', ')}${missingAltImgs.length > 5 ? ` and ${missingAltImgs.length - 5} more` : ''}.`);
  } else {
    add('Content', 'Image Alt Text', 'pass',
      `All ${images.length} images have alt text.`);
  }

  // ── Open Graph Tags ───────────────────────────────────────
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogDesc  = $('meta[property="og:description"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogCount = [ogTitle, ogDesc, ogImage].filter(Boolean).length;

  if (ogCount === 0) {
    add('Content', 'Open Graph Tags', 'warn',
      'No Open Graph tags found.',
      'Open Graph tags (og:title, og:description, og:image) control how your page looks when shared on Facebook, LinkedIn, and other platforms. Add them to improve click-through on social media.');
  } else if (ogCount < 3) {
    add('Content', 'Open Graph Tags', 'warn',
      `Only ${ogCount}/3 core Open Graph tags found.`,
      `Present: ${[ogTitle && 'og:title', ogDesc && 'og:description', ogImage && 'og:image'].filter(Boolean).join(', ')}. Add the missing ones for better social sharing appearance.`);
  } else {
    add('Content', 'Open Graph Tags', 'pass',
      'og:title, og:description, and og:image all found.');
  }

  // ── Schema Markup ─────────────────────────────────────────
  const schemaBlocks = $('script[type="application/ld+json"]');
  let schemaTypes = [];
  schemaBlocks.each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type']) schemaTypes.push(json['@type']);
    } catch { /* invalid JSON — skip */ }
  });

  if (schemaBlocks.length === 0) {
    add('Content', 'Schema Markup', 'warn',
      'No JSON-LD schema found.',
      'Schema markup helps Google understand your business type and can unlock rich results (star ratings, FAQ dropdowns, etc.) in search. Add at minimum a LocalBusiness or Organization schema.');
  } else {
    add('Content', 'Schema Markup', 'pass',
      `${schemaBlocks.length} schema block(s) found${schemaTypes.length ? ': ' + schemaTypes.join(', ') : ''}.`);
  }

  // ═══════════════════════════════════════════════════════════
  // CATEGORY: Technical
  // ═══════════════════════════════════════════════════════════

  // ── HTTPS ─────────────────────────────────────────────────
  const isHttps = pageData.url.startsWith('https://');
  if (!isHttps) {
    add('Technical', 'HTTPS', 'fail',
      'Site is not using HTTPS.',
      'Google has used HTTPS as a ranking signal since 2014. Browsers also show a "Not Secure" warning on HTTP pages, which damages trust and increases bounce rate.');
  } else {
    add('Technical', 'HTTPS', 'pass', 'Site is served over HTTPS.');
  }

  // ── Viewport Meta (mobile-friendliness) ──────────────────
  const viewport = $('meta[name="viewport"]').attr('content');
  if (!viewport) {
    add('Technical', 'Viewport / Mobile', 'fail',
      'No viewport meta tag found.',
      'Without a viewport tag, mobile devices render the page at desktop width — making it tiny and unusable. Google uses mobile-first indexing, so this directly impacts rankings. Add: <meta name="viewport" content="width=device-width, initial-scale=1">');
  } else {
    add('Technical', 'Viewport / Mobile', 'pass',
      `Viewport set: "${viewport}"`);
  }

  // ── Response Time ─────────────────────────────────────────
  if (responseTimeMs !== undefined) {
    if (responseTimeMs > 3000) {
      add('Technical', 'Page Load Speed', 'fail',
        `Slow server response: ${responseTimeMs}ms`,
        'Google considers pages slower than 3 seconds to have poor user experience. A slow TTFB (time to first byte) usually points to slow hosting or unoptimised server code. Consider upgrading hosting or adding a CDN.');
    } else if (responseTimeMs > 1500) {
      add('Technical', 'Page Load Speed', 'warn',
        `Server response: ${responseTimeMs}ms — could be faster.`,
        'Aim for under 1500ms server response time. Consider caching, image optimisation, and a faster host.');
    } else {
      add('Technical', 'Page Load Speed', 'pass',
        `Fast server response: ${responseTimeMs}ms`);
    }
  }

  // ─── Inline Scripts / Render-blocking ────────────────────
  const blockingScripts = $('head script:not([async]):not([defer]):not([type="application/ld+json"])').length;
  if (blockingScripts > 0) {
    add('Technical', 'Render-Blocking Scripts', 'warn',
      `${blockingScripts} render-blocking script(s) in <head>.`,
      'Scripts in <head> without async or defer block the browser from rendering the page until they download and run. Add async or defer attributes, or move scripts to before </body>.');
  } else {
    add('Technical', 'Render-Blocking Scripts', 'pass',
      'No render-blocking scripts in <head>.');
  }

  // ═══════════════════════════════════════════════════════════
  // CATEGORY: Crawlability
  // ═══════════════════════════════════════════════════════════

  // ── Internal Links ────────────────────────────────────────
  let internalLinks = 0;
  let externalLinks = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('/') || href.startsWith(baseUrl)) {
      internalLinks++;
    } else if (href.startsWith('http')) {
      externalLinks++;
    }
  });
  add('Crawlability', 'Internal Links', internalLinks > 2 ? 'pass' : 'warn',
    `${internalLinks} internal links, ${externalLinks} external links.`,
    internalLinks <= 2
      ? 'Very few internal links found. Internal links help Google discover other pages on your site and distribute authority across your content.'
      : 'Good internal linking. Keep it up — internal links help Google crawl and understand your site structure.');

  // ── robots.txt ────────────────────────────────────────────
  if (!robotsTxt) {
    add('Crawlability', 'robots.txt', 'warn',
      'No robots.txt found at /robots.txt.',
      'A robots.txt file tells search engine crawlers which parts of your site to crawl or skip. Without one, crawlers may waste time on low-value pages.');
  } else {
    const { pageBlocked, sitewideBlock } = checkRobotsForUrl(robotsTxt, pageData.url);
    if (sitewideBlock && pageBlocked) {
      add('Crawlability', 'robots.txt', 'fail',
        'robots.txt is blocking all search engines from the entire site.',
        'Your robots.txt contains "User-agent: *" with "Disallow: /" — this prevents Google from crawling every page. This is a critical error, often left over from a staging environment. Remove or correct the Disallow: / rule immediately.');
    } else if (pageBlocked) {
      let blockedPath;
      try { blockedPath = new URL(pageData.url).pathname; } catch { blockedPath = pageData.url; }
      add('Crawlability', 'robots.txt', 'fail',
        `This page (${blockedPath}) is blocked by robots.txt.`,
        'A Disallow rule in robots.txt prevents Google from crawling this specific URL. If this page should appear in search results, update or remove the matching Disallow rule.');
    } else {
      add('Crawlability', 'robots.txt', 'pass', 'robots.txt found — this page is crawlable.');
    }
  }

  // ── sitemap.xml ───────────────────────────────────────────
  if (!sitemap) {
    add('Crawlability', 'sitemap.xml', 'warn',
      'No sitemap.xml found at /sitemap.xml.',
      'A sitemap tells Google about all the pages on your site and when they were last updated. It is especially important for sites with many pages or new sites with few inbound links.');
  } else {
    // Count URLs in sitemap
    const urlCount = (sitemap.match(/<url>/g) || []).length;
    add('Crawlability', 'sitemap.xml', 'pass',
      `sitemap.xml found${urlCount > 0 ? ` — ${urlCount} URL(s) listed` : ''}.`);
  }

  return results;
}

module.exports = { runSEOChecks };
