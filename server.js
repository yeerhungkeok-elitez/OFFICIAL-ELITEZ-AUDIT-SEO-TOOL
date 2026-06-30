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
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

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
// AI AGENT — Claude-powered content generation
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
let anthropicClient = null;
try {
  if (process.env.ANTHROPIC_API_KEY) anthropicClient = new Anthropic();
} catch {}

// Comprehensive system prompt (~5000+ tokens) to exceed the 4096-token cache threshold.
const AGENT_SYSTEM_PROMPT = `You are an elite SEO strategist and GEO (Generative Engine Optimisation) expert with 15+ years of experience helping B2B and B2C brands achieve top search rankings and prominent placement in AI-generated answers (ChatGPT, Google SGE, Perplexity, Bing Copilot). You combine technical SEO mastery, persuasive copywriting, structured data expertise, and deep knowledge of how large language models retrieve and cite content.

## Your Core Competencies

### Traditional SEO
- Title tag optimisation: 50–60 characters, front-load keyword, include brand when space allows, use power words (Best, Guide, Expert, Trusted) that improve CTR
- Meta description optimisation: 140–160 characters, include target keyword naturally, add a clear CTA (Learn more, Get a free quote, See pricing), and a unique value proposition
- H1 strategy: one per page, exact or close-variant match to primary keyword, clear and compelling without keyword stuffing
- Heading hierarchy: H1 → H2 → H3 logical flow, each heading should be a scannable answer to a user intent
- Content structure: intro paragraph that answers the query in the first 100 words, then supporting sections, then FAQs, then CTA
- Word count guidelines: Informational pages 1,200–2,500 words; commercial pages 600–1,200 words; landing pages 400–800 words focused on conversion
- E-E-A-T signals: first-hand experience, named authors, credentials, citations, trust badges, case studies, testimonials
- Internal linking: contextual anchor text that describes the destination page, avoid generic anchors like "click here"
- Image optimisation: descriptive alt text with keyword, compressed file sizes, descriptive filenames
- Core Web Vitals: LCP under 2.5s, FID/INP under 100ms, CLS under 0.1
- Schema markup: Article, FAQ, HowTo, Product, LocalBusiness, Organization schemas increase rich result eligibility
- URL structure: short, hyphenated, keyword-rich, no stop words, consistent lowercase

### GEO (Generative Engine Optimisation)
GEO is the practice of structuring and writing content so that AI systems (LLMs) are likely to retrieve, cite, and summarise your page when answering user queries. Key principles:
- Direct answer format: begin sections with a clear, concise statement that directly answers the question — AI models prefer content that gets to the point immediately
- Definition paragraphs: start with "X is..." or "X refers to..." so LLMs can extract clean definitions
- Structured answers: use the "Question → Direct Answer → Supporting Detail → Evidence" format
- Conversational phrasing: write as if answering a spoken question; AI assistants pull conversational phrasing more readily
- FAQ schema: properly marked-up FAQs with concise answers under 100 words each are prime LLM retrieval targets
- Named entities: mention your brand, location, credentials, and partners explicitly — LLMs use entity disambiguation to attribute credibility
- Comparison framing: "X vs Y" content is frequently retrieved by AI for comparison queries
- Statistics and data: concrete numbers, percentages, timeframes make content more citable
- Source credibility signals: mention publications, certifications, years of operation, client counts
- Summary paragraphs: a "Key Takeaways" or "In Summary" section at the bottom of each page gives AI a clean excerpt to quote
- Avoiding ambiguity: write so that each sentence stands alone; AI models pull fragments, not full articles

### Content Optimisation Strategy
When optimising a page for a target keyword:
1. Analyse the current page title and construct an improved version that is 50–60 characters, leads with the keyword, and includes the brand
2. Write a meta description of 140–160 characters with the keyword in the first 80 characters, a value proposition, and a CTA
3. Craft an H1 that is compelling, includes the keyword naturally, and is distinct from the title tag
4. Propose 4–6 H2 subheadings that cover the main user intent sub-topics around the keyword (these should map to the questions people actually ask)
5. For each H2, suggest 2–3 key points or bullet ideas to expand into full paragraphs
6. Recommend an FAQ section with 5 questions and concise direct answers

### Page Fix Recommendations
When given a list of failed and warning SEO checks for a page:
1. Prioritise fixes by impact: Critical (title/meta/H1/canonicals) > High (schema, Core Web Vitals) > Medium (images, word count) > Low (minor warnings)
2. For each issue, provide: (a) the exact problem in one sentence, (b) what to change and the specific recommended value or pattern, (c) the expected SEO benefit
3. Format fixes as numbered steps under clear headings so developers can implement them without interpretation
4. For code-level fixes (schema, canonical tags, robots directives), provide the exact HTML or JSON-LD to paste in

### Internal Linking Strategy
When analysing a set of pages for internal linking opportunities:
1. Identify topical clusters: group pages by subject matter and recommend a pillar-and-cluster model
2. For each link recommendation, specify: Source page → Target page, recommended anchor text, where in the content the link should appear (intro/body/CTA)
3. Anchor text should be descriptive and keyword-rich but natural — avoid over-optimised exact-match anchors on every link
4. Prioritise: high-authority pages linking to commercial pages, new pages receiving links from established pages, pages with many outbound links adding more contextual links to underlinked pages

## Output Format Rules

You MUST structure every response using markdown H2 headings (## Section Title) for each distinct deliverable. This is critical — the UI splits your output on ## to create separate copy-ready cards.

Each section should contain content that can be copied directly and pasted into a CMS, code editor, or schema validator without further editing.

For JSON-LD schema blocks, wrap them in triple backticks with the json language identifier:
\`\`\`json
{ "@context": "https://schema.org", ... }
\`\`\`

For HTML snippets, wrap in triple backticks with html:
\`\`\`html
<meta name="description" content="..." />
\`\`\`

Keep all non-code text concise and direct. No preamble like "Here is your content" or "I have created the following". Start each section with the deliverable immediately.

Never exceed the character limits specified (title 60 chars, meta 160 chars). Always state the character count in parentheses after title and meta suggestions.

When writing content sections, write in the voice of a professional brand — authoritative, clear, benefit-focused. Avoid corporate jargon, passive voice, and filler phrases like "In today's fast-paced world".

For FAQs, write questions as a real user would type them into Google or ask a voice assistant. Answers should be 40–80 words — long enough to be useful, short enough to be extractable by AI.

---

### Ranking Blueprint Framework

When generating a Ranking Blueprint you are acting as a senior SEO consultant producing a complete, strategic ranking plan. Analyse across all 8 dimensions below. For each dimension output:
- **Status**: 🔴 Critical / 🟡 Needs Work / 🟢 Good — based on the actual data provided
- **Findings**: what you observe (reference specific checks that failed or passed)
- **Actions**: numbered, concrete steps — not generic advice
- **Priority tag on each action**: [HIGH], [MEDIUM], or [LOW]
- **Impact** (High / Medium / Low) and **Effort** (Hours / Days / Weeks)

#### Dimension 1 — Search Intent Alignment
Informational intent: user wants to learn → guides, how-to, explainers, 1200+ words
Commercial intent: user is comparing → comparison pages, feature lists, reviews
Transactional intent: user wants to buy/sign up → landing pages with strong CTA, 400–800 words
Navigational intent: user wants a brand → optimise for branded queries
Mismatch signals: blog post ranking for transactional keyword; product page serving informational intent; thin content on high-commercial-intent keyword; no clear CTA on a transactional page; missing trust signals on a conversion page.
Correct intent mismatch by: restructuring the page type, rewriting the intro to match intent, adding or removing CTAs, adjusting content length to fit intent.

#### Dimension 2 — E-E-A-T Signals
Experience: first-hand content (case studies, real project screenshots, named client results, specific numbers from actual work)
Expertise: author bio with credentials, qualifications, industry experience years, LinkedIn profile, published work
Authoritativeness: brand mentioned in industry publications, backlinks from authoritative domains, speaking engagements, partnerships, awards
Trustworthiness: HTTPS enforced, privacy policy present, terms of service, visible contact details (physical address, phone), trust badges, verified reviews, transparent ownership, About Us page
YMYL pages (finance, health, legal, news) require the strongest E-E-A-T signals — Google holds these to the highest standard.
Check for: named authors with bios, date published/updated, credentials stated, case study links, trust badge presence, schema with author/organisation markup.

#### Dimension 3 — Topic Cluster Coverage
Pillar page: one comprehensive page targeting the broad head keyword (2000+ words, covers all subtopics at a high level)
Cluster pages: individual deep-dive pages on each subtopic, linking back to the pillar and to each other
Identify gaps by: listing the main subtopics of the target keyword and checking which are covered by crawled pages
Keyword cannibalization: multiple pages targeting the same keyword — consolidate or differentiate with canonical tags
Internal link structure: cluster pages should receive links from the pillar; pillar should link out to all cluster pages
Missing content types: if site has a service page but no case studies, how-to guides, or FAQs around that service, those are cluster gaps.

#### Dimension 4 — Technical SEO Priorities
Critical (fix immediately): missing/duplicate title tags, missing meta descriptions, multiple H1s, missing canonical, pages set to noindex unintentionally, broken internal links, HTTP not redirecting to HTTPS, pages blocked by robots.txt unintentionally
High (fix within 2 weeks): missing schema markup, missing Open Graph tags, images without alt text, slow server response time (TTFB > 600ms), render-blocking resources
Medium (fix within 30 days): image compression, lazy loading, unused JavaScript, Core Web Vitals (LCP > 2.5s, CLS > 0.1), mobile usability issues
Low (fix within 90 days): minor HTML validation errors, excessive DOM size, third-party script auditing

#### Dimension 5 — Authority Signals (Backlink Readiness)
Since direct backlink data is not available, assess link-earning readiness:
Linkable assets present: original research, industry surveys, free tools, calculators, comprehensive guides, unique data, infographics
Digital PR opportunities: expert commentary angles, data stories journalists would cover, industry trend analysis
Partnership opportunities: complementary non-competing businesses for co-marketing, guest posts, resource page listings
Citation worthiness: does the content contain quotable statistics, named expert opinions, or unique frameworks?
Recommend: creating at least one linkable asset per topic cluster; outreach target types specific to the industry; resource page inclusion strategy; broken link building opportunities in the niche.

#### Dimension 6 — Content Freshness
Evergreen content (how-to guides, tutorials, service pages): review annually, update statistics, examples, and screenshots
Time-sensitive content (news, trend pieces, pricing pages): should reflect current year; stale if referencing pre-2023 data without update notice
Freshness signals to add: "Last updated: [month year]" visible near the top, dateModified in Article schema, current year in title where appropriate, fresh statistics with source citations
Stale content indicators: references to outdated tools/technologies, old statistics, product versions that no longer exist, competitor comparisons that are outdated, events that have passed

#### Dimension 7 — Keyword Strategy Gaps
Primary keyword optimisation: is the exact keyword or close variant in the title, H1, first paragraph, and at least one subheading?
Secondary keywords: related terms and synonyms that should appear naturally throughout
Long-tail opportunities: question-based queries (how to, what is, best X for Y) that could be answered in FAQ sections or blog posts
Missing page types: if the site has no pillar guide, no comparison page, no FAQ page, no local landing page — flag these as strategic gaps
SERP feature opportunities: FAQ schema (targets People Also Ask), HowTo schema (targets featured snippets), Review schema (targets star ratings), VideoObject schema, Speakable schema for voice search

#### Dimension 8 — Local SEO (when applicable)
Google Business Profile: claimed and verified, complete business description with keywords, all categories set, photos uploaded, posts published, Q&A section active
NAP consistency: Name, Address, Phone number identical across website, GBP, and all directory listings (even a comma difference matters)
Local schema markup: LocalBusiness with name, address, telephone, openingHours, geo coordinates, areaServed
Local keyword integration: city/region in title tag, H1, meta description, and naturally in body copy
Local citations: listed in industry-specific and local directories (Yelp, Yellow Pages, TripAdvisor if relevant, niche directories)
Reviews strategy: respond to every review within 24 hours, actively encourage reviews from satisfied customers, embed Google reviews widget on site
Local content: neighbourhood-specific landing pages, local case studies, coverage of local events, locally-relevant blog content
If the business is not local (SaaS, global ecommerce, online-only), state "Not applicable — national/global business" and skip this section.

#### STRICT ACTION FORMAT — mandatory for every action in every section

Every action you write — inside a dimension section AND in the Master Action Plan — MUST include ALL five of these fields. If you cannot provide all five, do not write the action.

🔴 HIGH | [Action Title] | Impact: High | Effort: Hours
– Page: /exact/page/path/ (use the real URL or path provided)
– Section: exact element or content area (e.g., <title> tag, H1, paragraph 2, hero CTA, FAQ block, <head> schema, footer nav)
– Add: "the exact copy, text, or code to implement — write the actual words/code, not a description"
– Why: one sentence with a specific ranking mechanism (e.g., "Pages with the keyword in the title's first 3 words have a 15-20% CTR advantage in SERPs")

BANNED PHRASES — never write these. Replace with specific alternatives:
❌ "improve your content" → ✅ "Add a 150-word case study to section 3 showing [specific metric]"
❌ "optimise your meta description" → ✅ write the exact 155-character meta description
❌ "build backlinks" → ✅ "Create a [specific free tool/data study] and pitch to [specific site type]"
❌ "add schema markup" → ✅ provide the complete JSON-LD block
❌ "update your title tag" → ✅ write the exact replacement title
❌ "improve page speed" → ✅ "Remove [specific render-blocking resource] from line X of the <head>"
❌ "create more content" → ✅ "Create a /blog/[specific-slug]/ page targeting '[specific keyword]' — outline: [H2 list]"

For the "Add:" field: write actual copy using the business type, keyword, and page context you've been given. If it's code, write complete, paste-ready code. Make it realistic for the business described.

#### Master Action Plan Format
List every action from all 8 dimensions. Group: 🔴 HIGH first, then 🟡 MEDIUM, then 🟢 LOW.

🔴 HIGH | [Action Title] | Impact: High | Effort: Hours
– Page: /exact/path/
– Section: exact element
– Add: "exact copy or complete code"
– Why: specific ranking rationale with mechanism

🟡 MEDIUM | [Action Title] | Impact: Medium | Effort: Days
– Page: /exact/path/
– Section: exact element
– Add: "exact copy or complete code"
– Why: specific ranking rationale with mechanism

🟢 LOW | [Action Title] | Impact: Low | Effort: Weeks
– Page: /exact/path/
– Section: exact element
– Add: "exact copy or complete code"
– Why: specific ranking rationale with mechanism

#### 30-60-90 Day Roadmap Format
Three bullet-point lists. Reference actions by their title only (no duplication of the full format).
- **Days 1–30 (Foundation)**: all HIGH priority actions
- **Days 31–60 (Growth)**: MEDIUM priority actions + content creation tasks with target URLs
- **Days 61–90 (Scale)**: LOW priority + link building initiation + monitoring setup`;

// Builds the user-turn prompt for each task type

// Builds the user-turn prompt for each task type
function buildAgentPrompt(task, data) {
  const { pageUrl, pagePath, pageTitle, checks, keyword, pages } = data;

  if (task === 'content') {
    const failing = (checks || []).filter(c => c.status === 'fail' || c.status === 'warn')
      .map(c => `- [${c.status.toUpperCase()}] ${c.name}: ${c.detail || c.message || ''}`)
      .join('\n');
    return `Generate a complete Content Optimisation package for the following page.

PAGE URL: ${pageUrl}
PAGE PATH: ${pagePath || '/'}
CURRENT PAGE TITLE: ${pageTitle || '(not found)'}
TARGET KEYWORD: ${keyword || '(none specified — use the most relevant keyword for this page type)'}

CURRENT SEO ISSUES:
${failing || 'None detected'}

Produce the following sections using ## headings:
## Optimised Title Tag
## Meta Description
## H1 Recommendation
## Content Outline (H2 Subheadings with key points)
## FAQ Section (5 questions + answers)
## Quick Wins Summary`;
  }

  if (task === 'geo') {
    const failing = (checks || []).filter(c => c.status === 'fail' || c.status === 'warn')
      .map(c => `- ${c.name}: ${c.detail || ''}`)
      .join('\n');
    return `Generate a GEO (Generative Engine Optimisation) content package for this page to improve its visibility in AI-generated answers.

PAGE URL: ${pageUrl}
PAGE PATH: ${pagePath || '/'}
PAGE TITLE: ${pageTitle || '(not found)'}
TARGET TOPIC / KEYWORD: ${keyword || '(use most relevant topic for this page)'}

CURRENT SEO ISSUES:
${failing || 'None detected'}

Produce the following sections using ## headings:
## Definition Paragraph (Direct Answer)
## Structured Answer Block (Question → Answer → Evidence format)
## AI-Friendly Summary (Key Takeaways — 80–120 words)
## FAQ Schema (JSON-LD with 5 questions — paste-ready)
## GEO Optimisation Tips for This Page`;
  }

  if (task === 'fixes') {
    const issues = (checks || [])
      .filter(c => c.status === 'fail' || c.status === 'warn')
      .map(c => `[${c.status.toUpperCase()}] ${c.name}${c.detail ? ': ' + c.detail : ''}${c.message ? ' — ' + c.message : ''}`)
      .join('\n');
    return `Generate a step-by-step Fix Plan for all issues found on this page.

PAGE URL: ${pageUrl}
PAGE PATH: ${pagePath || '/'}
PAGE TITLE: ${pageTitle || '(not found)'}

ISSUES TO FIX:
${issues || 'No issues found — page is in good shape.'}

For each issue group, create a ## Section heading and provide:
1. What is wrong (one sentence)
2. Exact fix with the specific value/code to use
3. Expected SEO benefit

Use ## headings per issue category. Where HTML or JSON-LD code is needed, provide it in a code block.

End with:
## Priority Order
## Estimated Impact Summary`;
  }

  if (task === 'links') {
    const pageSummaries = (pages || []).slice(0, 30).map(p =>
      `- ${p.path || p.url} | Title: ${p.title || 'n/a'} | Words: ${p.wordCount || 0} | Outbound internal links: ${p.internalLinkCount || 0}`
    ).join('\n');
    const sourcePage = pageUrl ? `Focus on suggestions involving: ${pageUrl} (${pagePath})` : 'Provide site-wide suggestions across all pages.';
    return `Generate Internal Linking recommendations for this website.

${sourcePage}

CRAWLED PAGES (path | title | word count | outbound internal links):
${pageSummaries || 'No pages available — run a crawl first.'}

Produce the following sections using ## headings:
## Topical Clusters Identified
## High-Priority Link Opportunities (Top 10)
## Anchor Text Recommendations
## Pages That Need More Inbound Links
## Implementation Notes`;
  }

  if (task === 'blueprint') {
    const { bizType, location, keyword, pages } = data;
    const allChecks = (checks || []);

    // Extract specific current values from check details for concrete recommendations
    const getDetail = (nameHint) => {
      const c = allChecks.find(c => c.name && c.name.toLowerCase().includes(nameHint.toLowerCase()));
      return c ? (c.detail || c.message || '') : '';
    };
    const currentTitle    = getDetail('title')       || pageTitle || '(not found)';
    const currentMeta     = getDetail('meta desc')   || getDetail('description') || '(not found)';
    const currentH1       = getDetail('h1')          || '(not found)';
    const wordCount       = getDetail('word')        || getDetail('content length') || '(unknown)';
    const schemaStatus    = getDetail('schema')      || '(not detected)';
    const ogStatus        = getDetail('open graph')  || getDetail('og:')  || '(not detected)';
    const canonicalStatus = getDetail('canonical')   || '(not detected)';
    const robotsStatus    = getDetail('robots')      || '(not detected)';
    const lcp             = getDetail('lcp')         || getDetail('largest contentful') || '(unknown)';
    const cls             = getDetail('cls')         || getDetail('cumulative layout') || '(unknown)';

    const failing = allChecks.filter(c => c.status === 'fail')
      .map(c => `  FAIL | ${c.name}${c.detail ? ' | current: "' + c.detail + '"' : ''}`)
      .join('\n');
    const warnings = allChecks.filter(c => c.status === 'warn')
      .map(c => `  WARN | ${c.name}${c.detail ? ' | current: "' + c.detail + '"' : ''}`)
      .join('\n');
    const passing = allChecks.filter(c => c.status === 'pass')
      .map(c => `  PASS | ${c.name}`)
      .join('\n');

    const pageSummaries = (pages || []).slice(0, 20)
      .map(p => `  ${p.path || p.url} | "${p.title || 'no title'}" | ${p.wordCount || 0} words | fails:${p.failCount || 0} warns:${p.warnCount || 0}`)
      .join('\n');

    const isLocal = (bizType || '').includes('local') || (location || '').trim().length > 0;

    return `Generate a Ranking Blueprint for the page below. Every recommendation MUST use the 5-field action format defined in your system prompt (Page / Section / Add / Why). No generic advice.

=== TARGET PAGE ===
URL:             ${pageUrl}
Path:            ${pagePath || '/'}
Business type:   ${bizType || 'not specified'}
Target keyword:  ${keyword || '(infer from URL and title)'}
Target location: ${location || 'none — treat as non-local'}

=== CURRENT PAGE ELEMENTS (use these exact values in recommendations) ===
Title tag:       ${currentTitle}
Meta description:${currentMeta}
H1:              ${currentH1}
Word count:      ${wordCount}
Schema markup:   ${schemaStatus}
Open Graph:      ${ogStatus}
Canonical:       ${canonicalStatus}
Robots meta:     ${robotsStatus}
LCP:             ${lcp}
CLS:             ${cls}

=== AUDIT RESULTS ===
FAILING (${allChecks.filter(c=>c.status==='fail').length} checks):
${failing || '  None'}

WARNINGS (${allChecks.filter(c=>c.status==='warn').length} checks):
${warnings || '  None'}

PASSING (${allChecks.filter(c=>c.status==='pass').length} checks):
${passing || '  None'}

=== OTHER PAGES ON THIS SITE ===
${pageSummaries || '  No other pages crawled'}

=== OUTPUT FORMAT ===
Use these ## headings in this exact order:

## Search Intent Alignment
## E-E-A-T Signals
## Topic Cluster Coverage
## Technical SEO Priorities
## Authority Signals
## Content Freshness
## Keyword Strategy
## Local SEO
## Master Action Plan
## 30-60-90 Day Roadmap

Rules:
- Each dimension section: open with 🔴/🟡/🟢 status line, then findings, then action items using the 5-field format
- Reference the EXACT current title/meta/H1 values above when recommending replacements
- Write the REPLACEMENT TEXT, not instructions to rewrite
${!isLocal ? '- For "Local SEO": open with "🔵 Not Applicable — non-local business" and move on' : '- Include a complete Local SEO analysis'}
- Master Action Plan: aggregate ALL actions from all sections in the 5-field format, grouped HIGH → MEDIUM → LOW
- Zero generic advice — every action targets this specific page and keyword`;
  }

  if (task === 'optimization-cycle') {
    const { siteUrl, periodDays, dates, drops, ctrDrops, opportunities, rising, totals } = data;

    const fmtPos = n => (n && !isNaN(n)) ? Number(n).toFixed(1) : '—';
    const fmtCtr = n => (n && !isNaN(n)) ? (Number(n) * 100).toFixed(1) + '%' : '—';
    const fmtPct = (curr, prev) => {
      if (!prev) return '';
      const p = ((curr - prev) / prev * 100);
      return (p >= 0 ? '+' : '') + p.toFixed(0) + '%';
    };

    const dropsText = (drops || []).slice(0, 12).map(d =>
      `  - "${d.query}": pos ${fmtPos(d.oldPos)} → ${fmtPos(d.newPos)} (${Number(d.delta).toFixed(1)}), ${d.clicks || 0} clicks, ${d.impressions || 0} impr`
    ).join('\n');

    const ctrText = (ctrDrops || []).slice(0, 10).map(d =>
      `  - "${d.query}": CTR ${fmtCtr(d.oldCtr)} → ${fmtCtr(d.newCtr)}, pos ${fmtPos(d.position)}, ${d.impressions || 0} impr`
    ).join('\n');

    const oppText = (opportunities || []).slice(0, 15).map(o =>
      `  - "${o.query}": ${o.impressions || 0} impr, pos ${fmtPos(o.position)}, CTR ${fmtCtr(o.ctr)}${o.isNew ? ' [NEW]' : ''}`
    ).join('\n');

    const risingText = (rising || []).slice(0, 10).map(r =>
      `  - "${r.query}": pos ${fmtPos(r.oldPos)} → ${fmtPos(r.newPos)} (+${Math.abs(r.delta).toFixed(1)} places), ${r.clicks || 0} clicks`
    ).join('\n');

    const cl = totals?.clicks || {};
    const im = totals?.impressions || {};
    const po = totals?.position || {};
    const ct = totals?.ctr || {};

    return `Run an SEO Optimization Cycle for ${siteUrl}.

=== ANALYSIS PERIOD ===
Current:  ${dates?.current?.start} → ${dates?.current?.end} (${periodDays} days)
Previous: ${dates?.previous?.start} → ${dates?.previous?.end} (comparison)

=== OVERALL PERFORMANCE DELTA ===
Clicks:      ${cl.current || 0} vs ${cl.previous || 0} (${cl.delta >= 0 ? '+' : ''}${cl.delta || 0}, ${fmtPct(cl.current, cl.previous)})
Impressions: ${im.current || 0} vs ${im.previous || 0} (${im.delta >= 0 ? '+' : ''}${im.delta || 0}, ${fmtPct(im.current, im.previous)})
Avg. position: ${fmtPos(po.previous)} → ${fmtPos(po.current)} ${po.current < po.previous ? '(improved)' : po.current > po.previous ? '(dropped)' : '(same)'}
Avg. CTR: ${fmtCtr(ct.previous)} → ${fmtCtr(ct.current)}

=== RANKING DROPS — ${(drops || []).length} queries fell >2 positions ===
${dropsText || '  None detected'}

=== CTR DROPS — ${(ctrDrops || []).length} queries lost >15% click-through rate ===
${ctrText || '  None detected'}

=== HIGH-VALUE OPPORTUNITIES — ${(opportunities || []).length} queries with untapped traffic ===
${oppText || '  None detected'}

=== RISING KEYWORDS — ${(rising || []).length} queries improving ===
${risingText || '  None detected'}

=== OUTPUT FORMAT ===
Produce EXACTLY these ## sections in order. Use the 5-field action format (Page / Section / Add / Why) for all specific page fixes. For query-level actions where no page is known, infer the most likely ranking page from the domain and query.

## This Week's Priorities
Top 5 highest-impact actions. Mix of recovery (drops), CTR fixes, and opportunity capture. Every action must be specific and executable within a week.

## Ranking Recovery Plan
One action per significant drop. Diagnose the probable cause (content relevance, competitor improvement, lost backlink, thin content, etc.). Write the exact change to make.

## CTR Improvement Actions
For each CTR drop: write the exact replacement title tag AND meta description (with character counts). Explain why the new version should improve CTR.

## Content Opportunities
For each high-opportunity query: specify exact new page slug, content type, target keyword, and a 4-H2 content outline. Sort by expected traffic impact.

## Quick Wins
Actions under 2 hours each that can be done immediately. Title tags, meta rewrites, schema additions, internal links.

## What's Working
Highlight rising keywords and strategies to reinforce. Keep these going.`;
  }

  if (task === 'fix-pack') {
    const { bizType, location, keyword, pages } = data;
    const allChecks = (checks || []);

    const getDetail = (hint) => {
      const c = allChecks.find(c => c.name && c.name.toLowerCase().includes(hint.toLowerCase()));
      return c ? (c.detail || c.message || '') : '';
    };
    const currentTitle  = getDetail('title')     || pageTitle || '(not found)';
    const currentMeta   = getDetail('meta desc')  || getDetail('description') || '(not found)';
    const currentH1     = getDetail('h1')         || '(not found)';
    const schemaStatus  = getDetail('schema')     || 'none detected';
    const wordCount     = getDetail('word')       || '(unknown)';

    const failing = allChecks.filter(c => c.status === 'fail' || c.status === 'warn')
      .map(c => `  - ${c.name}${c.detail ? ': ' + c.detail : ''}`)
      .join('\n');

    const linkContext = (pages || []).slice(0, 15)
      .filter(p => !p.fetchError)
      .map(p => `  ${p.path || p.url} — "${p.title || 'no title'}"`)
      .join('\n');

    const isLocal = (bizType || '').includes('local') || (location || '').trim().length > 0;

    return `Generate a Fix Pack for the page below. Every section must contain complete, paste-ready HTML or JSON-LD code. Write REAL copy — no placeholders.

=== PAGE ===
URL:            ${pageUrl}
Path:           ${pagePath || '/'}
Current title:  ${currentTitle}
Current meta:   ${currentMeta}
Current H1:     ${currentH1}
Target keyword: ${keyword || '(infer from URL and title)'}
Business type:  ${bizType || 'professional services'}
Location:       ${location || 'not specified'}
Word count:     ${wordCount}
Schema status:  ${schemaStatus}

=== CURRENT ISSUES ===
${failing || '  None detected'}

=== OTHER PAGES (for internal linking) ===
${linkContext || '  No other pages crawled'}

=== OUTPUT FORMAT ===
Use EXACTLY these ## headings in this order. For every code section, wrap in triple backticks with the language tag.

## Title Tag
The replacement <title> tag as complete HTML. Requirements: 50–60 characters (state the count), keyword in first 3 words, brand name at the end after a pipe. Then one sentence explaining the change.

## Meta Description
The replacement <meta name="description"> as complete HTML. Requirements: 140–160 characters (state the count), keyword in first 70 characters, ends with a CTA. Then one sentence explaining the change.

## H1 Tag
The replacement <h1> as complete HTML. Requirements: different from the title tag, compelling, keyword included naturally. Then one sentence explaining the change.

## FAQ Section
A complete HTML FAQ section using <section>, <h2>, and a proper question/answer structure. Include 5 questions a real user would type into Google. Each answer: 50–80 words written for both users and AI extraction. Format as a <dl> list with <dt> for questions and <dd> for answers, plus add id attributes for anchor linking.${isLocal ? `

## Local Business Schema
A complete <script type="application/ld+json"> block with LocalBusiness schema including the keyword, location "${location}", address (use plausible placeholder if unknown), telephone, openingHours, and areaServed.` : `

## Schema Markup
A complete <script type="application/ld+json"> block using the most appropriate schema type (FAQPage is mandatory since we wrote FAQs above; also include Article or Service as a second schema if applicable). Use the actual page URL, title, and content from this prompt.`}

## Internal Link Suggestions
Five complete HTML anchor tags with realistic, keyword-rich anchor text. Format each as:
<a href="/path-from-list-above/">anchor text</a> — Place in: [exact location on page, e.g. "paragraph 2, after the main benefit statement"]
Use only paths from the "OTHER PAGES" list above. If fewer than 5 pages are available, use what's there.

## Fix Pack Summary
Plain text (no code). For each section above, one bullet explaining: what was changed, what it fixes, and which ranking factor it improves. Suitable for sending to a developer or content manager.`;
  }

  if (task === 'rank-gap-diagnosis') {
    const { keyword, country, targetPage, category, competitors, position, rankingPage, clicks, impressions, ctr } = data;
    const fmtCtr = n => (n && !isNaN(n)) ? (Number(n) * 100).toFixed(1) + '%' : '0%';
    const posText = position ? `#${position}` : 'Not ranking (outside top 100)';
    const rankingPageText = rankingPage || 'No page found in GSC';
    const targetPageText = targetPage || 'Not specified';

    return `You are an expert SEO consultant. Diagnose why the target page is not ranking on Page 1 for the target keyword, and produce a prioritized action blueprint.

=== TARGET ===
Keyword: ${keyword}
Country: ${country}
Target Page: ${targetPageText}
Business/Service Category: ${category || 'Not specified'}
Current Position: ${posText}
Ranking Page (GSC): ${rankingPageText}
GSC Metrics: ${clicks || 0} clicks, ${impressions || 0} impressions, CTR: ${fmtCtr(ctr)}
Competitor URLs: ${competitors || 'None provided'}

=== DIAGNOSIS INSTRUCTIONS ===
Analyse all 10 gap areas. For each area that is a genuine problem, diagnose it and provide a specific fix. Skip areas that are not applicable. Be concrete — name the exact element to change, copy to write, or structure to add.

Gap areas to evaluate:
1. Search Intent Mismatch — does the page content and format match what users expect for this query?
2. Weak Title / Meta / H1 — are these optimised for the keyword and compelling to click?
3. Thin or Off-Target Content — is there enough depth, relevance, and keyword coverage?
4. Missing FAQ / People Also Ask — are common user questions answered?
5. Weak Internal Links — is there a topic cluster, does the page receive internal links from related pages?
6. GEO / AI Readiness — are there answer blocks, FAQ schema, citations, structured data for AI extraction?
7. E-E-A-T Signals — does the page demonstrate experience, expertise, authority, and trust?
8. Technical SEO Issues — Core Web Vitals, mobile, indexing, structured data errors
9. No Topic Cluster — missing supporting pages, pillar strategy, or content silos
10. Authority / Backlink Gap — is the page under-linked compared to Page 1 results?

=== OUTPUT FORMAT ===
Use EXACTLY these ## sections in this order.

## Ranking Gap Summary
2-3 sentences. The #1 reason this keyword is not on Page 1 and the most important action to take first.

## Gap Diagnosis
For each gap area that is a real problem (skip if not applicable):
### [Gap Area Name]
- Current state: [what is wrong or missing]
- Fix: [exact action — be specific, name elements, copy, structure]
- Priority: HIGH / MEDIUM / LOW

## Page 1 Ranking Blueprint
Prioritized action plan using EXACTLY this format for each action:

🔴 HIGH | [Action Title] | Impact: High | Effort: [Low/Med/High]
– Page: [target page path or URL]
– Section: [where on the page — e.g. "Title tag", "H1", "Introduction paragraph"]
– Add: [exactly what to write or add]
– Why: [why this action moves the needle for this specific keyword]

🟡 MEDIUM | [Action Title] | Impact: Med | Effort: [Low/Med/High]
– Page: [page]
– Section: [section]
– Add: [what to add]
– Why: [why]

🟢 LOW | [Action Title] | Impact: Low | Effort: [Low/Med/High]
– Page: [page]
– Section: [section]
– Add: [what to add]
– Why: [why]

Produce at minimum 3 HIGH actions, 3 MEDIUM actions, and 2 LOW actions. Every action must be executable within a week by a content manager or developer.`;
  }

  if (task === 'rank-auto-fixes') {
    const { keyword, country, targetPage, category, pageTitle, position } = data;
    const posText = position ? `Currently ranking at #${position}` : 'Not currently ranking in top 100';

    return `You are an expert SEO copywriter. Generate complete, copy-ready content fixes to help this page rank on Page 1.

=== TARGET ===
Keyword: ${keyword}
Country: ${country}
Target Page: ${targetPage || 'Not specified'}
Current Page Title: ${pageTitle || 'Unknown'}
Business/Service Category: ${category || 'Professional services'}
Ranking Status: ${posText}

=== INSTRUCTIONS ===
Write REAL copy — no placeholders, no [brackets], no generic examples. Every element must be complete and immediately usable. Character counts must be met exactly.

=== OUTPUT FORMAT ===
Use EXACTLY these ## headings in this order.

## SEO Title
The complete replacement <title> tag as HTML. Requirements: 50–60 characters (state the exact count in parentheses), keyword in the first 3 words, brand separator using | at the end. Then one sentence explaining what changed.

## Meta Description
The complete replacement <meta name="description" content="..."> tag as HTML. Requirements: 140–160 characters (state count), keyword within the first 70 characters, ends with a clear call to action. Then one sentence explaining what changed.

## H1 Tag
The complete replacement <h1> tag as HTML. Requirements: different wording from the title, naturally contains the keyword, benefit-led and compelling. Then one sentence explaining what changed.

## Intro Paragraph
A 150–200 word introduction paragraph. Requirements: keyword appears in the first sentence, includes a credibility signal (years, clients, results), ends with a transition sentence. Write it as final copy — no instructions, just the text.

## FAQ Section
5 questions a real user would type into Google for this keyword. Format as complete HTML using <dl><dt><dd> structure with id attributes for anchor linking. Each answer: 60–80 words, written for both users and AI extraction.

## Internal Link Suggestions
5 internal link suggestions. Format each as:
<a href="/suggested-path/">keyword-rich anchor text</a> — Place in: [exact location on page]
Make the paths realistic for a ${category || 'professional services'} business.

## Schema Markup
A complete <script type="application/ld+json"> block. Include FAQPage schema (using the FAQs above) and the most appropriate business schema type for "${category || 'professional services'}".

## GEO Answer Block
A 2–3 sentence paragraph optimised for AI citation and featured snippets. Start the first sentence with the exact keyword phrase. Write it as a direct, factual answer a user would want extracted by an AI.`;
  }

  if (task === 'rank-roadmap') {
    const { keyword, country, targetPage, category, position, status, pendingTasks } = data;
    const posText = position ? `Currently ranking at position #${position}` : 'Not currently ranking in top 100';
    const statusText = status || 'Unknown';
    const pendingSection = pendingTasks && pendingTasks !== 'None yet — run AI Diagnosis first'
      ? `\n=== PENDING BLUEPRINT ACTIONS ===\n${pendingTasks}\n` : '';

    return `You are an expert SEO strategist. Create a realistic 30/60/90-day ranking roadmap for this target keyword.

=== TARGET ===
Keyword: ${keyword}
Country: ${country}
Target Page: ${targetPage || 'Not specified'}
Business/Service Category: ${category || 'Professional services'}
Ranking Status: ${posText} (${statusText})
${pendingSection}
=== INSTRUCTIONS ===
Create a concrete, action-oriented 3-phase roadmap. Each phase should build on the previous one. Be specific — name exact actions, not generic advice. Tailor the timeline to the current position: if already ranking Page 2, focus on conversion signals; if not ranking, start with technical fundamentals. If pending blueprint actions are listed above, incorporate them into the appropriate phase. Use bullet points inside each phase.

=== OUTPUT FORMAT ===
Use EXACTLY these three ## headings. Do not add any other top-level headings.

## Day 30 — Foundation
What to complete in the first 30 days. Focus on: on-page fixes (title, meta, H1, intro), technical quick wins, and content gap closures. Each action should be completable by one person in a week.

## Day 60 — Authority & Signals
What to complete in days 31–60. Focus on: internal linking, content depth, schema, external signals (mentions, links), and user engagement improvements.

## Day 90 — Review & Accelerate
What to complete in days 61–90. Focus on: position snapshot, content refresh based on GSC data, building topical clusters, and conversion rate improvements for ranking pages.`;
  }

  return 'Analyse this page and provide SEO recommendations.';
}

// POST /api/agent/generate — streams Claude output as SSE
app.post('/api/agent/generate', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      emit({ type: 'error', message: 'ANTHROPIC_API_KEY is not configured. Add it to your .env file and restart the server.' });
      return res.end();
    }
    if (!anthropicClient) {
      anthropicClient = new Anthropic();
    }

    const { task, pageUrl, pagePath, pageTitle, checks, keyword, pages } = req.body;

    if (!task) {
      emit({ type: 'error', message: 'No task specified.' });
      return res.end();
    }

    const userPrompt = buildAgentPrompt(task, req.body);
    emit({ type: 'start', task });

    const stream = anthropicClient.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: Math.min(Number(req.body.maxTokens) || 4096, 8192),
      system: [{ type: 'text', text: AGENT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        emit({ type: 'chunk', text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    emit({ type: 'done', usage: final.usage });
  } catch (err) {
    emit({ type: 'error', message: err.message || 'Unknown error from Claude API.' });
  } finally {
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nSEO Audit Tool  →  http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.\n');
});
