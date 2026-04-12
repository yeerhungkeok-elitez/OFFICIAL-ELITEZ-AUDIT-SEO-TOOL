// scoring.js
// Weighted percentage scoring for the SEO Audit Tool.
//
// Formula:
//   score = (earned points / possible points) × 100
//
//   pass → earns full weight
//   warn → earns half weight  (partial credit — something is there but imperfect)
//   fail → earns 0
//   info → excluded from scoring entirely
//
// This means a site with 628 passes and 20 fails gets a score that reflects
// the actual ratio, not a collapsed-to-zero penalty accumulation.

// ── Check weights ─────────────────────────────────────────────────────────────
// Higher = more important for SEO or conversion.
// Grouped by impact tier so you can see the reasoning at a glance.

const CHECK_WEIGHTS = {

  // ── CRITICAL (12–15) — missing these directly harms indexing / trust ────────
  'HTTPS':              15,  // Google ranks HTTPS higher; browsers warn on HTTP
  'noindex Tag':        15,  // A noindex page cannot rank — highest severity
  'Page Title':         15,  // Single most important on-page SEO element
  'H1 Tag':             12,  // Primary keyword signal for the page
  'Viewport / Mobile':  12,  // Google uses mobile-first indexing

  // ── HIGH (7–10) — major ranking factors ────────────────────────────────────
  'Meta Description':    8,  // Directly affects CTR from search results
  'Value Proposition':   8,  // Conversion: visitors leave if unclear
  'Clear CTA':           8,  // Conversion: no CTA = no leads
  'Page Load Speed':     7,  // Core Web Vital; affects both ranking and bounce rate
  'Word Count':          7,  // Thin content rarely ranks well
  'Contact Info':        6,  // Conversion: trust + accessibility

  // ── MEDIUM (4–5) — meaningful but not show-stopping ────────────────────────
  'Canonical Tag':       5,  // Duplicate content risk without it
  'Image Alt Text':      5,  // Accessibility + image search ranking signal
  'Target Audience Clear': 5,// Conversion: visitors self-qualify
  'Clear Next Step':     5,  // Conversion: guides visitors to act
  'Form Present':        5,  // Conversion: lead capture
  'robots.txt':          4,  // Crawl guidance; blocks all = critical, missing = medium
  'sitemap.xml':         4,  // Helps Google discover all pages
  'Internal Links':      4,  // Helps Google understand site structure

  // ── LOW (2–3) — good practice; less direct ranking impact ──────────────────
  'Heading Structure':   3,  // Readability + semantic structure
  'Schema Markup':       3,  // Enables rich results; not a direct ranking factor
  'Open Graph Tags':     3,  // Social sharing; no direct SEO ranking impact
  'Render-Blocking Scripts': 3, // Performance signal
  'Trust Signals':       3,  // Conversion: social proof
};

// Weight used for any check not listed above
const DEFAULT_WEIGHT = 2;

// ── Core formula ──────────────────────────────────────────────────────────────
// Accepts an array of check results and returns a 0–100 score.
function weightedScore(checks) {
  let earned   = 0;
  let possible = 0;

  for (const c of checks) {
    if (c.status === 'info') continue;            // purely informational — don't score

    const w = CHECK_WEIGHTS[c.check] ?? DEFAULT_WEIGHT;
    possible += w;

    if      (c.status === 'pass') earned += w;        // full credit
    else if (c.status === 'warn') earned += w * 0.5;  // half credit
    // fail → 0 credit (no else needed)
  }

  if (possible === 0) return 100; // nothing scored = nothing wrong
  return Math.round((earned / possible) * 100);
}

// ── Score tier labels ─────────────────────────────────────────────────────────
function scoreTier(score) {
  if (score >= 90) return { label: 'Excellent',          colour: '#16a34a' };
  if (score >= 75) return { label: 'Strong',             colour: '#22c55e' };
  if (score >= 50) return { label: 'Needs Improvement',  colour: '#f59e0b' };
  if (score >= 25) return { label: 'Poor',               colour: '#f97316' };
  return                  { label: 'Critical',           colour: '#dc2626' };
}

// ── Site-wide summary scores from a full crawl ───────────────────────────────
// allResults = array of page result objects from crawler
function buildScoreSummary(allResults) {
  if (!allResults || allResults.length === 0) {
    return { overall: 100, seo: 100, conversion: 100 };
  }

  // Aggregate SEO checks and conversion checks separately
  const seoChecks  = allResults.flatMap(r => r.checks     || []);
  const convChecks = allResults.flatMap(r => r.convChecks || []);

  const seo  = weightedScore(seoChecks);
  // If no conversion checks were run (e.g. crawl only scored homepage), fall back to SEO score
  const conv = convChecks.length > 0 ? weightedScore(convChecks) : seo;

  // Overall: SEO-weighted because this is primarily an SEO tool
  const overall = Math.round(seo * 0.7 + conv * 0.3);

  return { overall, seo, conversion: conv };
}

module.exports = { weightedScore, scoreTier, buildScoreSummary, CHECK_WEIGHTS, DEFAULT_WEIGHT };
