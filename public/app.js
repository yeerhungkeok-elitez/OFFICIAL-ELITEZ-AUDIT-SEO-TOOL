/* app.js — SEO Audit Tool frontend
 *
 * Uses EventSource (Server-Sent Events) so the browser sees results
 * stream in live, one page at a time, as the server crawls the site.
 *
 * Two result views:
 *   "Issues by Type" — each issue type as a collapsible group, listing
 *                      every affected page underneath it.
 *   "Pages"          — one row per crawled page, expandable to show
 *                      every issue found on that page.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let es          = null;   // active EventSource
let allPages    = [];     // accumulated page results
let maxPages    = 50;
let startUrl    = '';

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function showView(name) {
  ['empty','crawling','error','results'].forEach(v => {
    $(`view-${v}`).style.display = v === name ? 'block' : 'none';
  });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


function animateNum(el, to, dur = 900) {
  const start = performance.now();
  const raf = (now) => {
    const p = Math.min((now - start) / dur, 1);
    el.textContent = Math.round(to * (1 - Math.pow(1-p, 3)));
    if (p < 1) requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}

// ── Form submit ───────────────────────────────────────────────────────────────
$('audit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('url-input').value.trim();
  if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  startCrawl(url, parseInt($('max-pages').value) || 50);
});

$('stop-btn').addEventListener('click', () => {
  if (es) { es.close(); es = null; }
  finaliseCrawl();
});

// ── Start crawl ───────────────────────────────────────────────────────────────
function startCrawl(url, limit) {
  // Reset state
  allPages  = [];
  startUrl  = url;
  maxPages  = limit;

  // Reset UI
  $('live-results').innerHTML = '';
  $('progress-fill').style.width = '0%';
  $('btn-label').textContent = 'Crawling…';
  $('scan-btn').disabled = true;
  $('stop-btn').style.display = 'inline-block';
  showView('crawling');

  // Open SSE stream
  const params = new URLSearchParams({ url, maxPages: limit });
  es = new EventSource(`/api/crawl/stream?${params}`);

  es.addEventListener('start', (e) => {
    const { url: u } = JSON.parse(e.data);
    $('crawl-headline').textContent = `Crawling ${u}`;
    $('crawl-subline').textContent  = 'Seeding from sitemap.xml…';
  });

  es.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    if (d.phase === 'seeding') {
      $('crawl-subline').textContent = 'Reading sitemap and robots.txt…';
      return;
    }
    const scanned = d.pagesProcessed || 0;
    const queued  = d.queueRemaining || 0;
    const pct     = Math.min(Math.round((scanned / maxPages) * 100), 100);

    $('progress-fill').style.width = pct + '%';
    $('progress-label').textContent = `${scanned} page${scanned !== 1 ? 's' : ''} scanned`;
    $('progress-queue').textContent = queued > 0 ? `${queued} in queue` : '';

    if (d.currentBatch?.length) {
      $('crawl-subline').textContent =
        'Checking: ' + d.currentBatch.map(u => {
          try { return new URL(u).pathname || '/'; } catch { return u; }
        }).join(', ');
    }
  });

  es.addEventListener('page', (e) => {
    const page = JSON.parse(e.data);
    allPages.push(page);
    addLiveRow(page);
  });

  es.addEventListener('done', (e) => {
    const { summary } = JSON.parse(e.data);
    es.close(); es = null;
    finaliseCrawl(summary);
  });

  es.addEventListener('error', (e) => {
    let msg = 'Crawl failed. Check the server console for details.';
    try { const d = JSON.parse(e.data); if (d.message) msg = d.message; } catch {}
    es.close(); es = null;
    $('error-msg').textContent = msg;
    showView('error');
    resetScanBtn();
  });
}

// ── Live row (shown during crawl) ─────────────────────────────────────────────
function addLiveRow(page) {
  const container = $('live-results');

  // Only keep the last 8 rows visible while crawling (keeps it tidy)
  const MAX_LIVE = 8;
  while (container.children.length >= MAX_LIVE) {
    container.removeChild(container.firstChild);
  }

  const row = document.createElement('div');
  row.className = 'live-row';

  const statusCls = page.httpError || page.fetchError ? 's-err' : 's-ok';
  const statusLbl = page.fetchError ? 'ERR' : (page.status || '?');

  const fail = page.issueCount?.fail ?? 0;
  const warn = page.issueCount?.warn ?? 0;

  let counts = '';
  if (page.httpError)    counts = `<span style="color:var(--red)">${page.httpError}</span>`;
  else if (page.fetchError) counts = `<span style="color:var(--red)">Fetch error</span>`;
  else counts = [
    fail > 0 ? `<span style="color:var(--red)">${fail} error${fail>1?'s':''}</span>` : '',
    warn > 0 ? `<span style="color:var(--amber)">${warn} warn${warn>1?'s':''}</span>` : '',
    (fail === 0 && warn === 0) ? '<span style="color:var(--green)">✓ clean</span>' : '',
  ].filter(Boolean).join(' · ');

  row.innerHTML = `
    <span class="live-path">${esc(page.path || '/')}</span>
    <span class="live-status ${statusCls}">${esc(statusLbl)}</span>
    <span class="live-counts">${counts}</span>
    <span class="live-time">${page.responseTimeMs ? page.responseTimeMs + 'ms' : ''}</span>
  `;
  container.appendChild(row);
}

// ── Finalise & render results ─────────────────────────────────────────────────
function finaliseCrawl(summary) {
  $('progress-fill').style.width = '100%';
  resetScanBtn();

  if (allPages.length === 0) {
    $('error-msg').textContent = 'No pages were scanned. The site may have blocked the crawler.';
    showView('error');
    return;
  }

  // Build summary if not provided (e.g. user hit Stop)
  if (!summary) {
    summary = {
      pagesScanned: allPages.length,
      totalFail: allPages.reduce((n,p) => n + (p.issueCount?.fail||0), 0),
      totalWarn: allPages.reduce((n,p) => n + (p.issueCount?.warn||0), 0),
      totalPass: allPages.reduce((n,p) => n + (p.issueCount?.pass||0), 0),
      scores: computeScores(allPages),
    };
  }

  renderResults(summary);
  showView('results');
}

// ── Render the full results panel ─────────────────────────────────────────────
function renderResults(summary) {
  const { pagesScanned, totalFail, totalWarn, totalPass, scores } = summary;

  // Header
  $('res-url').textContent  = startUrl;
  $('res-meta').textContent = `${pagesScanned} page${pagesScanned!==1?'s':''} scanned`;

  // Score cards
  const s = scores || {};
  setScoreCard('overall', s.overall ?? 0);
  setScoreCard('seo',     s.seo     ?? 0);

  // Pages count card
  $('sc-pages').textContent     = pagesScanned;
  $('sc-pages-sub').textContent = `${allPages.filter(p=>p.issueCount?.fail>0).length} pages with errors`;

  // Issue counts
  animateNum($('cnt-fail'), totalFail, 600);
  animateNum($('cnt-warn'), totalWarn, 600);
  animateNum($('cnt-pass'), totalPass, 600);

  // Render both views
  renderIssuesView();
  renderPagesView();

  // Tab switching
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const tab = this.dataset.tab;
      $('tab-issues').style.display = tab === 'issues' ? 'block' : 'none';
      $('tab-pages').style.display  = tab === 'pages'  ? 'block' : 'none';
    });
  });
}

function setScoreCard(key, value) {
  const num  = $(`sc-${key}`);
  const bar  = $(`bar-${key}`);
  const tier = $(`tier-${key}`);  // may be null for cards without a tier slot

  animateNum(num, value);

  const { label, colour } = scoreTier(value);
  num.style.color      = colour;
  bar.style.background = colour;
  setTimeout(() => { bar.style.width = value + '%'; }, 150);

  if (tier) {
    tier.textContent   = label;
    tier.style.color   = colour;
    tier.style.borderColor = colour;
    tier.style.display = 'inline-block';
  }
}

// ── Issues View ───────────────────────────────────────────────────────────────
// Groups findings by (category + check name) across all pages.
// Each group shows: badge, check name, affected page count, then a list of pages.
function renderIssuesView() {
  const container = $('tab-issues');
  container.innerHTML = '';

  // Collect all issues across all pages into groups
  // key = `${status}|${category}|${check}`
  const groups = new Map();

  for (const page of allPages) {
    const allChecks = [...(page.checks||[]), ...(page.convChecks||[])];
    for (const c of allChecks) {
      if (c.status === 'info') continue;  // skip info-only items
      const key = `${c.status}|${c.category||'Other'}|${c.check}`;
      if (!groups.has(key)) {
        groups.set(key, {
          status: c.status,
          category: c.category || 'Other',
          check: c.check,
          detail: c.detail || '',
          pages: [],
        });
      }
      groups.get(key).pages.push({
        url:  page.url,
        path: page.path,
        message: c.message,
        responseTimeMs: page.responseTimeMs,
      });
    }
  }

  if (groups.size === 0) {
    container.innerHTML = '<p style="padding:24px;color:var(--muted);text-align:center">No issues found across any pages.</p>';
    return;
  }

  // Sort: fail first, then warn, then pass; within each, by most affected pages
  const order = { fail: 0, warn: 1, pass: 2 };
  const sorted = [...groups.values()].sort((a, b) => {
    const od = (order[a.status]??9) - (order[b.status]??9);
    return od !== 0 ? od : b.pages.length - a.pages.length;
  });

  // Render each group
  for (const group of sorted) {
    const el = document.createElement('div');
    el.className = 'issue-group';

    const badgeCls = { fail:'ib-fail', warn:'ib-warn', pass:'ib-pass' }[group.status] || 'ib-info';
    const badgeLbl = { fail:'Error', warn:'Warning', pass:'Pass' }[group.status] || group.status;
    const pageWord = group.pages.length === 1 ? 'page' : 'pages';

    el.innerHTML = `
      <div class="ig-header" data-open="false">
        <span class="ig-badge ${badgeCls}">${badgeLbl}</span>
        <span class="ig-title">${esc(group.check)}</span>
        <span class="ig-count">${group.pages.length} ${pageWord}</span>
        <span class="ig-arrow">▼</span>
      </div>
      <div class="ig-pages">
        ${group.pages.map(p => `
          <div class="ig-page-row">
            <div>
              <div class="ig-page-path">
                <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.path || '/')}</a>
              </div>
              <div class="ig-page-detail">${esc(p.message)}</div>
            </div>
            <div class="ig-page-meta">${p.responseTimeMs ? p.responseTimeMs + 'ms' : ''}</div>
          </div>
        `).join('')}
        ${group.detail ? `<div class="ig-rec">💡 ${esc(group.detail)}</div>` : ''}
      </div>
    `;

    // Toggle open/close
    const header = el.querySelector('.ig-header');
    const pages  = el.querySelector('.ig-pages');
    header.addEventListener('click', () => {
      const isOpen = header.classList.contains('open');
      header.classList.toggle('open', !isOpen);
      pages.classList.toggle('open', !isOpen);
    });

    // Auto-open groups with errors
    if (group.status === 'fail') {
      header.classList.add('open');
      pages.classList.add('open');
    }

    container.appendChild(el);
  }
}

// ── Pages View ────────────────────────────────────────────────────────────────
// One row per crawled page. Click a row to expand all its individual issues.
function renderPagesView() {
  const container = $('tab-pages');
  container.innerHTML = '';

  const table = document.createElement('div');
  table.className = 'pages-table';

  // Header row
  table.innerHTML = `
    <div class="pt-head">
      <span>Page</span>
      <span>Status</span>
      <span>Errors</span>
      <span>Warn</span>
      <span>Load time</span>
    </div>
  `;

  // Sort pages: most errors first, then most warnings
  const sorted = [...allPages].sort((a, b) => {
    const fd = (b.issueCount?.fail||0) - (a.issueCount?.fail||0);
    return fd !== 0 ? fd : (b.issueCount?.warn||0) - (a.issueCount?.warn||0);
  });

  for (const page of sorted) {
    const row = document.createElement('div');
    row.className = 'page-row';
    if (page.httpError || page.fetchError) row.classList.add('page-row-error');

    const fail = page.issueCount?.fail ?? 0;
    const warn = page.issueCount?.warn ?? 0;

    const statusCls = page.fetchError ? 'st-err'
                    : page.status >= 400 ? 'st-err'
                    : page.status >= 300 ? 'st-wrn' : 'st-ok';
    const statusTxt = page.fetchError ? 'ERR' : (page.status || '?');

    const ms   = page.responseTimeMs || 0;
    const tmCls= ms > 3000 ? 'slow' : ms > 0 ? 'ok' : '';

    // Show full URL as subtitle only if path doesn't convey enough
    const subtitle = page.url !== startUrl ? '' : '(homepage)';

    row.innerHTML = `
      <div class="page-row-summary">
        <div class="pr-path">
          ${esc(page.path || '/')}
          ${subtitle ? `<small>${esc(subtitle)}</small>` : `<small>${esc(page.url)}</small>`}
        </div>
        <div class="pr-status ${statusCls}">${esc(statusTxt)}</div>
        <div class="pr-fail">${fail > 0 ? fail : '—'}</div>
        <div class="pr-warn">${warn > 0 ? warn : '—'}</div>
        <div class="pr-time ${tmCls}">${ms > 0 ? ms + 'ms' : '—'}</div>
      </div>
      <div class="page-row-issues"></div>
    `;

    // Build the expandable issues panel
    const issuesEl = row.querySelector('.page-row-issues');
    const allChecks = [...(page.checks||[]), ...(page.convChecks||[])];

    if (page.httpError) {
      issuesEl.innerHTML = `<div class="issue-line"><span class="il-badge ib-fail">Error</span><div class="il-body"><div class="il-check">${esc(page.httpError)}</div></div></div>`;
    } else if (page.fetchError) {
      issuesEl.innerHTML = `<div class="issue-line"><span class="il-badge ib-fail">Error</span><div class="il-body"><div class="il-check">Could not fetch page</div><div class="il-msg">${esc(page.fetchError)}</div></div></div>`;
    } else if (allChecks.length === 0) {
      issuesEl.innerHTML = `<div class="issue-line" style="color:var(--muted)">No checks available for this page.</div>`;
    } else {
      // Sort: fail → warn → info → pass
      const sorted2 = [...allChecks].sort((a,b) => {
        const o = {fail:0,warn:1,info:2,pass:3};
        return (o[a.status]??9) - (o[b.status]??9);
      });
      issuesEl.innerHTML = sorted2.map(c => {
        const bc = {fail:'ib-fail',warn:'ib-warn',pass:'ib-pass',info:'ib-info'}[c.status]||'ib-info';
        const bl = {fail:'Error',warn:'Warning',pass:'Pass',info:'Info'}[c.status]||c.status;
        return `
          <div class="issue-line">
            <span class="il-badge ${bc}">${bl}</span>
            <div class="il-body">
              <div class="il-check">${esc(c.check)}</div>
              <div class="il-msg">${esc(c.message)}</div>
              ${c.detail ? `<div class="il-rec">${esc(c.detail)}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    // Click summary row to expand issues
    row.querySelector('.page-row-summary').addEventListener('click', () => {
      issuesEl.classList.toggle('open');
    });

    table.appendChild(row);
  }

  container.appendChild(table);
}

// ── Scoring (mirrors lib/scoring.js — kept in sync manually) ─────────────────
// Weights by check name. Must match lib/scoring.js exactly.
const CHECK_WEIGHTS = {
  'HTTPS': 15, 'noindex Tag': 15, 'Page Title': 15,
  'H1 Tag': 12, 'Viewport / Mobile': 12,
  'Meta Description': 8, 'Value Proposition': 8, 'Clear CTA': 8,
  'Page Load Speed': 7, 'Word Count': 7, 'Contact Info': 6,
  'Canonical Tag': 5, 'Image Alt Text': 5, 'Target Audience Clear': 5,
  'Clear Next Step': 5, 'Form Present': 5,
  'robots.txt': 4, 'sitemap.xml': 4, 'Internal Links': 4,
  'Heading Structure': 3, 'Schema Markup': 3, 'Open Graph Tags': 3,
  'Render-Blocking Scripts': 3, 'Trust Signals': 3,
};
const DEFAULT_WEIGHT = 2;

function weightedScore(checks) {
  let earned = 0, possible = 0;
  for (const c of checks) {
    if (c.status === 'info') continue;
    const w = CHECK_WEIGHTS[c.check] ?? DEFAULT_WEIGHT;
    possible += w;
    if      (c.status === 'pass') earned += w;
    else if (c.status === 'warn') earned += w * 0.5;
  }
  return possible === 0 ? 100 : Math.round((earned / possible) * 100);
}

function scoreTier(score) {
  if (score >= 90) return { label: 'Excellent',         colour: '#16a34a' };
  if (score >= 75) return { label: 'Strong',            colour: '#22c55e' };
  if (score >= 50) return { label: 'Needs Improvement', colour: '#f59e0b' };
  if (score >= 25) return { label: 'Poor',              colour: '#f97316' };
  return                  { label: 'Critical',          colour: '#dc2626' };
}

function computeScores(pages) {
  const seoChecks  = pages.flatMap(p => p.checks     || []);
  const convChecks = pages.flatMap(p => p.convChecks || []);
  const seo  = weightedScore(seoChecks);
  const conv = convChecks.length ? weightedScore(convChecks) : seo;
  return { overall: Math.round(seo * 0.7 + conv * 0.3), seo, conversion: conv };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function resetScanBtn() {
  $('btn-label').textContent = 'Crawl Site';
  $('scan-btn').disabled = false;
  $('stop-btn').style.display = 'none';
}

function resetUI() {
  if (es) { es.close(); es = null; }
  allPages = [];
  showView('empty');
  resetScanBtn();
  $('url-input').focus();
}

// ═════════════════════════════════════════════════════════════════════════════
// TOP-LEVEL SECTION NAVIGATION
// ═════════════════════════════════════════════════════════════════════════════

(function initSectionNav() {
  const tabs = document.querySelectorAll('.app-tab[data-section]');

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      btn.classList.add('active');

      const target = btn.dataset.section;
      document.querySelectorAll('.app-section').forEach(s => {
        s.style.display = s.id === `section-${target}` ? '' : 'none';
      });

      if (target === 'search-performance' && !gscInitialized) initGSC();
      if (target === 'opportunities') refreshOpportunities();
      if (target === 'geo') refreshGeo();
      if (target === 'demo') refreshDemo();
    });
  });

  // Handle ?section= redirect from OAuth callback
  const params  = new URLSearchParams(location.search);
  const section = params.get('section');
  const gscErr  = params.get('gsc_error');
  if (section) {
    const tab = document.querySelector(`.app-tab[data-section="${section}"]`);
    if (tab) tab.click();
    history.replaceState({}, '', '/');
  }
  // Surface OAuth errors in the connect card once GSC tab is active
  if (gscErr) {
    window._pendingGSCError = decodeURIComponent(gscErr);
  }
})();

// ═════════════════════════════════════════════════════════════════════════════
// GOOGLE SEARCH CONSOLE
// ═════════════════════════════════════════════════════════════════════════════

let gscInitialized   = false;
let gscRows          = [];      // last fetched rows
let gscDims          = [];      // active dimensions during last fetch
let gscSortKey       = 'clicks';
let gscSortDir       = -1;      // -1 = descending
let gscCountryFilter = localStorage.getItem('gscCountryFilter') || 'all';
let gscCompareMode   = false;
let gscLastStartDate = '';
let gscLastEndDate   = '';

// ── Country code → display name ───────────────────────────────────────────────
const COUNTRY_NAMES = {
  usa:'United States', gbr:'United Kingdom', aus:'Australia', can:'Canada',
  ind:'India', deu:'Germany', fra:'France', sgp:'Singapore', mys:'Malaysia',
  phl:'Philippines', nzl:'New Zealand', irl:'Ireland', zaf:'South Africa',
  nld:'Netherlands', bra:'Brazil', esp:'Spain', ita:'Italy', jpn:'Japan',
  kor:'South Korea', idn:'Indonesia', pak:'Pakistan', bgd:'Bangladesh',
  mex:'Mexico', arg:'Argentina', sau:'Saudi Arabia', are:'United Arab Emirates',
  chn:'China', rus:'Russia', ukr:'Ukraine', pol:'Poland', swe:'Sweden',
  che:'Switzerland', bel:'Belgium', aut:'Austria', nor:'Norway', dnk:'Denmark',
  fin:'Finland', prt:'Portugal', grc:'Greece', cze:'Czech Republic',
  rou:'Romania', hun:'Hungary', tha:'Thailand', vnm:'Vietnam', lka:'Sri Lanka',
  egy:'Egypt', nga:'Nigeria', ken:'Kenya', gha:'Ghana', tza:'Tanzania',
};
const countryName = code => COUNTRY_NAMES[code?.toLowerCase()] || (code || '').toUpperCase();

// ── Country filter helpers ─────────────────────────────────────────────────────

function getFilteredRows() {
  if (gscCountryFilter === 'all') return gscRows;
  const idx = gscDims.indexOf('country');
  if (idx === -1) return gscRows;
  return gscRows.filter(r => (r.keys?.[idx] ?? '').toLowerCase() === gscCountryFilter.toLowerCase());
}

function populateCountryBar(rows) {
  const bar = document.getElementById('gsc-country-bar');
  const sel = document.getElementById('gsc-country-select');
  const btn = document.getElementById('gsc-compare-btn');
  const idx = gscDims.indexOf('country');

  if (idx === -1 || !bar) {
    if (bar) bar.style.display = 'none';
    return;
  }

  // Aggregate clicks per country so the dropdown is sorted by traffic
  const byClicks = {};
  rows.forEach(r => {
    const code = (r.keys?.[idx] ?? '').toLowerCase();
    if (code) byClicks[code] = (byClicks[code] || 0) + r.clicks;
  });
  const sortedCodes = Object.entries(byClicks).sort((a, b) => b[1] - a[1]);

  if (sel) {
    sel.innerHTML = '<option value="all">All Countries</option>' +
      sortedCodes.map(([code]) => `<option value="${esc(code)}">${esc(countryName(code))}</option>`).join('');

    // Validate persisted filter is still present in the current data
    if (gscCountryFilter !== 'all' && !sortedCodes.some(([code]) => code === gscCountryFilter)) {
      gscCountryFilter = 'all';
      localStorage.setItem('gscCountryFilter', 'all');
    }
    sel.value = gscCountryFilter;

    sel.onchange = () => {
      gscCountryFilter = sel.value;
      localStorage.setItem('gscCountryFilter', gscCountryFilter);
      renderGSCData(gscRows, gscLastStartDate, gscLastEndDate);
    };
  }

  if (btn) {
    btn.textContent = gscCompareMode ? 'Hide Comparison' : 'Compare Countries';
    btn.classList.toggle('active', gscCompareMode);
    btn.onclick = () => {
      gscCompareMode = !gscCompareMode;
      renderGSCData(gscRows, gscLastStartDate, gscLastEndDate);
    };
  }

  bar.style.display = '';
}

function renderCountrySummaryCards(rows) {
  const section = document.getElementById('gsc-country-cards-section');
  if (!section) return;
  const idx = gscDims.indexOf('country');
  if (idx === -1) return;

  const byCountry = {};
  rows.forEach(r => {
    const code = (r.keys?.[idx] ?? '').toLowerCase();
    if (!code) return;
    if (!byCountry[code]) byCountry[code] = { clicks: 0, impressions: 0, posSum: 0, count: 0 };
    byCountry[code].clicks      += r.clicks;
    byCountry[code].impressions += r.impressions;
    byCountry[code].posSum      += r.position;
    byCountry[code].count++;
  });

  const sorted = Object.entries(byCountry)
    .map(([code, d]) => ({ code, clicks: d.clicks, impressions: d.impressions, avgPos: d.posSum / d.count }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 8);

  if (sorted.length === 0) return;

  section.innerHTML = `
    <div class="country-cards-header">
      <span class="gsc-label">Top Countries</span>
      <span class="country-cards-hint">Click a card to filter</span>
    </div>
    <div class="country-cards-grid">
      ${sorted.map(c => `
        <button class="country-card${gscCountryFilter === c.code ? ' active' : ''}" data-country="${esc(c.code)}">
          <div class="country-card-name">${esc(countryName(c.code))}</div>
          <div class="country-card-metrics">
            <span class="cc-metric"><span class="cc-val">${c.clicks.toLocaleString()}</span><span class="cc-key">Clicks</span></span>
            <span class="cc-metric"><span class="cc-val">${c.impressions.toLocaleString()}</span><span class="cc-key">Impr.</span></span>
            <span class="cc-metric"><span class="cc-val">${c.avgPos.toFixed(1)}</span><span class="cc-key">Pos.</span></span>
          </div>
        </button>`).join('')}
    </div>
  `;

  section.querySelectorAll('.country-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.country;
      gscCountryFilter = gscCountryFilter === code ? 'all' : code;
      localStorage.setItem('gscCountryFilter', gscCountryFilter);
      renderGSCData(gscRows, gscLastStartDate, gscLastEndDate);
    });
  });
}

function renderCountryComparison(rows) {
  const section = document.getElementById('gsc-compare-section');
  if (!section) return;
  const idx = gscDims.indexOf('country');
  if (idx === -1) return;

  const byCountry = {};
  rows.forEach(r => {
    const code = (r.keys?.[idx] ?? '').toLowerCase();
    if (!code) return;
    if (!byCountry[code]) byCountry[code] = { clicks: 0, impressions: 0, posSum: 0, count: 0 };
    byCountry[code].clicks      += r.clicks;
    byCountry[code].impressions += r.impressions;
    byCountry[code].posSum      += r.position;
    byCountry[code].count++;
  });

  const sorted = Object.entries(byCountry)
    .map(([code, d]) => ({
      code,
      name:        countryName(code),
      clicks:      d.clicks,
      impressions: d.impressions,
      ctr:         d.impressions > 0 ? (d.clicks / d.impressions) * 100 : 0,
      avgPos:      d.posSum / d.count,
    }))
    .sort((a, b) => b.clicks - a.clicks);

  if (sorted.length === 0) return;

  const totalClicks = sorted.reduce((s, c) => s + c.clicks, 0);
  const maxClicks   = sorted[0].clicks;

  section.innerHTML = `
    <div class="compare-header">
      <span class="gsc-label">Country Comparison — ${sorted.length} countries</span>
    </div>
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th class="col-r">#</th>
            <th>Country</th>
            <th class="col-r">Clicks</th>
            <th>Traffic Share</th>
            <th class="col-r">Impressions</th>
            <th class="col-r">CTR</th>
            <th class="col-r">Avg Position</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map((c, i) => {
            const barPct  = maxClicks > 0 ? (c.clicks / maxClicks) * 100 : 0;
            const pctTot  = totalClicks > 0 ? (c.clicks / totalClicks) * 100 : 0;
            const posCls  = c.avgPos <= 3 ? 'pos-top' : c.avgPos <= 10 ? 'pos-p1' : c.avgPos <= 20 ? 'pos-p2' : 'pos-low';
            return `<tr>
                <td class="compare-rank">${i + 1}</td>
                <td class="compare-country">${esc(c.name)}</td>
                <td class="compare-clicks col-r">${c.clicks.toLocaleString()}</td>
                <td class="compare-share-cell">
                  <div class="share-bar-wrap">
                    <div class="share-bar-track"><div class="share-bar" style="width:${barPct.toFixed(1)}%"></div></div>
                    <span class="share-pct">${pctTot.toFixed(1)}%</span>
                  </div>
                </td>
                <td class="col-r">${c.impressions.toLocaleString()}</td>
                <td class="col-r">${c.ctr.toFixed(1)}%</td>
                <td class="col-r ${posCls}">${c.avgPos.toFixed(1)}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── State management ──────────────────────────────────────────────────────────
async function initGSC() {
  showGSCState('loading');
  try {
    const res  = await fetch('/api/gsc/status');
    const data = await res.json();

    if (!data.hasCredentials) {
      showGSCState('setup');
    } else if (!data.connected) {
      showGSCState('connect');
      // Show any OAuth error that came back in the redirect
      if (window._pendingGSCError) {
        const el = document.getElementById('gsc-connect-error');
        if (el) { el.textContent = window._pendingGSCError; el.style.display = ''; }
        delete window._pendingGSCError;
      }
    } else {
      showGSCState('data');
      await loadGSCSites();
    }
  } catch {
    showGSCState('setup');
  }
  gscInitialized = true;
}

function showGSCState(state) {
  ['loading', 'setup', 'connect', 'data'].forEach(s => {
    const el = document.getElementById(`gsc-${s}`);
    if (el) el.style.display = s === state ? '' : 'none';
  });
}

// ── Property list ─────────────────────────────────────────────────────────────
async function loadGSCSites() {
  const sel = document.getElementById('gsc-property');
  sel.innerHTML = '<option>Loading…</option>';
  try {
    const res   = await fetch('/api/gsc/sites');
    const { sites, error } = await res.json();
    if (error) throw new Error(error);
    if (!sites || sites.length === 0) {
      sel.innerHTML = '<option value="">No verified properties found</option>';
      return;
    }
    sel.innerHTML = sites.map(s =>
      `<option value="${esc(s.siteUrl)}">${esc(s.siteUrl)}</option>`
    ).join('');
  } catch (err) {
    sel.innerHTML = '<option value="">Error loading properties</option>';
    showGSCError(err.message);
  }
}

// ── Toolbar wiring ────────────────────────────────────────────────────────────
document.getElementById('gsc-load-btn')?.addEventListener('click', fetchGSCData);

document.getElementById('gsc-disconnect-btn')?.addEventListener('click', async () => {
  await fetch('/api/gsc/logout', { method: 'POST' });
  gscInitialized   = false;
  gscRows          = [];
  gscLastStartDate = '';
  gscLastEndDate   = '';
  gscCompareMode   = false;
  const bar = document.getElementById('gsc-country-bar');
  if (bar) bar.style.display = 'none';
  showGSCState('loading');
  setTimeout(initGSC, 0);
});

document.querySelectorAll('.dbt').forEach(btn => {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.dbt').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
  });
});

// ── Fetch data ────────────────────────────────────────────────────────────────
async function fetchGSCData() {
  const siteUrl = document.getElementById('gsc-property')?.value;
  if (!siteUrl) return;

  gscDims = [...document.querySelectorAll('input[name="gsc-dim"]:checked')].map(c => c.value);
  if (gscDims.length === 0) { alert('Select at least one dimension.'); return; }

  const days = parseInt(document.querySelector('.dbt.active')?.dataset.days || '28');

  // GSC data has a ~2-3 day processing lag — shift the window back
  const end   = new Date(); end.setDate(end.getDate() - 3);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const fmt   = d => d.toISOString().slice(0, 10);

  const resultsEl = document.getElementById('gsc-results');
  resultsEl.innerHTML = '<div class="gsc-center" style="padding:40px"><div class="spinner"></div><span style="margin-left:10px;color:var(--muted)">Fetching data…</span></div>';

  try {
    const res = await fetch('/api/gsc/query', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ siteUrl, startDate: fmt(start), endDate: fmt(end), dimensions: gscDims, rowLimit: 1000 }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);

    gscLastStartDate   = fmt(start);
    gscLastEndDate     = fmt(end);
    gscRows            = body.rows || [];
    gscCurrentProperty = siteUrl;
    gscCurrentDays     = days;
    saveGscSnapshot(siteUrl, days, gscRows, gscDims);
    gscPrevSnapshot    = getPrevSnapshot(siteUrl, days);
    gscSortKey         = 'clicks';
    gscSortDir         = -1;
    renderGSCData(gscRows, gscLastStartDate, gscLastEndDate);
  } catch (err) {
    resultsEl.innerHTML = `<div class="gsc-error-banner" style="margin:24px">${esc(err.message)}</div>`;
  }
}

// ── Render results ────────────────────────────────────────────────────────────
function renderGSCData(rows, startDate, endDate) {
  const container = document.getElementById('gsc-results');

  if (!rows || rows.length === 0) {
    const bar = document.getElementById('gsc-country-bar');
    if (bar) bar.style.display = 'none';
    container.innerHTML = '<div class="gsc-empty">No data found for this property and date range.</div>';
    return;
  }

  populateCountryBar(rows);

  const displayRows = getFilteredRows();
  const hasCountry  = gscDims.indexOf('country') !== -1;

  const totClicks = displayRows.reduce((s, r) => s + r.clicks,      0);
  const totImp    = displayRows.reduce((s, r) => s + r.impressions, 0);
  const avgCTR    = totImp > 0 ? (totClicks / totImp) * 100 : 0;
  const avgPos    = displayRows.length > 0 ? displayRows.reduce((s, r) => s + r.position, 0) / displayRows.length : 0;

  const filterLabel = gscCountryFilter !== 'all'
    ? ` &nbsp;·&nbsp; <strong style="color:var(--blue)">${esc(countryName(gscCountryFilter))}</strong>`
    : '';

  container.innerHTML = `
    <div class="gsc-summary">
      <div class="gm-card"><div class="gm-label">Total Clicks</div><div class="gm-value">${totClicks.toLocaleString()}</div></div>
      <div class="gm-card"><div class="gm-label">Total Impressions</div><div class="gm-value">${totImp.toLocaleString()}</div></div>
      <div class="gm-card"><div class="gm-label">Avg CTR</div><div class="gm-value">${avgCTR.toFixed(1)}%</div></div>
      <div class="gm-card"><div class="gm-label">Avg Position</div><div class="gm-value">${avgPos > 0 ? avgPos.toFixed(1) : '—'}</div></div>
    </div>
    <div class="gsc-meta">${displayRows.length.toLocaleString()} rows &nbsp;·&nbsp; ${startDate} → ${endDate}${filterLabel}</div>
    ${hasCountry && gscCompareMode        ? '<div id="gsc-compare-section"></div>'      : ''}
    ${hasCountry && gscCountryFilter === 'all' ? '<div id="gsc-country-cards-section"></div>' : ''}
    <div class="gsc-table-wrap" id="gsc-table-wrap"></div>
  `;

  if (hasCountry && gscCompareMode)             renderCountryComparison(rows);
  if (hasCountry && gscCountryFilter === 'all') renderCountrySummaryCards(rows);
  renderGSCTable();
}

function renderGSCTable() {
  const wrap = document.getElementById('gsc-table-wrap');
  if (!wrap) return;

  const sorted = [...getFilteredRows()].sort((a, b) => {
    const av = gscSortKey === 'ctr' ? a.ctr : a[gscSortKey];
    const bv = gscSortKey === 'ctr' ? b.ctr : b[gscSortKey];
    return typeof av === 'number'
      ? (av - bv) * gscSortDir
      : String(av ?? '').localeCompare(String(bv ?? '')) * gscSortDir;
  });

  const dimCols = gscDims.map(d => ({
    key: d,
    label: { query: 'Query', page: 'Landing Page', country: 'Country', device: 'Device' }[d] || d,
  }));
  const metricCols = [
    { key: 'clicks',      label: 'Clicks',       fmt: v => v.toLocaleString() },
    { key: 'impressions', label: 'Impressions',   fmt: v => v.toLocaleString() },
    { key: 'ctr',         label: 'CTR',           fmt: v => (v * 100).toFixed(1) + '%' },
    { key: 'position',    label: 'Avg Position',  fmt: v => v.toFixed(1) },
  ];
  const cols = [...dimCols, ...metricCols];

  const sortIcon = key => {
    if (gscSortKey !== key) return '<span class="sort-icon">⇅</span>';
    return gscSortDir === -1 ? '<span class="sort-icon on">↓</span>' : '<span class="sort-icon on">↑</span>';
  };

  const thead = `<tr>${cols.map(c => `<th data-sort="${c.key}">${c.label} ${sortIcon(c.key)}</th>`).join('')}</tr>`;

  const DISPLAY_LIMIT = 500;
  const tbody = sorted.slice(0, DISPLAY_LIMIT).map(row => {
    const cells = cols.map(col => {
      const dimIdx = gscDims.indexOf(col.key);
      if (dimIdx !== -1) {
        let val = row.keys?.[dimIdx] ?? '';
        if (col.key === 'country') val = countryName(val);
        if (col.key === 'page') {
          return `<td class="gsc-page-cell"><a href="${esc(val)}" target="_blank" rel="noopener" title="${esc(val)}">${esc(val)}</a></td>`;
        }
        if (col.key === 'query') return `<td class="gsc-query-cell">${esc(val)}</td>`;
        return `<td>${esc(val)}</td>`;
      }
      const v = col.key === 'ctr' ? (row.ctr ?? 0) : (row[col.key] ?? 0);
      const metric = metricCols.find(m => m.key === col.key);
      const text   = metric ? metric.fmt(v) : String(v);
      let cls = '';
      if (col.key === 'position') cls = v <= 3 ? 'pos-top' : v <= 10 ? 'pos-p1' : v <= 20 ? 'pos-p2' : 'pos-low';
      return `<td class="${cls}">${esc(text)}</td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  const trunc = sorted.length > DISPLAY_LIMIT
    ? `<p class="gsc-trunc">Showing ${DISPLAY_LIMIT} of ${sorted.length.toLocaleString()} rows. Use a shorter date range or add a dimension filter to narrow results.</p>`
    : '';

  wrap.innerHTML = `<table class="gsc-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>${trunc}`;

  // Sort on header click
  wrap.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      gscSortDir = gscSortKey === k ? gscSortDir * -1 : -1;
      gscSortKey = k;
      renderGSCTable();
    });
  });
}

function showGSCError(msg) {
  const container = document.getElementById('gsc-results');
  if (container) container.innerHTML = `<div class="gsc-error-banner" style="margin:24px">${esc(msg)}</div>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// OPPORTUNITIES
// ═════════════════════════════════════════════════════════════════════════════

const OPP_CONFIG_KEY  = 'seoOppConfig_v1';
const OPP_TRACKER_KEY = 'seoOppTracker_v1';
const PROJECTS_KEY    = 'seoProjects_v1';
const GSC_HISTORY_KEY = 'seoGscHistory_v1';
const LEADS_KEY       = 'seoLeads_v1';

// ── Module state ──────────────────────────────────────────────────────────────
let gscOppResult       = null;   // full analysis result cached between filter changes
let gscOppAllOpps      = [];     // deduplicated flat list for summary counts
let gscCurrentProperty = '';     // property loaded in last fetch (for history)
let gscCurrentDays     = 28;     // date range in last fetch
let gscPrevSnapshot    = null;   // previous history snapshot for delta display
let oppFilterStatus    = 'all';
let oppFilterAction    = 'all';
let oppFilterClass     = 'all';
let oppFilterCountry   = 'all';
let oppHideLowImpact   = false;

// ── Keyword config ────────────────────────────────────────────────────────────
function loadOppConfig() {
  try {
    const raw = localStorage.getItem(OPP_CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    return { brand: cfg.brand || [], service: cfg.service || [], exclude: cfg.exclude || [] };
  } catch { return { brand: [], service: [], exclude: [] }; }
}

function saveOppConfig(cfg) {
  localStorage.setItem(OPP_CONFIG_KEY, JSON.stringify(cfg));
}

// ── Opportunity tracker (localStorage) ───────────────────────────────────────

function oppId(o) {
  // Deterministic short hash from keyword + page + type
  const str = `${o.keyword}|${o.page || ''}|${o.type}`;
  let h = 5381;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); h = h & h; }
  return 'op' + (h >>> 0).toString(36);
}

function fmtRelTime(iso) {
  try {
    const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
    const h = Math.floor((Date.now() - new Date(iso)) / 3600000);
    const m = Math.floor((Date.now() - new Date(iso)) / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    if (d < 7)  return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch { return ''; }
}

function loadOppTracker() {
  try { return JSON.parse(localStorage.getItem(OPP_TRACKER_KEY)) || {}; }
  catch { return {}; }
}

function saveOppTracker(t) {
  localStorage.setItem(OPP_TRACKER_KEY, JSON.stringify(t));
}

function getOppRecord(id) {
  return loadOppTracker()[id] || { status: 'new', actionType: '', owner: '', notes: '', updatedAt: null };
}

function setOppRecord(id, patch) {
  const t = loadOppTracker();
  t[id] = { ...getOppRecord(id), ...patch, updatedAt: new Date().toISOString() };
  saveOppTracker(t);
}

function pathFromUrl(url) {
  try { return new URL(url).pathname || url; } catch { return url || ''; }
}

// ── Keyword classification ────────────────────────────────────────────────────

const INFO_RE = /^(how |what |why |when |where |who |which |is |are |can |does |do |should |will |vs\b|versus |difference between |compare |list of|guide to|guide |tutorial|tips for|review of|examples of|definition of|meaning of|types of|ways to|steps to)/i;

function classifyKeyword(kw, config) {
  const lower = kw.toLowerCase().trim();
  // Exclude list takes priority over all other rules
  if (config.exclude && config.exclude.some(ex => {
    const el = ex.toLowerCase().trim();
    return el.length >= 2 && lower.includes(el);
  })) return 'other';
  if (config.brand.some(b => { const bl = b.toLowerCase().trim(); return bl.length >= 2 && lower.includes(bl); })) return 'brand';
  // Service matching uses word-boundary check to avoid over-broad substring matches
  if (config.service.some(s => {
    const sl = s.toLowerCase().trim();
    if (sl.length < 2) return false;
    if (lower === sl) return true;
    const escaped = sl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(lower);
  })) return 'service';
  if (INFO_RE.test(lower)) return 'informational';
  return 'other';
}

// ── Query intent detection ────────────────────────────────────────────────────

const COMMERCIAL_RE   = /\b(price|pricing|cost|costs|fee|fees|rate|rates|hire|buy|get quote|book|order|affordable|cheap|cheapest|best|top|leading|trusted|agency|agencies|consultant|consulting|firm|provider|solution|compare|comparison|alternatives?|near me|for (business|companies|enterprise|startup)|review|reviews)\b/i;
const NAVIGATIONAL_RE = /\b(login|log in|sign in|sign up|portal|account|dashboard|contact us|about us|careers|jobs at|homepage)\b/i;

function detectIntent(kw) {
  const lower = kw.toLowerCase().trim();
  if (NAVIGATIONAL_RE.test(lower)) return 'navigational';
  if (INFO_RE.test(lower))         return 'informational';
  if (COMMERCIAL_RE.test(lower))   return 'commercial';
  return 'mixed';
}

// Low effort = already ranking, needs optimisation. High effort = no ranking, needs new/rebuilt content.
function calcEffort(o) {
  if (o.type === 'not-ranking' || o.type === 'ranking-poor') return 'high';
  if (o.position !== null && o.position > 20)                return 'high';
  return 'low';
}

// ── CTR benchmarks by position ────────────────────────────────────────────────

const CTR_CURVE = [0, 0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.035, 0.03, 0.025];
const expCTR    = pos => CTR_CURVE[Math.max(1, Math.min(Math.round(pos), 10))];

// ── Core analysis ─────────────────────────────────────────────────────────────

function analyzeOpportunities(rows, dims, config) {
  const qIdx  = dims.indexOf('query');
  const pgIdx = dims.indexOf('page');
  const ctIdx = dims.indexOf('country');
  if (qIdx === -1) return null;

  const priority  = [];
  const quickWins = [];
  const lowCtr    = [];
  const allKwMap  = new Map(); // keyword → {pos, row, pg, ct}

  rows.forEach(row => {
    const kw  = (row.keys?.[qIdx] ?? '').toLowerCase().trim();
    const pg  = pgIdx !== -1 ? (row.keys?.[pgIdx] ?? null) : null;
    const ct  = ctIdx !== -1 ? (row.keys?.[ctIdx] ?? null) : null;
    const pos = row.position;
    const imp = row.impressions;
    const ctr = row.ctr ?? (imp > 0 ? row.clicks / imp : 0);
    const cls = classifyKeyword(kw, config);
    const eCTR = expCTR(pos);

    if (!allKwMap.has(kw) || pos < allKwMap.get(kw).pos) {
      allKwMap.set(kw, { pos, row, pg, ct });
    }

    const base = { keyword: kw, page: pg, country: ct, clicks: row.clicks, impressions: imp, ctr, position: pos, classification: cls, intent: detectIntent(kw) };

    // Quick wins — all keywords, position 8–20, enough impressions to be meaningful
    if (pos >= 8 && pos <= 20 && imp >= 20) {
      const targetPos  = Math.max(1, pos - 5);
      const potClicks  = Math.max(0, Math.round(imp * (expCTR(targetPos) - ctr)));
      const isPageTwo  = pos > 10;
      quickWins.push({
        ...base, type: 'quick-win', potentialClicks: potClicks,
        whyItMatters: isPageTwo
          ? `Ranking #${pos.toFixed(1)} (page 2) with ${imp.toLocaleString()} monthly impressions. Page 2 gets less than 1% of clicks.`
          : `Ranking #${pos.toFixed(1)} near the bottom of page 1. A small push into the top 5 would multiply clicks significantly.`,
        recommendedAction: isPageTwo
          ? `Deepen the content, improve internal linking, and fix any technical issues on ${pg ? pathFromUrl(pg) : 'the ranking page'} to break onto page 1.`
          : `Strengthen E-E-A-T signals and content comprehensiveness on ${pg ? pathFromUrl(pg) : 'the ranking page'} to climb into the top 5.`,
      });
    }

    // Priority opportunities — service/brand quick wins (lower impression threshold)
    if ((cls === 'service' || cls === 'brand') && pos >= 8 && pos <= 20 && imp >= 5) {
      const targetPos = Math.max(1, pos - 5);
      const potClicks = Math.max(0, Math.round(imp * (expCTR(targetPos) - ctr)));
      priority.push({
        ...base, type: 'quick-win', potentialClicks: potClicks,
        whyItMatters: cls === 'service'
          ? `Service keyword at #${pos.toFixed(1)} — directly tied to business discovery. ${imp.toLocaleString()} monthly impressions are being missed at this position.`
          : `Brand keyword at #${pos.toFixed(1)} — a competitor could appear above you for searches of your own brand name.`,
        recommendedAction: `Prioritise ${pg ? pathFromUrl(pg) : 'the ranking page'} for "${kw}" — improving this directly impacts service visibility and lead generation.`,
      });
    }

    // Priority opportunities — service/brand keywords ranking 1–7 but with underperforming CTR
    if ((cls === 'service' || cls === 'brand') && pos >= 1 && pos < 8 && imp >= 100 && ctr < eCTR * 0.55) {
      const potClicks = Math.max(0, Math.round(imp * (eCTR * 0.8 - ctr)));
      priority.push({
        ...base, type: 'high-impressions', potentialClicks: potClicks,
        whyItMatters: `High-visibility service keyword at #${pos.toFixed(1)} with ${imp.toLocaleString()} impressions, but only ${(ctr * 100).toFixed(1)}% CTR (expected ~${(eCTR * 100).toFixed(0)}%). The listing isn't compelling enough.`,
        recommendedAction: `Rewrite the meta title and description for "${kw}" to be more click-worthy. Test numbers, specific outcomes, or a direct call to action.`,
      });
    }

    // Low CTR — service/brand only, position 1–10, CTR well below benchmark
    if ((cls === 'service' || cls === 'brand') && pos >= 1 && pos <= 10 && imp >= 50 && ctr < eCTR * 0.6) {
      const potClicks = Math.max(0, Math.round(imp * (eCTR * 0.8 - ctr)));
      lowCtr.push({
        ...base, type: 'low-ctr', potentialClicks: potClicks,
        whyItMatters: `CTR is ${(ctr * 100).toFixed(1)}% vs the expected ~${(eCTR * 100).toFixed(0)}% at position #${pos.toFixed(1)}. You're visible but not compelling enough to click.`,
        recommendedAction: `A/B test meta titles for "${kw}" — try specific numbers, questions, or a clearer value proposition that matches the searcher's intent.`,
      });
    }
  });

  // Strategic gaps — service keywords from config not ranking or outside top 20
  const gaps       = [];
  const seenGapKw  = new Set();

  config.service.forEach(svcKw => {
    const sl = svcKw.toLowerCase().trim();
    if (!sl || sl.length < 2 || seenGapKw.has(sl)) return;
    seenGapKw.add(sl);

    let bestPos  = Infinity;
    let bestData = null;
    allKwMap.forEach((data, kw) => {
      if ((kw.includes(sl) || sl.includes(kw)) && data.pos < bestPos) {
        bestPos = data.pos; bestData = data;
      }
    });

    if (!bestData) {
      gaps.push({
        keyword: svcKw, page: null, country: null,
        clicks: 0, impressions: 0, ctr: 0, position: null,
        classification: 'service', type: 'not-ranking', potentialClicks: null,
        whyItMatters: `"${svcKw}" has zero impressions in Search Console — you have no visibility for this service term. Competitors are capturing this traffic entirely.`,
        recommendedAction: `Create or strengthen a dedicated page targeting "${svcKw}". Ensure it's properly indexed, internally linked, and has sufficient content depth to compete.`,
      });
    } else if (bestPos > 20) {
      const row = bestData.row;
      gaps.push({
        keyword: (row.keys?.[qIdx] ?? svcKw).toLowerCase(),
        page: bestData.pg, country: bestData.ct,
        clicks: row.clicks, impressions: row.impressions, ctr: row.ctr ?? 0, position: bestPos,
        classification: 'service', type: 'ranking-poor', potentialClicks: null,
        whyItMatters: `Service keyword ranking at #${bestPos.toFixed(0)} — well outside the visible results. This generates almost no organic traffic.`,
        recommendedAction: `Build topical authority for "${svcKw}": deepen the content, acquire relevant backlinks, and strengthen internal links from high-authority pages.`,
      });
    }
  });

  // Deduplicate priority by keyword + page + type
  const seenP  = new Set();
  const deduped = priority.filter(o => {
    const k = `${o.keyword}|${o.page}|${o.type}`;
    if (seenP.has(k)) return false;
    seenP.add(k); return true;
  });

  const byPotential = (a, b) => (b.potentialClicks ?? 0) - (a.potentialClicks ?? 0);

  return {
    priority:  deduped.sort(byPotential).slice(0, 25),
    quickWins: quickWins.sort(byPotential).slice(0, 30),
    gaps:      gaps.slice(0, 30),
    lowCtr:    lowCtr.sort(byPotential).slice(0, 20),
  };
}

// ── Project management ────────────────────────────────────────────────────────

function loadProjects() {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY)) || []; }
  catch { return []; }
}

function saveProject(name, domain, config) {
  if (!name.trim()) return;
  const projects = loadProjects();
  const idx      = projects.findIndex(p => p.name === name.trim());
  const proj     = { name: name.trim(), domain: domain.trim(), config, savedAt: new Date().toISOString() };
  if (idx >= 0) projects[idx] = proj; else projects.unshift(proj);
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects.slice(0, 20)));
}

function deleteProject(name) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(loadProjects().filter(p => p.name !== name)));
}

// ── Historical tracking ───────────────────────────────────────────────────────

function loadGscHistory() {
  try { return JSON.parse(localStorage.getItem(GSC_HISTORY_KEY)) || {}; }
  catch { return {}; }
}

function buildKwSnapshot(rows, dims) {
  const qIdx = dims.indexOf('query');
  if (qIdx === -1) return {};
  const map = {};
  rows.forEach(r => {
    const kw = (r.keys?.[qIdx] || '').toLowerCase().trim();
    if (!kw) return;
    if (!map[kw] || r.position < map[kw].p) {
      // compact keys: c=clicks, i=impressions, r=ctr, p=position
      map[kw] = { c: r.clicks, i: r.impressions, r: r.ctr ?? 0, p: r.position };
    }
  });
  return map;
}

function saveGscSnapshot(property, days, rows, dims) {
  const key  = `${property}|${days}`;
  const hist = loadGscHistory();
  if (!hist[key]) hist[key] = [];
  const today = new Date().toISOString().slice(0, 10);
  const kwMap = buildKwSnapshot(rows, dims);
  if (hist[key].length > 0 && hist[key][0].ts.slice(0, 10) === today) {
    hist[key][0].kwMap = kwMap; // update same-day entry in-place
  } else {
    hist[key].unshift({ ts: new Date().toISOString(), kwMap });
    hist[key] = hist[key].slice(0, 5); // keep last 5 loads
  }
  try { localStorage.setItem(GSC_HISTORY_KEY, JSON.stringify(hist)); } catch { /* quota */ }
}

function getPrevSnapshot(property, days) {
  const snaps = loadGscHistory()[`${property}|${days}`] || [];
  return snaps.length >= 2 ? snaps[1] : null;
}

// ── Keyword → Page Mapping ────────────────────────────────────────────────────

const CONTENT_URL_RE = /\/(blog|news|articles?|insights?|posts?|resources?|guides?|tags?|categor|author)/i;

function detectPageMapping(rows, dims, config) {
  const qIdx  = dims.indexOf('query');
  const pgIdx = dims.indexOf('page');
  if (qIdx === -1 || pgIdx === -1) return { cannibalization: [], wrongPage: [] };

  // Build keyword → pages map for service/brand keywords only
  const kwPageMap = new Map();
  rows.forEach(row => {
    const kw = (row.keys?.[qIdx] || '').toLowerCase().trim();
    const pg = row.keys?.[pgIdx] || null;
    if (!kw || !pg) return;
    const cls = classifyKeyword(kw, config);
    if (cls !== 'service' && cls !== 'brand') return;
    if (!kwPageMap.has(kw)) kwPageMap.set(kw, new Map());
    const pm = kwPageMap.get(kw);
    if (!pm.has(pg) || row.position < pm.get(pg).position) {
      pm.set(pg, { position: row.position, clicks: row.clicks, impressions: row.impressions });
    }
  });

  const cannibalization = [];
  const wrongPage       = [];

  kwPageMap.forEach((pm, kw) => {
    const pages = [...pm.entries()].sort((a, b) => a[1].position - b[1].position);
    if (pages.length >= 2) {
      cannibalization.push({
        keyword: kw,
        pages: pages.slice(0, 4).map(([pg, d]) => ({ page: pg, position: d.position, clicks: d.clicks, impressions: d.impressions })),
      });
    }
    const [topPg, topData] = pages[0];
    if (CONTENT_URL_RE.test(topPg)) {
      wrongPage.push({
        keyword: kw, rankingPage: topPg, position: topData.position, impressions: topData.impressions,
        action: `A content page is ranking instead of a service page. Create a dedicated service page for "${kw}" and redirect or consolidate this content.`,
      });
    }
  });

  return {
    cannibalization: cannibalization.slice(0, 20),
    wrongPage: wrongPage.filter(w => !cannibalization.some(c => c.keyword === w.keyword)).slice(0, 20),
  };
}

function renderPageMapping(rows, dims, config) {
  const el = document.getElementById('opp-section-mapping');
  if (!el) return;
  if (!rows || rows.length === 0 || dims.indexOf('query') === -1 || dims.indexOf('page') === -1) {
    el.innerHTML = '';
    return;
  }

  const { cannibalization, wrongPage } = detectPageMapping(rows, dims, config);
  if (cannibalization.length === 0 && wrongPage.length === 0) { el.innerHTML = ''; return; }

  const canniHtml = cannibalization.map(({ keyword, pages }) => `
    <div class="map-row">
      <div class="map-kw">${esc(keyword)}</div>
      <div class="map-pages">
        ${pages.map((p, i) => `
          <div class="map-page ${i === 0 ? 'map-page-winner' : 'map-page-alt'}">
            <span class="map-page-rank">#${p.position.toFixed(1)}</span>
            <a href="${esc(p.page)}" target="_blank" rel="noopener" title="${esc(p.page)}">${esc(pathFromUrl(p.page))}</a>
            <span class="map-page-meta">${p.impressions.toLocaleString()} impr.</span>
          </div>`).join('')}
      </div>
    </div>`).join('');

  const wrongHtml = wrongPage.map(w => `
    <div class="map-row">
      <div class="map-kw">${esc(w.keyword)} <span class="map-tag-wrong">content page</span></div>
      <div class="map-pages">
        <div class="map-page map-page-wrong">
          <span class="map-page-rank">#${w.position.toFixed(1)}</span>
          <a href="${esc(w.rankingPage)}" target="_blank" rel="noopener">${esc(pathFromUrl(w.rankingPage))}</a>
          <span class="map-page-meta">${w.impressions.toLocaleString()} impr.</span>
        </div>
        <div class="map-action-text">${esc(w.action)}</div>
      </div>
    </div>`).join('');

  const sections = [
    cannibalization.length ? `<div class="map-sub-title">Keyword Cannibalization (${cannibalization.length})</div><div class="map-list">${canniHtml}</div>` : '',
    wrongPage.length ? `<div class="map-sub-title" style="margin-top:16px">Wrong Page Ranking (${wrongPage.length})</div><div class="map-list">${wrongHtml}</div>` : '',
  ].filter(Boolean).join('');

  el.innerHTML = `
    <div class="opp-section">
      <div class="opp-section-hd">
        <div class="opp-section-hd-row">
          <span class="opp-section-icon" style="background:#f0fdf418;color:#16a34a">🔗</span>
          <h2 class="opp-section-title">Keyword → Page Mapping</h2>
          <span class="opp-count-badge" style="background:#f0fdf4;color:#16a34a">${cannibalization.length + wrongPage.length}</span>
        </div>
        <p class="opp-section-desc">Cannibalization (multiple pages competing for the same keyword) and wrong-page ranking issues.</p>
      </div>
      ${sections}
    </div>`;
}

// ── Export HTML Report ────────────────────────────────────────────────────────

function exportOppReport() {
  if (!gscOppResult || gscOppAllOpps.length === 0) {
    alert('No opportunity data to export. Load Search Console data first.');
    return;
  }

  const config   = loadOppConfig();
  const tracker  = loadOppTracker();
  const now      = new Date();
  const dateStr  = now.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const property = gscCurrentProperty || 'Search Console';
  const range    = gscLastStartDate && gscLastEndDate ? `${gscLastStartDate} → ${gscLastEndDate}` : 'Unknown range';

  // Summary counts
  const impCounts    = { high: 0, medium: 0, low: 0 };
  const statusCounts = { new: 0, reviewed: 0, 'in-progress': 0, done: 0, ignored: 0 };
  gscOppAllOpps.forEach(o => {
    impCounts[calcImpact(o)]++;
    const st = (tracker[oppId(o)] || {}).status || 'new';
    if (statusCounts[st] !== undefined) statusCounts[st]++; else statusCounts.new++;
  });

  // Top 5 (same logic as renderTopActions)
  const seen5 = new Set(); const deduped5 = [];
  [...gscOppResult.priority, ...gscOppResult.gaps, ...gscOppResult.quickWins, ...gscOppResult.lowCtr].forEach(o => {
    const id = oppId(o); if (!seen5.has(id)) { seen5.add(id); deduped5.push({ ...o, impact: calcImpact(o) }); }
  });
  const impOrd = { high: 0, medium: 1, low: 2 };
  const top5 = deduped5
    .filter(o => o.classification === 'service' || o.classification === 'brand' || o.impact === 'high')
    .sort((a, b) => (impOrd[a.impact] - impOrd[b.impact]) || ((b.potentialClicks ?? 0) - (a.potentialClicks ?? 0)))
    .slice(0, 5);

  // Priority table rows
  const priorityRows = gscOppResult.priority.slice(0, 25).map(o => {
    const imp = calcImpact(o);
    const rec = tracker[oppId(o)] || {};
    return `<tr>
      <td>${esc(o.keyword)}</td>
      <td><span class="rb rb-${imp}">${imp}</span></td>
      <td class="col-r">${o.position !== null ? o.position.toFixed(1) : '—'}</td>
      <td class="col-r">${o.impressions.toLocaleString()}</td>
      <td class="col-r">${(o.ctr * 100).toFixed(1)}%</td>
      <td class="col-r">${o.potentialClicks > 0 ? '+' + o.potentialClicks.toLocaleString() : '—'}</td>
      <td><span class="rst rst-${rec.status || 'new'}">${rec.status || 'new'}</span></td>
    </tr>`;
  }).join('');

  // Gaps rows
  const gapRows = gscOppResult.gaps.slice(0, 20).map(o => `<tr>
    <td>${esc(o.keyword)}</td>
    <td>${o.type === 'not-ranking' ? '<span class="rb rb-high">No Visibility</span>' : '<span class="rb rb-medium">Ranking Poorly</span>'}</td>
    <td class="col-r">${o.position !== null ? '#' + Math.round(o.position) : '—'}</td>
    <td style="font-size:11px">${esc(o.recommendedAction)}</td>
  </tr>`).join('');

  // Page priority rows
  const pageMap = new Map();
  [...gscOppResult.priority, ...gscOppResult.quickWins, ...gscOppResult.gaps, ...gscOppResult.lowCtr].forEach(o => {
    if (!o.page) return;
    const ex = pageMap.get(o.page) || { pot: 0, n: 0 };
    ex.pot += o.potentialClicks || 0; ex.n++;
    pageMap.set(o.page, ex);
  });
  const rankedPages = [...pageMap.entries()].sort((a, b) => b[1].pot - a[1].pot).slice(0, 10);
  const pageRows = rankedPages.map(([url, d], i) => `<tr>
    <td class="col-r">${i + 1}</td>
    <td><a href="${esc(url)}">${esc(pathFromUrl(url))}</a></td>
    <td class="col-r">${d.n}</td>
    <td class="col-r">${d.pot > 0 ? '+' + d.pot.toLocaleString() : '—'}</td>
  </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEO Report — ${esc(property)} — ${dateStr}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;color:#0f172a;background:#f1f5f9;padding:32px 24px;max-width:980px;margin:0 auto}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
h2{font-size:14px;font-weight:700;margin:28px 0 12px;padding-bottom:6px;border-bottom:2px solid #e2e8f0;text-transform:uppercase;letter-spacing:.04em;color:#475569}
.rh{background:#fff;border-radius:10px;padding:22px 26px;margin-bottom:22px;border:1px solid #e2e8f0;border-left:5px solid #2563eb}
.rh h1{font-size:20px;font-weight:800;margin-bottom:4px}
.rh .meta{font-size:12px;color:#64748b}
.sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:22px}
.sc{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px}
.sc-lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:4px}
.sc-val{font-size:22px;font-weight:800}
.ta-list{display:flex;flex-direction:column;gap:8px;margin-bottom:8px}
.ta{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start}
.ta-n{width:24px;height:24px;border-radius:50%;background:#fef2f2;color:#dc2626;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1.5px solid #fecaca}
.ta-b{flex:1}.ta-kw{font-size:13px;font-weight:700;margin-bottom:3px}
.ta-act{font-size:12px;color:#334155;line-height:1.5}
.ta-pot{font-size:11px;font-weight:700;color:#16a34a;margin-top:3px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:20px;overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px}
th{background:#f8fafc;font-weight:700;color:#64748b;text-transform:uppercase;font-size:10px;letter-spacing:.04em}
tr:last-child td{border-bottom:none}
.col-r{text-align:right}
.rb{padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;display:inline-block}
.rb-high{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.rb-medium{background:#fffbeb;color:#d97706;border:1px solid #fde68a}
.rb-low{background:#f8fafc;color:#64748b;border:1px solid #e2e8f0}
.rst{padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;display:inline-block;background:#f1f5f9;color:#64748b}
.rst-done{background:#f0fdf4;color:#16a34a}.rst-in-progress{background:#fffbeb;color:#d97706}.rst-reviewed{background:#eff6ff;color:#2563eb}
.ft{text-align:center;font-size:11px;color:#94a3b8;margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0}
@media print{body{background:#fff;padding:16px}.card{box-shadow:none}}
</style></head>
<body>
<div class="rh">
  <h1>SEO Opportunities Report</h1>
  <div class="meta">${esc(property)} &nbsp;·&nbsp; ${esc(range)} &nbsp;·&nbsp; Generated ${dateStr}</div>
</div>
<div class="sg">
  <div class="sc"><div class="sc-lbl">Total Opportunities</div><div class="sc-val">${gscOppAllOpps.length}</div></div>
  <div class="sc"><div class="sc-lbl">High Impact</div><div class="sc-val" style="color:#dc2626">${impCounts.high}</div></div>
  <div class="sc"><div class="sc-lbl">Med. Impact</div><div class="sc-val" style="color:#d97706">${impCounts.medium}</div></div>
  <div class="sc"><div class="sc-lbl">In Progress</div><div class="sc-val" style="color:#d97706">${statusCounts['in-progress']}</div></div>
  <div class="sc"><div class="sc-lbl">Done</div><div class="sc-val" style="color:#16a34a">${statusCounts.done}</div></div>
  <div class="sc"><div class="sc-lbl">Content Gaps</div><div class="sc-val">${gscOppResult.gaps.filter(g => g.type === 'not-ranking').length}</div></div>
</div>
<h2>Top 5 Actions — Start Here</h2>
<div class="ta-list">${top5.map((o, i) => `
  <div class="ta"><div class="ta-n">${i + 1}</div>
  <div class="ta-b">
    <div class="ta-kw">${esc(o.keyword)} <span class="rb rb-${o.impact}">${o.impact} impact</span> <span class="rb" style="background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0">${o.classification}</span></div>
    <div class="ta-act">${esc(o.recommendedAction)}</div>
    ${o.potentialClicks > 0 ? `<div class="ta-pot">+${o.potentialClicks.toLocaleString()} estimated clicks</div>` : ''}
  </div></div>`).join('')}</div>
${priorityRows ? `<h2>Priority Opportunities — Service &amp; Brand Keywords</h2>
<div class="card"><table>
  <thead><tr><th>Keyword</th><th>Impact</th><th class="col-r">Position</th><th class="col-r">Impressions</th><th class="col-r">CTR</th><th class="col-r">Est. Gain</th><th>Status</th></tr></thead>
  <tbody>${priorityRows}</tbody>
</table></div>` : ''}
${gapRows ? `<h2>Content Gaps — Zero Visibility for Service Keywords</h2>
<div class="card"><table>
  <thead><tr><th>Keyword</th><th>Status</th><th class="col-r">Position</th><th>Recommended Action</th></tr></thead>
  <tbody>${gapRows}</tbody>
</table></div>` : ''}
${pageRows ? `<h2>Page Priority — Fix These Pages First</h2>
<div class="card"><table>
  <thead><tr><th class="col-r">#</th><th>Page</th><th class="col-r">Opportunities</th><th class="col-r">Est. Click Gain</th></tr></thead>
  <tbody>${pageRows}</tbody>
</table></div>` : ''}
<div class="ft">Generated by SEO Audit Tool · Elitez Group of Companies · ${dateStr}</div>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `seo-report-${now.toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Impact scoring ────────────────────────────────────────────────────────────

function calcImpact(o) {
  const isHighValue = o.classification === 'service' || o.classification === 'brand' || o.intent === 'commercial';
  const pot = o.potentialClicks || 0;
  const imp = o.impressions || 0;
  if (isHighValue) {
    if (imp >= 300 || pot >= 75) return 'high';
    if (imp >= 60  || pot >= 15) return 'medium';
    return 'low';
  }
  if (imp >= 1000 || pot >= 150) return 'high';
  if (imp >= 200  || pot >= 50)  return 'medium';
  return 'low';
}

// ── Top Actions renderer ──────────────────────────────────────────────────────

function deriveTAAction(o) {
  const path = o.page ? pathFromUrl(o.page) : null;
  const pg   = path ? `<strong>${esc(path)}</strong>` : 'the ranking page';
  const kw   = `<em>"${esc(o.keyword)}"</em>`;
  const pos  = o.position ? `#${o.position.toFixed(0)}` : null;
  const pot  = o.potentialClicks > 0 ? ` (+${o.potentialClicks.toLocaleString()} est. clicks)` : '';
  if (o.type === 'not-ranking')
    return `Create a dedicated landing page for ${kw} — zero impressions in GSC means competitors capture all this traffic.`;
  if (o.type === 'ranking-poor')
    return `Build topical authority for ${kw} — currently at ${pos || 'outside top 20'}. Deepen content, add schema, and build internal links to reach page 1.`;
  if (o.type === 'high-impressions' || o.type === 'low-ctr')
    return `Rewrite the meta title &amp; description for ${kw} on ${pg} — visible at ${pos} but CTR is below benchmark${pot}.`;
  if (o.type === 'quick-win')
    return `Push ${kw} from ${pos} into top 5 on ${pg} — strengthen content depth and add internal links${pot}.`;
  return esc(o.recommendedAction);
}

function renderTopActions(result) {
  const el = document.getElementById('opp-section-topactions');
  if (!el) return;

  const all = [...result.priority, ...result.gaps, ...result.quickWins, ...result.lowCtr];
  const seen = new Set();
  const deduped = [];
  all.forEach(o => {
    const id = oppId(o);
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push({ ...o, impact: calcImpact(o), effort: calcEffort(o) });
    }
  });

  // Only commercial/service/brand keywords qualify for Top Actions
  const candidates = deduped.filter(o =>
    o.classification === 'service' || o.classification === 'brand' || o.intent === 'commercial'
  );

  const highLow  = candidates
    .filter(o => o.impact === 'high' && o.effort === 'low')
    .sort((a, b) => (b.potentialClicks ?? 0) - (a.potentialClicks ?? 0))
    .slice(0, 3);

  const highHigh = candidates
    .filter(o => (o.impact === 'high' || o.impact === 'medium') && o.effort === 'high')
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, 3);

  if (highLow.length === 0 && highHigh.length === 0) { el.innerHTML = ''; return; }

  const clsCls    = c => ({ service: 'obadge-svc', brand: 'obadge-brand', commercial: 'obadge-commercial' }[c] || '');
  const intentCls = i => ({ commercial: 'obadge-commercial', informational: 'obadge-info', navigational: 'obadge-nav' }[i] || '');

  const renderGroup = (items, groupLabel, groupIcon, groupColor, effortLabel) => {
    if (!items.length) return '';
    const rows = items.map((o, i) => {
      const clBadge  = clsCls(o.classification) ? `<span class="opp-badge ${clsCls(o.classification)}">${o.classification}</span>` : '';
      const intBadge = o.intent && o.intent !== 'mixed' ? `<span class="opp-badge ${intentCls(o.intent)}">${o.intent}</span>` : '';
      return `
        <div class="ta-row">
          <div class="ta-rank ta-rank-${groupColor}">${i + 1}</div>
          <div class="ta-body">
            <div class="ta-top">
              <span class="ta-keyword">${esc(o.keyword)}</span>
              <span class="ta-badges">${clBadge}${intBadge}</span>
            </div>
            <div class="ta-action">${deriveTAAction(o)}</div>
            ${o.potentialClicks > 0 ? `<div class="ta-potential">+${o.potentialClicks.toLocaleString()} estimated clicks</div>` : ''}
          </div>
        </div>`;
    }).join('');
    return `
      <div class="ta-group">
        <div class="ta-group-hd ta-group-hd-${groupColor}">
          <span class="ta-group-icon">${groupIcon}</span>
          <span class="ta-group-label">${groupLabel}</span>
          <span class="ta-effort-tag">${effortLabel}</span>
        </div>
        <div class="ta-list">${rows}</div>
      </div>`;
  };

  el.innerHTML = `
    <div class="opp-section opp-section-topactions">
      <div class="opp-section-hd">
        <div class="opp-section-hd-row">
          <span class="opp-section-icon" style="background:#dc262618;color:#dc2626">🎯</span>
          <h2 class="opp-section-title">Decision Matrix</h2>
        </div>
        <p class="opp-section-desc">Commercial and service opportunities grouped by effort. Start with Quick Wins — they deliver results fastest.</p>
      </div>
      <div class="ta-groups">
        ${renderGroup(highLow,  'Quick Wins',         '⚡', 'green',  'High Impact · Low Effort')}
        ${renderGroup(highHigh, 'Strategic Bets',     '🏗', 'amber',  'High Impact · High Effort')}
      </div>
    </div>`;
}

// ── Page Priority renderer ────────────────────────────────────────────────────

function renderPagePriority(result) {
  const el = document.getElementById('opp-section-pages');
  if (!el) return;

  const pageMap = new Map();
  [...result.priority, ...result.quickWins, ...result.gaps, ...result.lowCtr].forEach(o => {
    if (!o.page) return;
    const existing = pageMap.get(o.page) || { totalPotential: 0, oppCount: 0, topKws: [], maxImpact: 'low' };
    existing.totalPotential += o.potentialClicks || 0;
    existing.oppCount++;
    if (existing.topKws.length < 3) existing.topKws.push(o.keyword);
    const imp = calcImpact(o);
    if (imp === 'high' || (imp === 'medium' && existing.maxImpact === 'low')) existing.maxImpact = imp;
    pageMap.set(o.page, existing);
  });

  if (pageMap.size === 0) { el.innerHTML = ''; return; }

  const ranked = [...pageMap.entries()]
    .sort((a, b) => b[1].totalPotential - a[1].totalPotential || b[1].oppCount - a[1].oppCount)
    .slice(0, 10);

  const maxPot = Math.max(ranked[0]?.[1].totalPotential || 1, 1);

  const rows = ranked.map(([url, data], i) => {
    const pct = Math.round((data.totalPotential / maxPot) * 100);
    const potLabel = data.totalPotential > 0 ? `+${data.totalPotential.toLocaleString()} est. clicks` : `${data.oppCount} opp${data.oppCount > 1 ? 's' : ''}`;
    const impCls = { high: 'impact-high', medium: 'impact-medium', low: 'impact-low' }[data.maxImpact];
    return `
      <div class="pp-row">
        <div class="pp-rank">${i + 1}</div>
        <div class="pp-body">
          <div class="pp-url"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(pathFromUrl(url))}</a>
            <span class="opp-badge ${impCls}" style="margin-left:6px;font-size:10px">${data.maxImpact} impact</span>
          </div>
          <div class="pp-kws">${data.topKws.map(k => `<span class="pp-kw-tag">${esc(k)}</span>`).join('')}${data.oppCount > data.topKws.length ? `<span class="pp-more">+${data.oppCount - data.topKws.length} more</span>` : ''}</div>
        </div>
        <div class="pp-right">
          <div class="pp-bar-track"><div class="pp-bar" style="width:${pct}%"></div></div>
          <div class="pp-potential">${esc(potLabel)}</div>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="opp-section">
      <div class="opp-section-hd">
        <div class="opp-section-hd-row">
          <span class="opp-section-icon" style="background:#0891b218;color:#0891b2">📄</span>
          <h2 class="opp-section-title">Page Priority</h2>
          <span class="opp-count-badge" style="background:#0891b218;color:#0891b2">${ranked.length}</span>
        </div>
        <p class="opp-section-desc">Pages ranked by combined opportunity potential. Fix these pages first for maximum impact.</p>
      </div>
      <div class="pp-list">${rows}</div>
    </div>`;
}

// ── Card renderer ─────────────────────────────────────────────────────────────

function renderOppCard(o) {
  const id  = oppId(o);
  const rec = getOppRecord(id);

  const classLabel  = { service: 'Service', brand: 'Brand', informational: 'Info', other: 'Other' }[o.classification] || o.classification;
  const typeLabel   = { 'quick-win': 'Quick Win', 'high-impressions': 'High Impr.', 'not-ranking': 'No Visibility', 'ranking-poor': 'Ranking Poorly', 'low-ctr': 'Low CTR' }[o.type] || o.type;
  const classCls    = { service: 'obadge-svc', brand: 'obadge-brand', informational: 'obadge-info', other: 'obadge-other' }[o.classification] || '';
  const typeCls     = { 'quick-win': 'obadge-qw', 'high-impressions': 'obadge-himp', 'not-ranking': 'obadge-nrank', 'ranking-poor': 'obadge-rpoor', 'low-ctr': 'obadge-lctr' }[o.type] || '';
  const intentLabel = { commercial: 'Commercial', informational: 'Informational', navigational: 'Navigational' }[o.intent] || '';
  const intentCls   = { commercial: 'obadge-commercial', informational: 'obadge-info', navigational: 'obadge-nav' }[o.intent] || '';
  const impact     = calcImpact(o);
  const impCls     = { high: 'impact-high', medium: 'impact-medium', low: 'impact-low' }[impact];
  const impLabel   = { high: 'High', medium: 'Med.', low: 'Low' }[impact];
  const posCls     = !o.position ? '' : o.position <= 3 ? 'pos-top' : o.position <= 10 ? 'pos-p1' : o.position <= 20 ? 'pos-p2' : 'pos-low';

  // Historical deltas
  const prevKw    = gscPrevSnapshot?.kwMap?.[o.keyword];
  const deltaPos  = prevKw && o.position !== null ? prevKw.p - o.position : null; // positive = improved
  const deltaImp  = prevKw ? o.impressions - prevKw.i : null;
  const deltaCtr  = prevKw ? o.ctr - prevKw.r : null;
  const fmtDelta  = (d, unit = '', invertColor = false) => {
    if (d === null || Math.abs(d) < 0.01) return '';
    const good  = invertColor ? d < 0 : d > 0;
    const sign  = d > 0 ? '+' : '';
    const label = unit === 'pos' ? `${sign}${Math.abs(d).toFixed(1)}` : unit === '%' ? `${sign}${(d * 100).toFixed(1)}%` : `${sign}${Math.abs(d) >= 1000 ? (d / 1000).toFixed(1) + 'k' : Math.round(d)}`;
    return `<span class="opp-delta ${good ? 'delta-pos' : 'delta-neg'}">${label}</span>`;
  };

  const metricsHtml = o.position !== null ? `
    <div class="opp-metrics">
      <span class="opp-m"><span class="opp-m-val ${posCls}">#${o.position.toFixed(1)}${fmtDelta(deltaPos, 'pos', true)}</span><span class="opp-m-lbl">Position</span></span>
      <span class="opp-m"><span class="opp-m-val">${o.impressions.toLocaleString()}${fmtDelta(deltaImp)}</span><span class="opp-m-lbl">Impressions</span></span>
      <span class="opp-m"><span class="opp-m-val">${(o.ctr * 100).toFixed(1)}%${fmtDelta(deltaCtr, '%')}</span><span class="opp-m-lbl">CTR</span></span>
      <span class="opp-m"><span class="opp-m-val">${o.clicks.toLocaleString()}</span><span class="opp-m-lbl">Clicks</span></span>
      ${o.potentialClicks > 0 ? `<span class="opp-m opp-potential"><span class="opp-m-val">+${o.potentialClicks.toLocaleString()}</span><span class="opp-m-lbl">Est. Gain</span></span>` : ''}
    </div>` : `<div class="opp-no-rank-pill">No ranking data in selected range</div>`;

  const pageLine = o.page
    ? `<div class="opp-page-line"><a href="${esc(o.page)}" target="_blank" rel="noopener" title="${esc(o.page)}">${esc(pathFromUrl(o.page))}</a>${o.country ? ` <span class="opp-country-tag">${esc(countryName(o.country))}</span>` : ''}</div>`
    : (o.country ? `<div class="opp-page-line opp-page-na">Page not tracked &nbsp;<span class="opp-country-tag">${esc(countryName(o.country))}</span></div>` : '');

  const statusOpts = [
    ['new',         'New'],
    ['reviewed',    'Reviewed'],
    ['in-progress', 'In Progress'],
    ['done',        'Done'],
    ['ignored',     'Ignored'],
  ].map(([v, l]) => `<option value="${v}"${rec.status === v ? ' selected' : ''}>${l}</option>`).join('');

  const actionOpts = [
    ['',                    '— Select action —'],
    ['optimize-existing',   'Optimize Existing Page'],
    ['create-new',          'Create New Page'],
    ['improve-ctr',         'Improve CTR'],
    ['add-internal-links',  'Add Internal Links'],
    ['expand-content',      'Expand Content'],
    ['other',               'Other'],
  ].map(([v, l]) => `<option value="${v}"${rec.actionType === v ? ' selected' : ''}>${l}</option>`).join('');

  return `
    <div class="opp-card opp-card-${impact}" data-opp-id="${id}" data-status="${esc(rec.status)}" data-impact="${impact}">
      <div class="opp-card-top">
        <div class="opp-keyword">${esc(o.keyword)}</div>
        <div class="opp-badges">
          <span class="opp-badge ${impCls}">${esc(impLabel)} Impact</span>
          <span class="opp-badge ${classCls}">${esc(classLabel)}</span>
          ${intentLabel ? `<span class="opp-badge ${intentCls}">${esc(intentLabel)}</span>` : ''}
          <span class="opp-badge ${typeCls}">${esc(typeLabel)}</span>
        </div>
      </div>
      ${pageLine}
      ${metricsHtml}
      <div class="opp-insight">
        <div class="opp-why"><strong>Why it matters:</strong> ${esc(o.whyItMatters)}</div>
        <div class="opp-action"><strong>Action:</strong> ${esc(o.recommendedAction)}</div>
      </div>
      <div class="opp-workflow">
        <div class="opp-wf-controls">
          <div class="opp-wf-field">
            <label class="opp-wf-label">Status</label>
            <select class="opp-status-sel opp-wf-sel" data-opp-id="${id}" data-status="${esc(rec.status)}">${statusOpts}</select>
          </div>
          <div class="opp-wf-field">
            <label class="opp-wf-label">Action Type</label>
            <select class="opp-action-sel opp-wf-sel" data-opp-id="${id}">${actionOpts}</select>
          </div>
          <div class="opp-wf-field">
            <label class="opp-wf-label">Owner</label>
            <input type="text" class="opp-owner-in opp-wf-in" placeholder="Name" data-opp-id="${id}" value="${esc(rec.owner || '')}">
          </div>
        </div>
        <div class="opp-wf-notes-row">
          <textarea class="opp-notes-ta" placeholder="Add notes…" rows="2" data-opp-id="${id}">${esc(rec.notes || '')}</textarea>
        </div>
        <div class="opp-wf-footer" data-opp-id="${id}">
          ${rec.updatedAt ? `<span class="opp-updated-at">Updated ${fmtRelTime(rec.updatedAt)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Section renderer ──────────────────────────────────────────────────────────

function renderOppSection(containerId, meta, opps, emptyMsg, configNeeded) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const countBadge = opps.length > 0
    ? `<span class="opp-count-badge" style="background:${meta.color}18;color:${meta.color}">${opps.length}</span>`
    : '';

  const body = configNeeded
    ? `<div class="opp-config-needed">
         <p>Define your service keywords to unlock this section.</p>
         <button class="btn-primary opp-open-config-btn">Configure Service Keywords</button>
       </div>`
    : opps.length === 0
      ? `<div class="opp-empty-section">${esc(emptyMsg)}</div>`
      : `<div class="opp-cards">${opps.map(renderOppCard).join('')}</div>`;

  el.innerHTML = `
    <div class="opp-section">
      <div class="opp-section-hd">
        <div class="opp-section-hd-row">
          <span class="opp-section-icon" style="background:${meta.color}18;color:${meta.color}">${meta.icon}</span>
          <h2 class="opp-section-title">${esc(meta.title)}</h2>
          ${countBadge}
        </div>
        <p class="opp-section-desc">${esc(meta.desc)}</p>
      </div>
      ${body}
    </div>`;

  el.querySelectorAll('.opp-open-config-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById('opp-config-panel');
      const toggle = document.getElementById('opp-config-toggle');
      if (panel) {
        panel.style.display = '';
        toggle?.classList.add('active');
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Pre-fill form
        const cfg    = loadOppConfig();
        const brandEl = document.getElementById('opp-cfg-brand');
        const svcEl   = document.getElementById('opp-cfg-service');
        const exclEl  = document.getElementById('opp-cfg-exclude');
        if (brandEl) brandEl.value = cfg.brand.join(', ');
        if (svcEl)   svcEl.value   = cfg.service.join('\n');
        if (exclEl)  exclEl.value  = (cfg.exclude || []).join('\n');
      }
    });
  });
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function renderOppSummary() {
  const el = document.getElementById('opp-summary-row');
  if (!el || !gscOppAllOpps.length) return;

  const tracker = loadOppTracker();
  const counts  = { new: 0, reviewed: 0, 'in-progress': 0, done: 0, ignored: 0 };
  gscOppAllOpps.forEach(o => {
    const st = (tracker[oppId(o)] || {}).status || 'new';
    if (counts[st] !== undefined) counts[st]++; else counts.new++;
  });

  el.innerHTML = `
    <div class="opp-summary-bar">
      <div class="opp-sum-pills">
        <span class="opp-sum-pill opp-sum-total">${gscOppAllOpps.length} Total</span>
        <span class="opp-sum-pill opp-sum-new"    data-fv="new">${counts.new} New</span>
        <span class="opp-sum-pill opp-sum-review" data-fv="reviewed">${counts.reviewed} Reviewed</span>
        <span class="opp-sum-pill opp-sum-prog"   data-fv="in-progress">${counts['in-progress']} In Progress</span>
        <span class="opp-sum-pill opp-sum-done"   data-fv="done">${counts.done} Done</span>
        <span class="opp-sum-pill opp-sum-ign"    data-fv="ignored">${counts.ignored} Ignored</span>
      </div>
    </div>`;

  el.querySelectorAll('[data-fv]').forEach(pill => {
    pill.addEventListener('click', () => {
      const v = pill.dataset.fv;
      oppFilterStatus = oppFilterStatus === v ? 'all' : v;
      const sel = document.getElementById('opp-f-status');
      if (sel) sel.value = oppFilterStatus;
      updateFilterResetBtn();
      applyOppFilters();
    });
  });
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function updateFilterResetBtn() {
  const btn    = document.getElementById('opp-f-reset');
  const active = oppFilterStatus !== 'all' || oppFilterAction !== 'all' || oppFilterClass !== 'all' || oppFilterCountry !== 'all';
  if (btn) btn.style.display = active ? '' : 'none';
}

function renderOppFilterBar() {
  const el = document.getElementById('opp-filter-bar');
  if (!el) return;

  const countries = [...new Set(gscOppAllOpps.map(o => o.country).filter(Boolean))].sort();
  const active    = oppFilterStatus !== 'all' || oppFilterAction !== 'all' || oppFilterClass !== 'all' || oppFilterCountry !== 'all';

  el.innerHTML = `
    <div class="opp-filter-bar">
      <div class="opp-filter-left">
        <div class="opp-filter-group">
          <label class="gsc-label">Status</label>
          <select id="opp-f-status" class="opp-filter-sel">
            <option value="all">All Statuses</option>
            <option value="new">New</option>
            <option value="reviewed">Reviewed</option>
            <option value="in-progress">In Progress</option>
            <option value="done">Done</option>
            <option value="ignored">Ignored</option>
          </select>
        </div>
        <div class="opp-filter-group">
          <label class="gsc-label">Action Type</label>
          <select id="opp-f-action" class="opp-filter-sel">
            <option value="all">All Actions</option>
            <option value="optimize-existing">Optimize Existing</option>
            <option value="create-new">Create New Page</option>
            <option value="improve-ctr">Improve CTR</option>
            <option value="add-internal-links">Internal Links</option>
            <option value="expand-content">Expand Content</option>
            <option value="other">Other</option>
            <option value="">Not Assigned</option>
          </select>
        </div>
        <div class="opp-filter-group">
          <label class="gsc-label">Classification</label>
          <select id="opp-f-class" class="opp-filter-sel">
            <option value="all">All Types</option>
            <option value="service">Service</option>
            <option value="brand">Brand</option>
            <option value="informational">Informational</option>
            <option value="other">Other</option>
          </select>
        </div>
        ${countries.length > 0 ? `
        <div class="opp-filter-group">
          <label class="gsc-label">Country</label>
          <select id="opp-f-country" class="opp-filter-sel">
            <option value="all">All Countries</option>
            ${countries.map(c => `<option value="${esc(c)}">${esc(countryName(c))}</option>`).join('')}
          </select>
        </div>` : ''}
      </div>
      <div class="opp-filter-right">
        <label class="opp-hide-low-label">
          <input type="checkbox" id="opp-f-hide-low"${oppHideLowImpact ? ' checked' : ''}> Hide low-impact
        </label>
        <button id="opp-f-reset" class="btn-ghost" style="display:${active ? '' : 'none'}">Reset Filters</button>
      </div>
    </div>`;

  const statusSel  = document.getElementById('opp-f-status');
  const actionSel  = document.getElementById('opp-f-action');
  const classSel   = document.getElementById('opp-f-class');
  const countrySel = document.getElementById('opp-f-country');
  const resetBtn   = document.getElementById('opp-f-reset');

  if (statusSel)  statusSel.value  = oppFilterStatus;
  if (actionSel)  actionSel.value  = oppFilterAction;
  if (classSel)   classSel.value   = oppFilterClass;
  if (countrySel) countrySel.value = oppFilterCountry;

  const onChange = () => {
    oppFilterStatus  = statusSel?.value  || 'all';
    oppFilterAction  = actionSel?.value  || 'all';
    oppFilterClass   = classSel?.value   || 'all';
    oppFilterCountry = countrySel?.value || 'all';
    updateFilterResetBtn();
    applyOppFilters();
  };

  statusSel?.addEventListener('change',  onChange);
  actionSel?.addEventListener('change',  onChange);
  classSel?.addEventListener('change',   onChange);
  countrySel?.addEventListener('change', onChange);

  resetBtn?.addEventListener('click', () => {
    oppFilterStatus = oppFilterAction = oppFilterClass = oppFilterCountry = 'all';
    if (statusSel)  statusSel.value  = 'all';
    if (actionSel)  actionSel.value  = 'all';
    if (classSel)   classSel.value   = 'all';
    if (countrySel) countrySel.value = 'all';
    updateFilterResetBtn();
    applyOppFilters();
  });

  document.getElementById('opp-f-hide-low')?.addEventListener('change', e => {
    oppHideLowImpact = e.target.checked;
    applyOppFilters();
  });
}

// ── Apply filters & re-render sections ────────────────────────────────────────

function applyOppFilters() {
  if (!gscOppResult) return;

  const tracker = loadOppTracker();
  const config  = loadOppConfig();
  const hasSvc  = config.service.length > 0;

  // Show export button whenever we have data
  const exportBtn = document.getElementById('opp-export-btn');
  if (exportBtn) exportBtn.style.display = '';

  const filter = opps => opps.filter(o => {
    const rec = tracker[oppId(o)] || {};
    const st  = rec.status     || 'new';
    const at  = rec.actionType || '';
    if (oppFilterStatus  !== 'all' && st                      !== oppFilterStatus)  return false;
    if (oppFilterAction  !== 'all' && at                      !== oppFilterAction)  return false;
    if (oppFilterClass   !== 'all' && o.classification        !== oppFilterClass)   return false;
    if (oppFilterCountry !== 'all' && (o.country || '')       !== oppFilterCountry) return false;
    if (oppHideLowImpact && calcImpact(o) === 'low')                                return false;
    return true;
  });

  const isFiltered = oppFilterStatus !== 'all' || oppFilterAction !== 'all' || oppFilterClass !== 'all' || oppFilterCountry !== 'all';
  const noMatch    = 'No opportunities match the current filters.';

  renderTopActions(gscOppResult);

  renderOppSection('opp-section-priority', {
    icon: '🎯', title: 'Priority Opportunities', color: '#2563eb',
    desc: 'Service and brand keywords with the highest business impact. Act on these first.',
  }, filter(gscOppResult.priority),
    isFiltered ? noMatch : 'No priority opportunities found for your service keywords in the current date range.',
    !hasSvc);

  renderOppSection('opp-section-gaps', {
    icon: '🔍', title: 'Strategic Gaps', color: '#d97706',
    desc: 'Service keywords with no visibility or ranking outside the top 20 — missed business opportunities.',
  }, filter(gscOppResult.gaps),
    isFiltered ? noMatch : 'No strategic gaps found. All your service keywords appear in the top 20.',
    !hasSvc);

  renderPageMapping(gscRows, gscDims, config);
  renderPagePriority(gscOppResult);

  renderOppSection('opp-section-quickwins', {
    icon: '⚡', title: 'Quick Wins', color: '#16a34a',
    desc: 'All keywords ranking 8–20 across every page. Small optimisations here can unlock significant traffic.',
  }, filter(gscOppResult.quickWins),
    isFiltered ? noMatch : 'No quick win opportunities found. Try a longer date range or check that data was loaded with the Query dimension.');

  renderOppSection('opp-section-lowctr', {
    icon: '📈', title: 'Low CTR Opportunities', color: '#7c3aed',
    desc: 'Service and brand keywords with strong search visibility but below-average click-through rates.',
  }, filter(gscOppResult.lowCtr),
    isFiltered ? noMatch : 'No low CTR issues found for service or brand keywords.',
    !hasSvc);
}

// ── Card footer refresh (after inline edit) ───────────────────────────────────

function refreshCardFooter(id) {
  const el  = document.querySelector(`.opp-wf-footer[data-opp-id="${id}"]`);
  const rec = getOppRecord(id);
  if (el) el.innerHTML = rec.updatedAt ? `<span class="opp-updated-at">Updated ${fmtRelTime(rec.updatedAt)}</span>` : '';
}

// ── Main refresh ──────────────────────────────────────────────────────────────

function refreshOpportunities() {
  const noDataEl  = document.getElementById('opp-no-data');
  const contentEl = document.getElementById('opp-content');
  if (!noDataEl || !contentEl) return;

  if (!gscRows || gscRows.length === 0) {
    noDataEl.innerHTML = `
      <div class="opp-connect-prompt">
        <div class="opp-connect-icon">📊</div>
        <h3>Load Search Console data first</h3>
        <p>Go to <strong>Search Performance</strong>, connect Google Search Console, and click <strong>Load Data</strong>.</p>
        <p class="opp-connect-tip">Make sure the <strong>Query</strong> dimension is checked so keyword data is included.</p>
      </div>`;
    noDataEl.style.display = '';
    contentEl.style.display = 'none';
    return;
  }

  if (!gscDims.includes('query')) {
    noDataEl.innerHTML = `
      <div class="opp-connect-prompt">
        <div class="opp-connect-icon">⚙️</div>
        <h3>Query dimension required</h3>
        <p>Go to <strong>Search Performance</strong>, check the <strong>Query</strong> checkbox, and reload the data.</p>
      </div>`;
    noDataEl.style.display = '';
    contentEl.style.display = 'none';
    return;
  }

  noDataEl.style.display  = 'none';
  contentEl.style.display = '';

  gscOppResult = analyzeOpportunities(gscRows, gscDims, loadOppConfig());
  if (!gscOppResult) return;

  // Build deduplicated flat list (used for summary counts — immune to per-section filters)
  const seen = new Set();
  gscOppAllOpps = [];
  [...gscOppResult.priority, ...gscOppResult.quickWins, ...gscOppResult.gaps, ...gscOppResult.lowCtr].forEach(o => {
    const id = oppId(o);
    if (!seen.has(id)) { seen.add(id); gscOppAllOpps.push(o); }
  });

  renderOppSummary();
  renderOppFilterBar();
  applyOppFilters();
}

// ── Config panel wiring ───────────────────────────────────────────────────────

(function initOppConfigPanel() {
  const toggleBtn   = document.getElementById('opp-config-toggle');
  const panel       = document.getElementById('opp-config-panel');
  const saveBtn     = document.getElementById('opp-cfg-save');
  const cancelBtn   = document.getElementById('opp-cfg-cancel');
  const brandEl     = document.getElementById('opp-cfg-brand');
  const svcEl       = document.getElementById('opp-cfg-service');
  const exclEl      = document.getElementById('opp-cfg-exclude');
  const nameEl      = document.getElementById('opp-cfg-name');
  const domainEl    = document.getElementById('opp-cfg-domain');
  const loadSelEl   = document.getElementById('opp-cfg-load-sel');
  const loadBtnEl   = document.getElementById('opp-cfg-load-btn');
  const deleteBtnEl = document.getElementById('opp-cfg-delete-btn');
  const saveProjBtn = document.getElementById('opp-cfg-save-project');
  const exportBtn   = document.getElementById('opp-export-btn');

  if (!toggleBtn || !panel) return;

  const currentConfig = () => ({
    brand:   (brandEl?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    service: (svcEl?.value   || '').split('\n').map(s => s.trim()).filter(Boolean),
    exclude: (exclEl?.value  || '').split('\n').map(s => s.trim()).filter(Boolean),
  });

  const refreshProjectList = () => {
    if (!loadSelEl) return;
    const projects = loadProjects();
    loadSelEl.innerHTML = `<option value="">— Select saved project —</option>` +
      projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.domain ? ' · ' + esc(p.domain) : ''}</option>`).join('');
  };

  const fillForm = () => {
    const cfg = loadOppConfig();
    if (brandEl)  brandEl.value  = cfg.brand.join(', ');
    if (svcEl)    svcEl.value    = cfg.service.join('\n');
    if (exclEl)   exclEl.value   = (cfg.exclude || []).join('\n');
    refreshProjectList();
  };

  toggleBtn.addEventListener('click', () => {
    const isOpen = panel.style.display !== 'none' && panel.style.display !== '';
    panel.style.display = isOpen ? 'none' : '';
    toggleBtn.classList.toggle('active', !isOpen);
    if (!isOpen) fillForm();
  });

  // Save & Refresh (apply config without saving as named project)
  saveBtn?.addEventListener('click', () => {
    saveOppConfig(currentConfig());
    panel.style.display = 'none';
    toggleBtn.classList.remove('active');
    refreshOpportunities();
  });

  cancelBtn?.addEventListener('click', () => {
    panel.style.display = 'none';
    toggleBtn.classList.remove('active');
  });

  // Save as named project
  saveProjBtn?.addEventListener('click', () => {
    const name = nameEl?.value.trim();
    if (!name) { nameEl?.focus(); nameEl?.setCustomValidity('Enter a project name'); return; }
    const cfg = currentConfig();
    saveOppConfig(cfg);
    saveProject(name, domainEl?.value || '', cfg);
    refreshProjectList();
    saveProjBtn.textContent = 'Saved ✓';
    setTimeout(() => { saveProjBtn.textContent = 'Save as Project'; }, 2000);
  });

  // Load selected project
  loadBtnEl?.addEventListener('click', () => {
    const name = loadSelEl?.value;
    if (!name) return;
    const proj = loadProjects().find(p => p.name === name);
    if (!proj) return;
    if (nameEl)   nameEl.value   = proj.name;
    if (domainEl) domainEl.value = proj.domain || '';
    if (brandEl)  brandEl.value  = (proj.config.brand || []).join(', ');
    if (svcEl)    svcEl.value    = (proj.config.service || []).join('\n');
    if (exclEl)   exclEl.value   = (proj.config.exclude || []).join('\n');
    saveOppConfig(proj.config);
    panel.style.display = 'none';
    toggleBtn.classList.remove('active');
    refreshOpportunities();
  });

  // Delete selected project
  deleteBtnEl?.addEventListener('click', () => {
    const name = loadSelEl?.value;
    if (!name) return;
    if (!confirm(`Delete project "${name}"?`)) return;
    deleteProject(name);
    refreshProjectList();
  });

  // Export button
  exportBtn?.addEventListener('click', exportOppReport);
})();

// ── Workflow event delegation (attached once to the persistent container) ─────

(function initOppWorkflowEvents() {
  const contentEl = document.getElementById('opp-content');
  if (!contentEl) return;

  let debounceTimer;

  contentEl.addEventListener('change', e => {
    const id = e.target.dataset.oppId;
    if (!id) return;

    if (e.target.classList.contains('opp-status-sel')) {
      const val = e.target.value;
      e.target.dataset.status = val;
      setOppRecord(id, { status: val });
      // Update card's data-status for CSS-driven visual
      const card = contentEl.querySelector(`.opp-card[data-opp-id="${id}"]`);
      if (card) card.dataset.status = val;
      refreshCardFooter(id);
      renderOppSummary();   // update counts live
    } else if (e.target.classList.contains('opp-action-sel')) {
      setOppRecord(id, { actionType: e.target.value });
      refreshCardFooter(id);
    }
  });

  contentEl.addEventListener('input', e => {
    const id = e.target.dataset.oppId;
    if (!id) return;
    if (!e.target.classList.contains('opp-owner-in') && !e.target.classList.contains('opp-notes-ta')) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const patch = e.target.classList.contains('opp-owner-in')
        ? { owner: e.target.value }
        : { notes: e.target.value };
      setOppRecord(id, patch);
      refreshCardFooter(id);
    }, 500);
  });
})();

// ═════════════════════════════════════════════════════════════════════════════
// AI VISIBILITY — GEO (Generative Engine Optimization)
// ═════════════════════════════════════════════════════════════════════════════

// ── Signal extractors ─────────────────────────────────────────────────────────

function geoGetCheck(page, name) {
  return (page.checks || []).find(c => c.check === name) || null;
}

function geoParseWordCount(page) {
  const c = geoGetCheck(page, 'Word Count');
  if (!c) return 0;
  const m = c.message.match(/(\d[\d,]*)\s+word/i);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
}

function geoParseHeadings(page) {
  const c = geoGetCheck(page, 'Heading Structure');
  if (!c) return { h1: 0, h2: 0, h3: 0, h4: 0 };
  const n = tag => parseInt(c.message.match(new RegExp(tag + ':(\\d+)', 'i'))?.[1] || 0, 10);
  return { h1: n('H1'), h2: n('H2'), h3: n('H3'), h4: n('H4') };
}

function geoParseSchema(page) {
  const c = geoGetCheck(page, 'Schema Markup');
  if (!c || c.status === 'warn') return { types: [], hasFaq: false, hasHowTo: false, hasService: false, count: 0 };
  const countM = c.message.match(/^(\d+)/);
  const count  = countM ? parseInt(countM[1], 10) : 1;
  const after  = c.message.match(/found[:\s]+(.+)$/i);
  const types  = after ? after[1].replace(/\.$/, '').split(',').map(s => s.trim()).filter(Boolean) : [];
  const lower  = c.message.toLowerCase();
  return {
    types, count,
    hasFaq:     lower.includes('faqpage') || lower.includes('faq'),
    hasHowTo:   lower.includes('howto'),
    hasService: lower.includes('service') || lower.includes('localbusiness') || lower.includes('organization'),
  };
}

function geoParseTitle(page) {
  const c = geoGetCheck(page, 'Page Title');
  if (!c || c.status === 'fail') return '';
  const m = c.message.match(/"([^"]+)"/);
  return m ? m[1] : '';
}

function geoParseMetaDesc(page) {
  const c = geoGetCheck(page, 'Meta Description');
  if (!c) return { exists: false, good: false };
  return { exists: c.status !== 'fail', good: c.status === 'pass' };
}

function geoParseInternalLinks(page) {
  const c = geoGetCheck(page, 'Internal Links');
  if (!c) return 0;
  const m = c.message.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function geoIsNoindex(page) {
  const c = geoGetCheck(page, 'noindex Tag');
  return c ? c.status === 'fail' : false;
}

// ── GEO Score (0-100) ─────────────────────────────────────────────────────────
// Breakdown: Content (25) + Structure (25) + Schema (25) + Clarity (15) + Authority (10)

function calcGeoScore(page) {
  if (page.httpError || page.fetchError || (page.status >= 400 && page.status > 0)) {
    return { score: 0, breakdown: { content: 0, structure: 0, schema: 0, clarity: 0, authority: 0 }, details: null, error: true };
  }

  const wc     = geoParseWordCount(page);
  const h      = geoParseHeadings(page);
  const schema = geoParseSchema(page);
  const meta   = geoParseMetaDesc(page);
  const links  = geoParseInternalLinks(page);
  const noix   = geoIsNoindex(page);
  const canon  = (geoGetCheck(page, 'Canonical Tag') || {}).status === 'pass';
  const title  = geoParseTitle(page);

  if (noix) {
    return { score: 5, breakdown: { content: 0, structure: 0, schema: 0, clarity: 5, authority: 0 }, details: { wc, h, schema, meta, links, noix, canon, title }, noindex: true };
  }

  let content = 0;
  if (wc >= 1500)      content = 25;
  else if (wc >= 1000) content = 22;
  else if (wc >= 600)  content = 17;
  else if (wc >= 300)  content = 10;
  else if (wc > 0)     content = 4;

  const totalH = h.h2 + h.h3;
  let structure = 0;
  if (totalH >= 6)      structure = 25;
  else if (totalH >= 4) structure = 20;
  else if (totalH >= 2) structure = 14;
  else if (totalH >= 1) structure = 8;
  else if (h.h1 > 0)   structure = 3;

  let schemaScore = 0;
  if (schema.hasFaq && schema.hasService) schemaScore = 25;
  else if (schema.hasFaq || schema.hasHowTo) schemaScore = 20;
  else if (schema.hasService) schemaScore = 15;
  else if (schema.types.length > 0) schemaScore = 10;

  let clarity = 0;
  if (meta.good)        clarity = 15;
  else if (meta.exists) clarity = 8;
  else if (title)       clarity = 4;

  let authority = 0;
  if (links >= 10)     authority = 10;
  else if (links >= 5) authority = 7;
  else if (links >= 2) authority = 4;

  const score = Math.min(100, content + structure + schemaScore + clarity + authority);
  return { score, breakdown: { content, structure, schema: schemaScore, clarity, authority }, details: { wc, h, schema, meta, links, noix, canon, title } };
}

function geoTier(score) {
  if (score >= 80) return { label: 'AI-Ready',  cls: 'geo-tier-ready', color: '#16a34a' };
  if (score >= 60) return { label: 'Good',       cls: 'geo-tier-good',  color: '#2563eb' };
  if (score >= 40) return { label: 'Needs Work', cls: 'geo-tier-needs', color: '#d97706' };
  return               { label: 'Not Ready',  cls: 'geo-tier-poor',  color: '#dc2626' };
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function renderGeoSummary(scored) {
  const el = document.getElementById('geo-summary');
  if (!el) return;
  const valid = scored.filter(s => !s.gs.error);
  if (!valid.length) { el.innerHTML = ''; return; }

  const avg = Math.round(valid.reduce((s, p) => s + p.gs.score, 0) / valid.length);
  const counts = { ready: 0, good: 0, needs: 0, poor: 0 };
  valid.forEach(({ gs }) => {
    if (gs.score >= 80)      counts.ready++;
    else if (gs.score >= 60) counts.good++;
    else if (gs.score >= 40) counts.needs++;
    else                     counts.poor++;
  });
  const tier = geoTier(avg);

  // Average each component across all valid pages
  const n = valid.length;
  const compAvg = {
    content:   Math.round(valid.reduce((s, p) => s + p.gs.breakdown.content,   0) / n),
    structure: Math.round(valid.reduce((s, p) => s + p.gs.breakdown.structure, 0) / n),
    schema:    Math.round(valid.reduce((s, p) => s + p.gs.breakdown.schema,    0) / n),
    clarity:   Math.round(valid.reduce((s, p) => s + p.gs.breakdown.clarity,   0) / n),
    authority: Math.round(valid.reduce((s, p) => s + p.gs.breakdown.authority, 0) / n),
  };
  const compBar = (val, max, color, label) => {
    const pct = Math.round((val / max) * 100);
    return `<div class="geo-comp-item">
      <div class="geo-comp-label">${label}</div>
      <div class="geo-comp-track"><div class="geo-comp-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="geo-comp-val" style="color:${color}">${val}/${max}</div>
    </div>`;
  };

  el.innerHTML = `
    <div class="geo-section">
      <div class="geo-summary-bar">
        <div class="geo-sum-score">
          <div class="geo-avg-num" style="color:${tier.color}">${avg}</div>
          <div class="geo-avg-lbl">Avg GEO Score</div>
          <span class="geo-tier-badge ${tier.cls}">${tier.label}</span>
        </div>
        <div class="geo-sum-divider"></div>
        <div class="geo-sum-stats">
          <div class="geo-stat"><span class="geo-stat-val" style="color:#16a34a">${counts.ready}</span><span class="geo-stat-lbl">AI-Ready</span></div>
          <div class="geo-stat"><span class="geo-stat-val" style="color:#2563eb">${counts.good}</span><span class="geo-stat-lbl">Good</span></div>
          <div class="geo-stat"><span class="geo-stat-val" style="color:#d97706">${counts.needs}</span><span class="geo-stat-lbl">Needs Work</span></div>
          <div class="geo-stat"><span class="geo-stat-val" style="color:#dc2626">${counts.poor}</span><span class="geo-stat-lbl">Not Ready</span></div>
          <div class="geo-stat"><span class="geo-stat-val">${valid.length}</span><span class="geo-stat-lbl">Pages</span></div>
        </div>
        <div class="geo-seg-bar-wrap">
          <div class="geo-seg-bar">
            ${counts.ready ? `<div class="geo-seg geo-seg-ready" style="flex:${counts.ready}" title="AI-Ready (${counts.ready})"></div>` : ''}
            ${counts.good  ? `<div class="geo-seg geo-seg-good"  style="flex:${counts.good}"  title="Good (${counts.good})"></div>` : ''}
            ${counts.needs ? `<div class="geo-seg geo-seg-needs" style="flex:${counts.needs}" title="Needs Work (${counts.needs})"></div>` : ''}
            ${counts.poor  ? `<div class="geo-seg geo-seg-poor"  style="flex:${counts.poor}"  title="Not Ready (${counts.poor})"></div>` : ''}
          </div>
          <div class="geo-seg-legend">
            <span class="geo-seg-lbl" style="color:#16a34a">AI-Ready ≥80</span>
            <span class="geo-seg-lbl" style="color:#2563eb">Good ≥60</span>
            <span class="geo-seg-lbl" style="color:#d97706">Needs Work ≥40</span>
            <span class="geo-seg-lbl" style="color:#dc2626">Not Ready &lt;40</span>
          </div>
        </div>
      </div>
      <div class="geo-comp-breakdown">
        <div class="geo-comp-hd">Avg component scores across ${n} pages</div>
        <div class="geo-comp-bars">
          ${compBar(compAvg.content,   25, '#2563eb', 'Content Depth')}
          ${compBar(compAvg.structure, 25, '#7c3aed', 'Structure')}
          ${compBar(compAvg.schema,    25, '#16a34a', 'Entity Signals')}
          ${compBar(compAvg.clarity,   15, '#d97706', 'Answer Clarity')}
          ${compBar(compAvg.authority, 10, '#0891b2', 'Link Authority')}
        </div>
      </div>
    </div>`;
}

// ── GEO Readiness table ───────────────────────────────────────────────────────

function renderGeoReadiness(scored) {
  const el = document.getElementById('geo-section-readiness');
  if (!el) return;
  const valid = scored.filter(s => !s.gs.error).sort((a, b) => a.gs.score - b.gs.score);
  if (!valid.length) { el.innerHTML = ''; return; }

  const miniBar = (val, max, color) => {
    const pct = Math.round((val / max) * 100);
    return `<div class="geo-mini-track"><div class="geo-mini-fill" style="width:${pct}%;background:${color}"></div></div>`;
  };

  const rows = valid.map(({ page, gs }) => {
    const tier   = geoTier(gs.score);
    const d      = gs.details;
    const path   = (page.path || '/').length > 44 ? page.path.slice(0, 42) + '…' : (page.path || '/');
    const totalH = d ? d.h.h2 + d.h.h3 : 0;
    return `<tr>
      <td class="geo-page-cell"><a href="${esc(page.url)}" target="_blank" rel="noopener" title="${esc(page.url)}">${esc(path)}</a></td>
      <td>
        <div class="geo-score-cell">
          <span class="geo-score-num" style="color:${tier.color}">${gs.score}</span>
          <span class="geo-tier-badge ${tier.cls}">${tier.label}</span>
        </div>
      </td>
      <td class="geo-bar-cell">${miniBar(gs.breakdown.content, 25, '#2563eb')}<span class="geo-bar-lbl">${d ? d.wc.toLocaleString() + 'w' : '—'}</span></td>
      <td class="geo-bar-cell">${miniBar(gs.breakdown.structure, 25, '#7c3aed')}<span class="geo-bar-lbl">${d ? totalH + ' hdgs' : '—'}</span></td>
      <td class="geo-bar-cell">${miniBar(gs.breakdown.schema, 25, '#16a34a')}<span class="geo-bar-lbl">${d && d.schema.types.length ? d.schema.types[0] : '—'}</span></td>
      <td class="geo-bar-cell">${miniBar(gs.breakdown.clarity, 15, '#d97706')}<span class="geo-bar-lbl">${d ? (d.meta.good ? '✓ Good' : d.meta.exists ? '~ Short' : '✗ None') : '—'}</span></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="geo-section">
      <div class="geo-section-hd">
        <h2 class="geo-section-title">GEO Readiness — All Pages</h2>
        <p class="geo-section-desc">Ranked worst-to-best. Fix the top rows first — they represent the highest GEO improvement potential.</p>
      </div>
      <div class="geo-table-wrap">
        <table class="geo-table">
          <thead><tr>
            <th>Page</th><th>GEO Score</th>
            <th>Content Depth <span class="geo-th-max">/25</span></th>
            <th>Structure <span class="geo-th-max">/25</span></th>
            <th>Entity Signals <span class="geo-th-max">/25</span></th>
            <th>Answer Clarity <span class="geo-th-max">/15</span></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Prompt Simulation ─────────────────────────────────────────────────────────

function renderGeoPrompt() {
  const el = document.getElementById('geo-section-prompt');
  if (!el) return;
  el.innerHTML = `
    <div class="geo-section geo-prompt-section">
      <div class="geo-section-hd">
        <h2 class="geo-section-title">Prompt Simulation</h2>
        <p class="geo-section-desc">Enter a query a user might type into ChatGPT, Perplexity, or Google AI Overviews. We match it against your crawled pages and score how well each page would serve as an answer source.</p>
      </div>
      <div class="geo-prompt-row">
        <input type="text" id="geo-prompt-in" class="geo-prompt-input" placeholder="e.g. best recruitment agency in Singapore" />
        <button id="geo-prompt-btn" class="btn-primary">Evaluate</button>
      </div>
      <div id="geo-prompt-results"></div>
    </div>`;
  document.getElementById('geo-prompt-btn')?.addEventListener('click', runGeoPromptSim);
  document.getElementById('geo-prompt-in')?.addEventListener('keydown', e => { if (e.key === 'Enter') runGeoPromptSim(); });
}

function runGeoPromptSim() {
  const input = (document.getElementById('geo-prompt-in')?.value || '').trim();
  const resEl = document.getElementById('geo-prompt-results');
  if (!resEl) return;
  if (!input) { resEl.innerHTML = '<p class="geo-hint">Enter a query above and click Evaluate.</p>'; return; }

  const validPages = (allPages || []).filter(p => !p.httpError && !p.fetchError && p.status < 400 && p.checks?.length);
  if (!validPages.length) { resEl.innerHTML = '<p class="geo-hint">No crawl data — run a Technical Audit first.</p>'; return; }

  const STOP  = new Set(['the','and','for','that','with','from','this','are','was','its','not','but','have','you','your','will','our','all']);
  const terms = input.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));
  if (!terms.length) { resEl.innerHTML = '<p class="geo-hint">Query too short — use at least 2-3 meaningful words.</p>'; return; }

  const results = validPages.map(page => {
    const gs       = calcGeoScore(page);
    const title    = geoParseTitle(page).toLowerCase();
    const path     = page.path.toLowerCase();
    const titleHits = terms.filter(t => title.includes(t)).length;
    const pathHits  = terms.filter(t => path.includes(t)).length;

    let gscBoost = 0;
    if (gscDims.includes('query') && gscDims.includes('page')) {
      const qIdx = gscDims.indexOf('query'), pgIdx = gscDims.indexOf('page');
      gscRows.forEach(row => {
        if ((row.keys?.[pgIdx] || '') !== page.url) return;
        const kw = (row.keys?.[qIdx] || '').toLowerCase();
        const hit = terms.filter(t => kw.includes(t)).length / terms.length;
        if (hit > 0.4) gscBoost = Math.max(gscBoost, hit * 30);
      });
    }

    const matchScore = Math.min(100, Math.round((titleHits / terms.length) * 50 + (pathHits / terms.length) * 15 + gscBoost));
    const fitScore   = Math.min(100, Math.round(gs.score * 0.55 + matchScore * 0.45));
    return { page, gs, matchScore, fitScore, titleHits };
  }).filter(r => r.matchScore > 0).sort((a, b) => b.fitScore - a.fitScore).slice(0, 5);

  if (!results.length) {
    resEl.innerHTML = `
      <div class="geo-no-match">
        <div class="geo-no-match-icon">🔍</div>
        <strong>No pages match this query</strong>
        <p>None of your crawled pages have title or URL signals for <em>"${esc(input)}"</em>. This is a content gap — consider creating a dedicated page targeting this topic.</p>
      </div>`;
    return;
  }

  const pgGscMap = buildPageGscMap(gscRows, gscDims);
  const intentOfQuery = detectIntent(input);
  const intentColor   = { commercial: '#7c3aed', informational: '#0891b2', navigational: '#16a34a', mixed: '#64748b' }[intentOfQuery] || '#64748b';

  const cards = results.map((r, i) => {
    const tier   = geoTier(r.gs.score);
    const d      = r.gs.details;
    const fColor = r.fitScore >= 70 ? '#16a34a' : r.fitScore >= 50 ? '#d97706' : '#dc2626';
    const path   = (r.page.path || '/').length > 52 ? r.page.path.slice(0, 50) + '…' : (r.page.path || '/');

    // SEO performance for this page
    const seoData  = pgGscMap.get(r.page.url);
    const seoHtml  = seoData
      ? `<div class="geo-sim-seo">
           <span class="geo-sim-seo-lbl">SEO</span>
           <span class="geo-sim-seo-pill">Best pos: <strong>#${Math.round(seoData.bestPos !== Infinity ? seoData.bestPos : 0)}</strong></span>
           <span class="geo-sim-seo-pill">${seoData.impressions.toLocaleString()} impr</span>
           <span class="geo-sim-seo-pill">${(seoData.ctr * 100).toFixed(1)}% CTR</span>
         </div>`
      : '<div class="geo-sim-seo geo-sim-seo-none">No GSC data for this page</div>';

    const pros = [], cons = [], bridge = [];
    if (r.titleHits > 0)             pros.push(`Title matches ${r.titleHits}/${terms.length} query terms`);
    if (d?.schema.hasFaq)            pros.push('Has FAQ schema');
    if (d?.wc >= 600)                pros.push(`${d.wc.toLocaleString()} words of content`);
    if (d && d.h.h2 + d.h.h3 >= 3)  pros.push('Well-structured headings');
    if (d?.meta.good)                pros.push('Clear meta description');
    if (seoData && seoData.bestPos <= 10) pros.push(`Ranking on page 1 (#${Math.round(seoData.bestPos)})`);

    if (!d || d.wc < 600)                cons.push('Thin content (<600 words)');
    if (!d?.schema.hasFaq)               cons.push('No FAQ schema');
    if (!d || d.h.h2 + d.h.h3 < 2)      cons.push('Weak heading structure');
    if (!d?.meta.good)                   cons.push('Meta description missing or weak');
    if (seoData && seoData.bestPos > 20) cons.push(`Low SEO rank (#${Math.round(seoData.bestPos)})`);

    // Bridge: improvements that help both SEO and GEO simultaneously
    if (!d?.schema.hasFaq && (d?.wc || 0) >= 300)
      bridge.push('Add FAQPage schema — boosts both People Also Ask and AI citations');
    if (!d?.meta.good)
      bridge.push('Write a 130-char meta desc — improves CTR and gives AI a summary anchor');
    if (!d || d.h.h2 + d.h.h3 < 3)
      bridge.push('Add H2/H3 section headers — helps ranking structure and AI extractability');

    return `
      <div class="geo-sim-card${i === 0 ? ' geo-sim-top' : ''}">
        <div class="geo-sim-hd">
          <span class="geo-sim-rank">${i === 0 ? '🥇 Best match' : '#' + (i + 1)}</span>
          <div class="geo-sim-scores">
            <span class="geo-sim-fit" style="background:${fColor}18;color:${fColor};border:1px solid ${fColor}44">${r.fitScore}% AI Fit</span>
            <span class="geo-tier-badge ${tier.cls}">${r.gs.score} · ${tier.label}</span>
          </div>
        </div>
        <div class="geo-sim-url"><a href="${esc(r.page.url)}" target="_blank" rel="noopener">${esc(path)}</a></div>
        ${d?.title ? `<div class="geo-sim-title">"${esc(d.title)}"</div>` : ''}
        ${seoHtml}
        <div class="geo-sim-body">
          ${pros.length ? `<div class="geo-sim-row"><span class="geo-sim-pos-lbl">Strengths:</span>${pros.map(p => `<span class="geo-tag-pos">${esc(p)}</span>`).join('')}</div>` : ''}
          ${cons.length ? `<div class="geo-sim-row" style="margin-top:5px"><span class="geo-sim-neg-lbl">Gaps:</span>${cons.map(c => `<span class="geo-tag-neg">${esc(c)}</span>`).join('')}</div>` : ''}
          ${bridge.length ? `<div class="geo-sim-row geo-sim-bridge"><span class="geo-sim-bridge-lbl">Bridge actions (help SEO &amp; GEO):</span><ul>${bridge.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
        </div>
      </div>`;
  }).join('');

  resEl.innerHTML = `
    <div class="geo-sim-label">
      Top ${results.length} result${results.length > 1 ? 's' : ''} for <strong>"${esc(input)}"</strong>
      <span class="geo-intent-tag" style="background:${intentColor}18;color:${intentColor};border:1px solid ${intentColor}44">${intentOfQuery} intent</span>
    </div>
    <div class="geo-sim-cards">${cards}</div>`;
}

// ── AI Answer Fit Analysis ────────────────────────────────────────────────────

function renderGeoAnswerFit(scored) {
  const el = document.getElementById('geo-section-answerfit');
  if (!el) return;
  const valid = scored.filter(s => !s.gs.error);
  if (!valid.length) { el.innerHTML = ''; return; }

  const groups = [
    { label: 'Missing Schema Markup',    icon: '{}', priority: 'high',
      desc: 'AI systems use schema to verify business facts. Without it, pages are harder to cite accurately.',
      test: ({ gs }) => gs.details && !gs.details.schema.types.length },
    { label: 'No FAQ Schema',            icon: '❓', priority: 'high',
      desc: 'FAQPage schema directly powers AI Q&A responses. These pages cannot appear as structured answers.',
      test: ({ gs }) => gs.details && !gs.details.schema.hasFaq },
    { label: 'Thin Content (<600 words)',icon: '📄', priority: 'high',
      desc: 'AI needs substantive content to extract answers. Pages under 600 words are rarely cited.',
      test: ({ gs }) => gs.details && gs.details.wc < 600 },
    { label: 'Weak Heading Structure',   icon: '📑', priority: 'medium',
      desc: 'Fewer than 2 H2/H3 headings — AI cannot map sections to specific questions.',
      test: ({ gs }) => gs.details && (gs.details.h.h2 + gs.details.h.h3) < 2 },
    { label: 'Missing Meta Description', icon: '📋', priority: 'medium',
      desc: 'No meta description means AI has no built-in summary to use before reading the full page.',
      test: ({ gs }) => gs.details && !gs.details.meta.exists },
    { label: 'No Clear Answer Block',    icon: '💬', priority: 'medium',
      desc: 'Short page + no structure = no direct-answer paragraph. AI systems look for these first.',
      test: ({ gs }) => gs.details && gs.details.wc < 400 && (gs.details.h.h2 + gs.details.h.h3) < 2 },
  ];

  const total = valid.length;
  const rows = groups.map(g => {
    const affected = valid.filter(g.test);
    if (!affected.length) return '';
    const pct    = Math.round((affected.length / total) * 100);
    const pCls   = g.priority === 'high' ? 'impact-high' : 'impact-medium';
    const sample = affected.slice(0, 3).map(({ page }) =>
      `<a href="${esc(page.url)}" target="_blank" rel="noopener" class="geo-af-page" title="${esc(page.url)}">${esc((page.path || '/').length > 28 ? page.path.slice(0, 26) + '…' : (page.path || '/'))}</a>`
    ).join('');
    const more = affected.length > 3 ? `<span class="geo-af-more">+${affected.length - 3} more</span>` : '';
    return `<tr>
      <td><span class="geo-af-icon">${esc(g.icon)}</span> <strong>${esc(g.label)}</strong>
        <div class="geo-af-desc">${esc(g.desc)}</div>
      </td>
      <td><span class="opp-badge ${pCls}">${g.priority}</span></td>
      <td class="col-r"><strong>${affected.length}</strong>/${total} <span class="geo-af-pct">(${pct}%)</span></td>
      <td class="geo-af-pages-cell">${sample}${more}</td>
    </tr>`;
  }).filter(Boolean).join('');

  if (!rows) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="geo-section">
      <div class="geo-section-hd">
        <h2 class="geo-section-title">AI Answer Fit Analysis</h2>
        <p class="geo-section-desc">Structural gaps preventing your pages from being used as AI answer sources — across all ${total} crawled pages.</p>
      </div>
      <div class="geo-table-wrap">
        <table class="geo-table">
          <thead><tr><th>Gap Type</th><th>Priority</th><th class="col-r">Pages Affected</th><th>Examples</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── AI Opportunities ──────────────────────────────────────────────────────────

function renderGeoOpps(scored) {
  const el = document.getElementById('geo-section-opps');
  if (!el) return;
  const valid = scored.filter(s => !s.gs.error && !s.gs.noindex);
  if (!valid.length) { el.innerHTML = ''; return; }

  const opps = [];
  valid.forEach(({ page, gs }) => {
    const d = gs.details;
    if (!d) return;
    const totalH = d.h.h2 + d.h.h3;

    if (!d.schema.types.length)
      opps.push({ pri: 'high', effort: 'Low', type: 'schema', page,
        title: 'Add schema markup',
        action: 'Add at minimum an Organization or Service JSON-LD block. AI systems use structured data to verify facts before citing a page. Use Schema.org/Organization as a starting point.' });

    if (d.schema.types.length && !d.schema.hasFaq)
      opps.push({ pri: 'high', effort: 'Low', type: 'faq-schema', page,
        title: 'Add FAQPage schema',
        action: 'Wrap your FAQ section with FAQPage JSON-LD. This directly powers AI Q&A responses and Google People Also Ask boxes — one of the highest-ROI GEO improvements available.' });

    if (d.wc < 300)
      opps.push({ pri: 'high', effort: 'High', type: 'content', page,
        title: 'Expand very thin content',
        action: `Only ${d.wc} words. Add: (1) a 2-sentence definition paragraph answering "What is [service]?", (2) 3-5 FAQs, (3) a clear value proposition. AI needs at least 500 words to extract a meaningful answer.` });
    else if (d.wc < 600)
      opps.push({ pri: 'medium', effort: 'Medium', type: 'content', page,
        title: 'Expand content for AI summarization',
        action: `${d.wc} words is borderline. Expand service descriptions, add real client examples, or add a FAQ block to reach 600+ words.` });

    if (totalH < 2)
      opps.push({ pri: 'medium', effort: 'Low', type: 'structure', page,
        title: 'Add heading structure',
        action: `Only ${totalH} H2/H3 headings. Break your content into labelled sections using descriptive H2s like "Why Choose Us", "How It Works", "FAQs". AI uses headings as anchors to find specific answers.` });

    if (!d.schema.hasFaq && d.wc >= 300)
      opps.push({ pri: 'medium', effort: 'Medium', type: 'faq-content', page,
        title: 'Add a FAQ section',
        action: 'Create a "Frequently Asked Questions" block answering: "What does [service] cost?", "How long does it take?", "Why choose you over competitors?". AI systems heavily favour direct Q&A format.' });

    if (!d.meta.exists)
      opps.push({ pri: 'medium', effort: 'Low', type: 'meta', page,
        title: 'Write a clear meta description',
        action: 'Add a 120-160 character meta description summarising the page purpose and key benefit. AI uses this as a primary summary signal before reading the full content.' });

    if (d.wc >= 600 && !d.schema.hasFaq && totalH >= 3)
      opps.push({ pri: 'medium', effort: 'Low', type: 'definition', page,
        title: 'Add a direct-answer definition block',
        action: 'Add a concise 2-3 sentence paragraph near the top of the page that directly answers "What is [X]?" or "What does [company] do?". AI systems strongly prefer pages that lead with a clear, scannable answer.' });
  });

  const seen = new Set();
  const deduped = opps.filter(o => {
    const k = `${o.type}|${o.page.url}`;
    return seen.has(k) ? false : (seen.add(k), true);
  }).sort((a, b) => {
    const ord = { high: 0, medium: 1, low: 2 };
    return (ord[a.pri] - ord[b.pri]) || a.page.path.localeCompare(b.page.path);
  }).slice(0, 30);

  if (!deduped.length) {
    el.innerHTML = `<div class="geo-section"><div class="geo-section-hd"><h2 class="geo-section-title">AI Opportunities</h2></div><div class="opp-empty-section" style="padding:20px">No GEO opportunities found — your pages are well-optimised for AI visibility.</div></div>`;
    return;
  }

  const effortCls = e => ({ Low: 'geo-effort-low', Medium: 'geo-effort-med', High: 'geo-effort-high' }[e] || '');
  const cards = deduped.map(o => {
    const impCls = o.pri === 'high' ? 'impact-high' : 'impact-medium';
    const path   = (o.page.path || '/').length > 50 ? o.page.path.slice(0, 48) + '…' : (o.page.path || '/');
    return `
      <div class="geo-opp-card">
        <div class="geo-opp-top">
          <span class="opp-badge ${impCls}">${o.pri === 'high' ? 'High' : 'Med.'} Priority</span>
          <span class="geo-effort-badge ${effortCls(o.effort)}">${o.effort} Effort</span>
          <a href="${esc(o.page.url)}" target="_blank" rel="noopener" class="geo-opp-page">${esc(path)}</a>
        </div>
        <div class="geo-opp-title">${esc(o.title)}</div>
        <div class="geo-opp-action">${esc(o.action)}</div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="geo-section">
      <div class="geo-section-hd">
        <h2 class="geo-section-title">AI Opportunities</h2>
        <p class="geo-section-desc">Specific, actionable improvements ranked by priority. Each one increases how often AI systems cite your pages as answer sources.</p>
      </div>
      <div class="geo-opps-grid">${cards}</div>
    </div>`;
}

// ── Page GSC map builder ──────────────────────────────────────────────────────

function buildPageGscMap(rows, dims) {
  const pgIdx = dims.indexOf('page');
  if (pgIdx === -1) return new Map();
  const map = new Map();
  rows.forEach(row => {
    const pg = row.keys?.[pgIdx];
    if (!pg) return;
    const e = map.get(pg) || { clicks: 0, impressions: 0, posSum: 0, count: 0, bestPos: Infinity };
    e.clicks      += row.clicks || 0;
    e.impressions += row.impressions || 0;
    e.posSum      += row.position || 0;
    e.count++;
    e.bestPos = Math.min(e.bestPos, row.position || Infinity);
    map.set(pg, e);
  });
  map.forEach(v => {
    v.avgPos = v.count > 0 ? v.posSum / v.count : null;
    v.ctr    = v.impressions > 0 ? v.clicks / v.impressions : 0;
  });
  return map;
}

// ── Unified SEO + GEO Insights ────────────────────────────────────────────────

function renderUnifiedInsights(scored) {
  const el = document.getElementById('geo-section-unified');
  if (!el) return;

  if (!gscRows.length || !gscDims.includes('page')) {
    el.innerHTML = '';
    return;
  }

  const pgMap = buildPageGscMap(gscRows, gscDims);
  if (!pgMap.size) { el.innerHTML = ''; return; }

  const rows = scored
    .filter(s => !s.gs.error && pgMap.has(s.page.url))
    .map(s => {
      const seo = pgMap.get(s.page.url);
      const geo = s.gs.score;
      const seoScore = seo.bestPos !== Infinity
        ? Math.round(Math.max(0, 100 - (seo.bestPos - 1) * 5))
        : 0;
      return { page: s.page, gs: s.gs, seo, geo, seoScore };
    })
    .sort((a, b) => {
      // Sort by "decision urgency": best SEO / worst GEO first, then worst of both
      const aGap = a.seoScore - a.geo;
      const bGap = b.seoScore - b.geo;
      return bGap - aGap;
    })
    .slice(0, 15);

  if (!rows.length) { el.innerHTML = ''; return; }

  const verdict = (seoScore, geo) => {
    const goodSeo = seoScore >= 50;
    const goodGeo = geo >= 60;
    if (goodSeo && goodGeo)   return { label: 'Strong',            cls: 'uni-v-strong', action: 'Optimize CTR and add FAQPage schema to dominate both rankings and AI citations.' };
    if (goodSeo && !goodGeo)  return { label: 'GEO Gap',           cls: 'uni-v-geo',    action: 'Ranking well but AI systems won\'t cite this page. Add schema, expand content to 600+ words, and add a FAQ block.' };
    if (!goodSeo && goodGeo)  return { label: 'SEO Underranking',  cls: 'uni-v-seo',    action: 'Content is AI-ready but not ranking. Focus on link building, E-E-A-T signals, and internal linking to this page.' };
    return                           { label: 'Needs Both',         cls: 'uni-v-both',   action: 'Rebuild with a clear structure (H2/H3), 600+ words, schema markup, and then pursue links to rank and be cited.' };
  };

  const geoColor = g => g >= 80 ? '#16a34a' : g >= 60 ? '#2563eb' : g >= 40 ? '#d97706' : '#dc2626';
  const posLabel = p => p !== Infinity ? `#${Math.round(p)}` : '–';

  const tableRows = rows.map(r => {
    const v    = verdict(r.seoScore, r.geo);
    const tier = geoTier(r.geo);
    const path = (r.page.path || '/').length > 40 ? r.page.path.slice(0, 38) + '…' : (r.page.path || '/');
    return `<tr>
      <td class="uni-page-cell"><a href="${esc(r.page.url)}" target="_blank" rel="noopener" title="${esc(r.page.url)}">${esc(path)}</a></td>
      <td class="uni-center">
        <span class="uni-pos">${posLabel(r.seo.bestPos)}</span>
        <div class="uni-sub">${r.seo.impressions.toLocaleString()} impr · ${(r.seo.ctr * 100).toFixed(1)}% CTR</div>
      </td>
      <td class="uni-center">
        <span class="geo-score-num" style="color:${geoColor(r.geo)}">${r.geo}</span>
        <span class="geo-tier-badge ${tier.cls}" style="display:inline-block;margin-left:4px">${tier.label}</span>
      </td>
      <td><span class="uni-verdict ${v.cls}">${v.label}</span></td>
      <td class="uni-action-cell">${esc(v.action)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="geo-section">
      <div class="geo-section-hd">
        <h2 class="geo-section-title">SEO + GEO Combined View</h2>
        <p class="geo-section-desc">Pages where you have Search Console data, ranked by the gap between SEO performance and GEO readiness. Fix "GEO Gap" pages first — they already rank but won't be cited by AI.</p>
      </div>
      <div class="geo-table-wrap">
        <table class="geo-table uni-table">
          <thead><tr>
            <th>Page</th>
            <th class="uni-center">SEO (Best Position)</th>
            <th class="uni-center">GEO Score</th>
            <th>Verdict</th>
            <th>Recommended Action</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Main refresh ──────────────────────────────────────────────────────────────

function refreshGeo() {
  const noDataEl  = document.getElementById('geo-no-data');
  const contentEl = document.getElementById('geo-content');
  if (!noDataEl || !contentEl) return;

  const validPages = (allPages || []).filter(p => !p.fetchError && p.checks?.length > 0);

  if (!validPages.length) {
    noDataEl.innerHTML = `
      <div class="opp-connect-prompt">
        <div class="opp-connect-icon">🤖</div>
        <h3>Run a Technical Audit first</h3>
        <p>Go to <strong>Technical Audit</strong>, enter your domain, and crawl your site. GEO analysis reads content signals from the crawl results.</p>
        <p class="opp-connect-tip">Tip: load <strong>Search Performance</strong> data too — the Prompt Simulation uses GSC keywords for better query matching.</p>
      </div>`;
    noDataEl.style.display  = '';
    contentEl.style.display = 'none';
    return;
  }

  noDataEl.style.display  = 'none';
  contentEl.style.display = '';

  const scored = validPages.map(page => ({ page, gs: calcGeoScore(page) }));
  renderGeoSummary(scored);
  renderUnifiedInsights(scored);
  renderGeoReadiness(scored);
  renderGeoPrompt();
  renderGeoAnswerFit(scored);
  renderGeoOpps(scored);
}

document.getElementById('geo-refresh-btn')?.addEventListener('click', refreshGeo);

// ═════════════════════════════════════════════════════════════════════════════
// DEMO / LEAD MODE
// ═════════════════════════════════════════════════════════════════════════════

// ── Scoring helpers ───────────────────────────────────────────────────────────

function calcSeoHealthScore() {
  const pages = allPages.filter(p => !p.fetchError && p.checks?.length);
  if (!pages.length) return { score: 0, pass: 0, fail: 0, warn: 0, total: 0, pages: 0 };
  const checks = pages.flatMap(p => p.checks);
  const pass  = checks.filter(c => c.status === 'pass').length;
  const fail  = checks.filter(c => c.status === 'fail').length;
  const warn  = checks.filter(c => c.status === 'warn').length;
  const total = checks.length;
  const score = Math.max(0, Math.min(100, Math.round(100 - ((fail * 3 + warn * 1) / total) * 100)));
  return { score, pass, fail, warn, total, pages: pages.length };
}

function getDemoGeoScore() {
  const valid = allPages.filter(p => !p.fetchError && !p.httpError && p.checks?.length);
  if (!valid.length) return { score: 0, pages: 0 };
  const scores = valid.map(p => calcGeoScore(p).score);
  return { score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), pages: valid.length };
}

function getTopSeoIssues() {
  const map = new Map();
  allPages.forEach(page => {
    (page.checks || []).forEach(c => {
      if (c.status !== 'fail' && c.status !== 'warn') return;
      const e = map.get(c.check) || { name: c.check, count: 0, status: 'warn', example: c.message };
      e.count++;
      if (c.status === 'fail') e.status = 'fail';
      map.set(c.check, e);
    });
  });
  return [...map.values()]
    .sort((a, b) => (b.status === 'fail' ? 1 : 0) - (a.status === 'fail' ? 1 : 0) || b.count - a.count)
    .slice(0, 6);
}

function getDemoActions(issues, geoScore) {
  const pageCount = allPages.filter(p => p.checks?.length).length || 1;
  const actions = [];
  const seen    = new Set();
  const add     = (title, detail, effort, impact, hours) => {
    if (!seen.has(title)) { seen.add(title); actions.push({ title, detail, effort, impact, hours }); }
  };

  issues.forEach(issue => {
    const pct = Math.round((issue.count / pageCount) * 100);
    const n   = issue.name.toLowerCase();
    if (n.includes('meta') || n.includes('description'))
      add('Rewrite Meta Descriptions', `${pct}% of pages are missing or have weak meta descriptions — directly reducing click-through rate and preventing AI systems from generating accurate summaries.`, 'Low', 'High', '4–8 hrs');
    if (n.includes('title'))
      add('Fix Page Titles', `${pct}% of pages have title issues. Keyword-targeted, unique titles are the single highest-leverage on-page change for search visibility.`, 'Low', 'High', '3–6 hrs');
    if (n.includes('heading') || n.includes('h1') || n.includes('h2'))
      add('Add Heading Structure', `${pct}% of pages lack proper H1/H2 structure. Clear headings let both search engines and AI extract structured, citable answers.`, 'Low', 'Medium', '4–8 hrs');
    if (n.includes('schema') || n.includes('structured'))
      add('Add Schema Markup', `${pct}% of pages have no structured data — the machine-readable format AI systems use to verify and cite facts. Without it, your content is invisible to AI answers.`, 'Medium', 'High', '8–16 hrs');
    if (n.includes('word') || n.includes('content') || n.includes('thin'))
      add('Expand Thin Content', `${pct}% of pages have insufficient content. AI needs 600+ words per page to extract a meaningful answer. Thin pages also rank lower.`, 'High', 'High', '20–40 hrs');
    if (n.includes('link') || n.includes('internal'))
      add('Improve Internal Linking', `${pct}% of pages have internal link issues. A strong link structure distributes authority and helps AI understand your site's expertise hierarchy.`, 'Low', 'Medium', '4–8 hrs');
    if (n.includes('canonical') || n.includes('index') || n.includes('noindex'))
      add('Fix Indexability Issues', `${pct}% of pages have canonical or indexing errors that actively prevent them from appearing in search results or AI answers.`, 'Medium', 'High', '6–12 hrs');
    if (n.includes('image') || n.includes('alt'))
      add('Add Image Alt Text', `${pct}% of pages have images without descriptive alt text — limiting accessibility, image search visibility, and AI comprehension.`, 'Low', 'Medium', '3–5 hrs');
  });

  if (geoScore < 50)
    add('Add FAQPage Schema', 'FAQPage JSON-LD is one of the highest-ROI GEO changes available — it directly enables AI Q&A responses and Google People Also Ask boxes.', 'Low', 'High', '4–8 hrs');
  if (geoScore < 40)
    add('Add Direct-Answer Lead Paragraphs', 'AI systems strongly favour pages that answer "What is X?" within the first 100 words. Adding a concise opening definition to service pages takes minutes per page.', 'Low', 'High', '2–4 hrs');

  return actions.slice(0, 7);
}

// ── GEO insight for teaser ────────────────────────────────────────────────────

function getGeoInsight(geoData) {
  const pageCount = allPages.filter(p => p.checks?.length).length || 1;
  const noSchema  = allPages.filter(p =>
    (p.checks || []).some(c => (c.check || '').toLowerCase().includes('schema') && c.status === 'fail')
  ).length;
  const noMeta = allPages.filter(p =>
    (p.checks || []).some(c => (c.check || '').toLowerCase().includes('meta') && c.status === 'fail')
  ).length;

  if (geoData.score < 35)
    return { icon: '🚨', text: `GEO score of ${geoData.score}/100 — your pages are effectively invisible to ChatGPT, Perplexity, and Google AI Overviews. Competitors with better-structured content are capturing this traffic instead.`, urgency: 'critical' };
  if (noSchema > pageCount * 0.6)
    return { icon: '🤖', text: `${noSchema} of ${pageCount} pages have no schema markup — the format AI systems use to extract and verify facts. Without it, your content won't appear in AI-generated answers, even when you rank on page 1.`, urgency: 'high' };
  if (noMeta > pageCount * 0.5)
    return { icon: '📝', text: `Over half your pages are missing meta descriptions. AI systems use these as primary summary signals before reading your full content — fixing this is a 30-minute, high-impact improvement.`, urgency: 'medium' };
  if (geoData.score < 55)
    return { icon: '📈', text: `GEO score of ${geoData.score}/100 — you're partially ready for AI visibility, but missing key signals. Adding FAQ schema and improving heading structure could push you into the "Good" tier quickly.`, urgency: 'medium' };
  return { icon: '✅', text: `GEO score of ${geoData.score}/100 is above average. A few schema and content improvements would move you into the AI-Ready tier and increase citation frequency significantly.`, urgency: 'low' };
}

// ── Value teaser renderer ─────────────────────────────────────────────────────

function renderDemoTeaser(actions, geoData) {
  const el = document.getElementById('demo-teaser');
  if (!el) return;

  const insight = getGeoInsight(geoData);
  const highActions = actions.filter(a => a.impact === 'High').slice(0, 3);
  if (!highActions.length) { el.style.display = 'none'; return; }

  const urgCls = { critical: 'geo-ins-critical', high: 'geo-ins-high', medium: 'geo-ins-medium', low: 'geo-ins-low' }[insight.urgency] || '';

  const previews = highActions.map((a, i) => {
    const fade = i === 2 ? ' demo-ap-fade' : '';
    return `
      <div class="demo-action-preview${fade}">
        <div class="demo-ap-num">${i + 1}</div>
        <div class="demo-ap-body">
          <div class="demo-ap-title">${esc(a.title)}</div>
          <div class="demo-ap-meta">
            <span class="demo-ap-tag demo-ap-tag-high">High Impact</span>
            <span class="demo-ap-tag demo-ap-tag-effort">${esc(a.effort)} Effort</span>
            <span class="demo-ap-tag demo-ap-tag-hrs">~${esc(a.hours)}</span>
          </div>
        </div>
        ${i < 2 ? '<div class="demo-ap-lock">Full detail in report →</div>' : '<div class="demo-ap-lock">+ more in full report →</div>'}
      </div>`;
  }).join('');

  el.style.display = '';
  el.innerHTML = `
    <div class="demo-teaser-card">
      <div class="demo-geo-insight ${urgCls}">
        <span class="demo-gi-icon">${insight.icon}</span>
        <div>
          <div class="demo-gi-label">AI Visibility Insight</div>
          <div class="demo-gi-text">${esc(insight.text)}</div>
        </div>
      </div>
      <div class="demo-teaser-actions-hd">
        <span class="demo-teaser-title">Top actions identified</span>
        <span class="demo-teaser-more">${actions.length} total actions in full report</span>
      </div>
      <div class="demo-action-previews">${previews}</div>
    </div>`;
}

// ── Client explanation generator ──────────────────────────────────────────────

const CLIENT_EXPLANATIONS = {
  'page title':         { plain: 'Page Titles', explain: 'The title of a webpage is the blue link text shown in Google search results. When titles are missing, duplicated, or poorly written, Google struggles to understand what the page is about — and visitors are less likely to click. Fixing titles is one of the quickest and most impactful improvements we can make.' },
  'meta description':   { plain: 'Meta Descriptions', explain: 'The grey text that appears below the blue link in Google results is called the meta description. When it\'s missing, Google automatically pulls random text from the page — which often isn\'t compelling. Writing clear, benefit-focused descriptions for each page directly increases how many people click through to the site.' },
  'heading':            { plain: 'Heading Structure', explain: 'Headings (H1, H2, H3) are like chapter titles in a book — they tell search engines and AI systems what each section of a page is about. Without clear headings, pages look like unstructured walls of text to machines, making them harder to rank and less likely to be cited by AI assistants.' },
  'schema':             { plain: 'Schema / Structured Data', explain: 'Schema markup is a special code layer that helps machines understand your content in a structured way. Think of it as a translation layer between your website and AI systems. Without it, ChatGPT, Perplexity, and Google\'s AI Overviews cannot reliably extract facts from your pages — even if you rank on page 1.' },
  'word count':         { plain: 'Content Depth', explain: 'Pages with less than 600 words are considered "thin" by search engines and AI systems. Thin content doesn\'t give enough information to rank well for competitive terms or to be cited as an authoritative answer. We need to expand key pages with useful, well-structured content.' },
  'internal link':      { plain: 'Internal Linking', explain: 'Internal links are links from one page on your website to another. They help search engines discover and understand the relationship between pages, and they pass ranking authority from strong pages to weaker ones. A weak internal link structure is like a poorly organised filing system — it hides your best content.' },
  'canonical':          { plain: 'Duplicate Page Issues', explain: 'Canonical issues mean the same content is accessible at multiple URLs, which confuses search engines about which version to rank. This can split your ranking signals and dilute your visibility. It\'s a technical fix that\'s usually quick once identified.' },
  'image':              { plain: 'Image Alt Text', explain: 'Alt text is a short description added to images that helps both screen readers (for accessibility) and search engines understand what an image shows. Missing alt text means you\'re missing image search traffic and reducing the page\'s overall quality signal.' },
  'noindex':            { plain: 'Indexing Issues', explain: 'Some pages have a noindex tag, which tells Google not to include them in search results. While sometimes intentional, this is often accidental — meaning valuable pages are completely invisible to search engines and cannot rank or be cited by AI.' },
  'faq':                { plain: 'FAQ Schema', explain: 'FAQ schema tells AI systems that a section of your page is structured as questions and answers. This is one of the most valuable GEO signals — it directly enables your content to appear in Google\'s People Also Ask boxes and in AI assistant responses.' },
};

function generateClientExplanations(issues, seoData, geoData) {
  const domain = (() => { try { return new URL(startUrl).hostname; } catch { return 'this website'; } })();
  const found  = [];

  issues.forEach(issue => {
    const n = issue.name.toLowerCase();
    for (const [key, val] of Object.entries(CLIENT_EXPLANATIONS)) {
      if (n.includes(key) && !found.find(f => f.plain === val.plain)) {
        found.push({ ...val, count: issue.count, status: issue.status });
      }
    }
  });

  // Always include GEO explanation
  const geoTierWord = geoData.score >= 70 ? 'above average' : geoData.score >= 50 ? 'moderate' : 'low';

  let html = `
    <div class="demo-explain-intro">
      <strong>How to explain these findings to your client</strong><br>
      Use plain language below — avoid technical jargon when presenting to <em>${esc(domain)}</em>.
    </div>
    <div class="demo-explain-scores">
      <div class="demo-es-item">
        <div class="demo-es-num" style="color:${scoreColor(seoData.score)}">${seoData.score}<span>/100</span></div>
        <div class="demo-es-lbl">SEO Health</div>
        <div class="demo-es-script">"Your site scores ${seoData.score} out of 100 for SEO health. ${seoData.score >= 70 ? 'It\'s performing reasonably well, but there are specific areas where improvement will directly increase traffic and leads.' : seoData.score >= 50 ? 'There are significant gaps that are actively limiting your search visibility and lead flow.' : 'There are critical issues preventing your site from ranking competitively — fixing these is the highest priority.'}"</div>
      </div>
      <div class="demo-es-item">
        <div class="demo-es-num" style="color:${scoreColor(geoData.score)}">${geoData.score}<span>/100</span></div>
        <div class="demo-es-lbl">AI Visibility</div>
        <div class="demo-es-script">"Your AI Readiness score is ${geoData.score}/100, which is ${geoTierWord}. ${geoData.score < 50 ? 'This means when your prospective clients ask ChatGPT or Google AI about services you offer, your website is unlikely to appear in the answer. Your competitors with better-structured sites are getting that visibility instead.' : 'There are targeted improvements that would increase how often AI assistants cite your content in answers.'}"</div>
      </div>
    </div>`;

  if (found.length) {
    html += `<div class="demo-explain-items">`;
    found.slice(0, 5).forEach(f => {
      html += `
        <div class="demo-explain-item">
          <div class="demo-explain-item-hd">
            <span class="demo-explain-pill ${f.status === 'fail' ? 'demo-ep-fail' : 'demo-ep-warn'}">${f.status === 'fail' ? 'Critical' : 'Warning'}</span>
            <strong>${esc(f.plain)}</strong>
            <span class="demo-explain-pages">${f.count} pages affected</span>
          </div>
          <div class="demo-explain-script">"${esc(f.explain)}"</div>
        </div>`;
    });
    html += `</div>`;
  }

  return html;
}

// ── Proposal generator ────────────────────────────────────────────────────────

function generateProposalDoc(email, company, seoData, geoData) {
  const issues  = getTopSeoIssues();
  const actions = getDemoActions(issues, geoData.score);
  const domain  = (() => { try { return new URL(startUrl).hostname; } catch { return startUrl; } })();
  const date    = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const client  = company || email || domain;

  const quickWins = actions.filter(a => a.effort === 'Low'   && a.impact === 'High');
  const strategic = actions.filter(a => a.effort === 'Medium' || (a.effort === 'High' && a.impact === 'High'));
  const geoItems  = actions.filter(a => a.title.toLowerCase().includes('schema') || a.title.toLowerCase().includes('faq') || a.title.toLowerCase().includes('answer'));

  const totalHrsLow  = quickWins.reduce((s, a) => s + parseInt(a.hours?.split('–')[0] || 4), 0);
  const totalHrsHigh = actions.reduce((s, a) => s + parseInt(a.hours?.split('–')[1] || 16), 0);

  const phaseRows = (items) => items.map(a => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-weight:600">${esc(a.title)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#475569">${esc(a.detail)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;white-space:nowrap"><span style="background:${a.impact==='High'?'#fee2e2':'#fef9c3'};color:${a.impact==='High'?'#b91c1c':'#b45309'};border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">${a.impact}</span></td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;color:#64748b;white-space:nowrap">${esc(a.hours || '—')}</td>
    </tr>`).join('');

  const assessment = seoData.score >= 70
    ? `${domain} has a solid SEO foundation (${seoData.score}/100) with targeted opportunities for improvement. GEO readiness is ${scoreTierLabel(geoData.score).toLowerCase()} (${geoData.score}/100), presenting a clear opportunity to capture AI-driven traffic before competitors do.`
    : seoData.score >= 50
    ? `${domain} has moderate SEO performance (${seoData.score}/100) with several issues actively limiting visibility and leads. GEO readiness is ${scoreTierLabel(geoData.score).toLowerCase()} (${geoData.score}/100) — both require attention to remain competitive as AI-powered search becomes dominant.`
    : `${domain} has critical SEO issues (${seoData.score}/100) that are preventing competitive search visibility. GEO readiness is ${scoreTierLabel(geoData.score).toLowerCase()} (${geoData.score}/100). Addressing these issues in a structured programme will deliver measurable traffic and lead improvements within 60–90 days.`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEO + GEO Improvement Scope — ${esc(domain)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;padding:40px 24px}
.wrap{max-width:800px;margin:0 auto}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;margin-bottom:24px}
h1{font-size:26px;font-weight:800;margin-bottom:6px}
h2{font-size:17px;font-weight:700;margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid #f1f5f9}
p{font-size:14px;line-height:1.6;color:#334155}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding:8px 12px;background:#f8fafc;border-bottom:2px solid #e2e8f0}
.scores{display:flex;gap:20px;margin-bottom:24px;flex-wrap:wrap}
.sc{flex:1;min-width:140px;text-align:center;padding:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px}
.sc-n{font-size:44px;font-weight:800;line-height:1}
.sc-l{font-size:13px;color:#64748b;margin-top:4px}
.phase-hd{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.phase-num{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0}
.p1{background:#dcfce7;color:#15803d}.p2{background:#dbeafe;color:#1d4ed8}.p3{background:#f3e8ff;color:#7c3aed}
.timeline{display:flex;gap:0;margin:20px 0;overflow:hidden;border-radius:8px}
.tl-phase{flex:1;padding:12px 16px;font-size:12px;font-weight:600}
.tl1{background:#dcfce7;color:#15803d}.tl2{background:#dbeafe;color:#1d4ed8}.tl3{background:#f3e8ff;color:#7c3aed}
.cta{background:linear-gradient(135deg,#1e293b,#0f172a);color:#fff;border-radius:12px;padding:32px;text-align:center;margin-top:24px}
.cta h2{color:#fff;border:none;margin-bottom:8px}
.cta p{color:#94a3b8;margin-bottom:20px}
.cta a{display:inline-block;background:#f97316;color:#fff;font-weight:700;padding:12px 28px;border-radius:8px;font-size:15px;text-decoration:none}
.footer{text-align:center;font-size:12px;color:#94a3b8;margin-top:32px}
</style></head><body>
<div class="wrap">
  <div class="card">
    <div style="font-size:11px;font-weight:700;color:#f97316;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">SEO + GEO Improvement Scope</div>
    <h1>${esc(domain)}</h1>
    <div style="color:#64748b;font-size:13px;margin-top:4px">Prepared for ${esc(client)} · ${date}</div>
    <div class="scores" style="margin-top:24px">
      <div class="sc"><div class="sc-n" style="color:${scoreColor(seoData.score)}">${seoData.score}</div><div class="sc-l">SEO Health · /100</div></div>
      <div class="sc"><div class="sc-n" style="color:${scoreColor(geoData.score)}">${geoData.score}</div><div class="sc-l">GEO Readiness · /100</div></div>
      <div class="sc"><div class="sc-n" style="color:#0891b2">${seoData.pages}</div><div class="sc-l">Pages Audited</div></div>
    </div>
    <h2>Executive Summary</h2>
    <p>${esc(assessment)}</p>
  </div>

  <div style="margin-bottom:8px;font-size:13px;font-weight:600;color:#64748b">Proposed Timeline</div>
  <div class="timeline">
    <div class="tl-phase tl1">Phase 1<br>Weeks 1–2<br>Quick Wins</div>
    <div class="tl-phase tl2">Phase 2<br>Weeks 3–5<br>Core SEO</div>
    <div class="tl-phase tl3">Phase 3<br>Weeks 5–8<br>AI Visibility</div>
  </div>

  ${quickWins.length ? `<div class="card">
    <div class="phase-hd"><div class="phase-num p1">1</div><h2 style="margin:0;border:none">Quick Wins — Weeks 1–2</h2></div>
    <p style="margin-bottom:16px">High-impact, low-effort changes that deliver measurable improvements within days of implementation.</p>
    <table><thead><tr><th>Action</th><th>Description</th><th>Impact</th><th>Est. Time</th></tr></thead>
    <tbody>${phaseRows(quickWins)}</tbody></table>
  </div>` : ''}

  ${strategic.length ? `<div class="card">
    <div class="phase-hd"><div class="phase-num p2">2</div><h2 style="margin:0;border:none">Core SEO Work — Weeks 3–5</h2></div>
    <p style="margin-bottom:16px">Deeper changes that build sustainable organic search performance and fix structural issues.</p>
    <table><thead><tr><th>Action</th><th>Description</th><th>Impact</th><th>Est. Time</th></tr></thead>
    <tbody>${phaseRows(strategic)}</tbody></table>
  </div>` : ''}

  ${geoItems.length ? `<div class="card">
    <div class="phase-hd"><div class="phase-num p3">3</div><h2 style="margin:0;border:none">AI Visibility (GEO) — Weeks 5–8</h2></div>
    <p style="margin-bottom:16px">Targeted improvements to ensure your content is cited by ChatGPT, Perplexity, and Google AI Overviews.</p>
    <table><thead><tr><th>Action</th><th>Description</th><th>Impact</th><th>Est. Time</th></tr></thead>
    <tbody>${phaseRows(geoItems)}</tbody></table>
  </div>` : ''}

  <div class="card">
    <h2>Investment Summary</h2>
    <table>
      <thead><tr><th>Phase</th><th>Scope</th><th>Est. Hours</th></tr></thead>
      <tbody>
        ${quickWins.length ? `<tr><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9">Phase 1 — Quick Wins</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9">${quickWins.length} action${quickWins.length>1?'s':''}</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9">${quickWins.reduce((s,a)=>s+parseInt(a.hours?.split('–')[0]||4),0)}–${quickWins.reduce((s,a)=>s+parseInt(a.hours?.split('–')[1]||8),0)} hrs</td></tr>` : ''}
        ${strategic.length ? `<tr><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9">Phase 2 — Core SEO</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9">${strategic.length} action${strategic.length>1?'s':''}</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9">${strategic.reduce((s,a)=>s+parseInt(a.hours?.split('–')[0]||8),0)}–${strategic.reduce((s,a)=>s+parseInt(a.hours?.split('–')[1]||16),0)} hrs</td></tr>` : ''}
        ${geoItems.length ? `<tr><td style="padding:10px 12px">Phase 3 — AI Visibility</td><td style="padding:10px 12px">${geoItems.length} action${geoItems.length>1?'s':''}</td><td style="padding:10px 12px">${geoItems.reduce((s,a)=>s+parseInt(a.hours?.split('–')[0]||4),0)}–${geoItems.reduce((s,a)=>s+parseInt(a.hours?.split('–')[1]||8),0)} hrs</td></tr>` : ''}
      </tbody>
    </table>
    <p style="margin-top:14px;font-size:12px;color:#94a3b8">Estimates based on ${seoData.pages} pages audited. Final scope will be confirmed after a detailed review call.</p>
  </div>

  <div class="cta">
    <h2>Next Step</h2>
    <p>Book a 30-minute strategy call to walk through this scope, answer questions, and confirm the engagement.</p>
    <a href="mailto:yeerhung.keok@elitez.asia?subject=SEO+GEO+Improvement+Scope+${encodeURIComponent(domain)}">Book Strategy Call →</a>
  </div>

  <div class="footer">Prepared by Elitez Group of Companies · ${date}</div>
</div></body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `seo-proposal-${domain}-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
}

// ── Lead management ───────────────────────────────────────────────────────────

function loadLeads() {
  try { return JSON.parse(localStorage.getItem(LEADS_KEY)) || []; } catch { return []; }
}

function saveLead(email, company, url, seoScore, geoScore) {
  const leads   = loadLeads();
  const existing = leads.findIndex(l => l.email === email && l.url === url);
  const lead    = {
    id: Date.now(), email: email.trim(), company: (company || '').trim(),
    url, seoScore, geoScore, capturedAt: new Date().toISOString(),
  };
  if (existing >= 0) leads[existing] = lead; else leads.unshift(lead);
  localStorage.setItem(LEADS_KEY, JSON.stringify(leads.slice(0, 500)));
}

function exportLeadsCSV() {
  const leads = loadLeads();
  if (!leads.length) { alert('No leads to export yet.'); return; }
  const q   = s => '"' + String(s || '').replace(/"/g, '""') + '"';
  const hdr = 'Email,Company,Website,SEO Score,GEO Score,Captured At\n';
  const rows = leads.map(l =>
    [q(l.email), q(l.company), q(l.url), l.seoScore, l.geoScore, q(l.capturedAt)].join(',')
  ).join('\n');
  const blob = new Blob([hdr + rows], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `seo-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function renderLeadsTable() {
  const leads = loadLeads();
  const badge = document.getElementById('demo-leads-badge');
  if (badge) badge.textContent = leads.length;

  const wrap = document.getElementById('demo-leads-table-wrap');
  if (!wrap) return;

  if (!leads.length) {
    wrap.innerHTML = '<p class="demo-leads-empty">No leads captured yet. Run an audit and collect emails to see them here.</p>';
    return;
  }

  const rows = leads.map(l => {
    let host = l.url;
    try { host = new URL(l.url).hostname; } catch {}
    return `<tr>
      <td>${esc(l.email)}</td>
      <td>${esc(l.company || '—')}</td>
      <td><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(host)}</a></td>
      <td class="demo-lt-center"><span class="demo-lt-score" style="color:${scoreColor(l.seoScore)}">${l.seoScore}</span></td>
      <td class="demo-lt-center"><span class="demo-lt-score" style="color:${scoreColor(l.geoScore)}">${l.geoScore}</span></td>
      <td class="demo-lt-center">${new Date(l.capturedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="demo-leads-table">
      <thead><tr>
        <th>Email</th><th>Company</th><th>Website</th>
        <th class="demo-lt-center">SEO</th><th class="demo-lt-center">GEO</th><th class="demo-lt-center">Date</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function scoreColor(s) {
  return s >= 80 ? '#16a34a' : s >= 60 ? '#2563eb' : s >= 40 ? '#d97706' : '#dc2626';
}

function scoreTierLabel(s) {
  return s >= 80 ? 'Excellent' : s >= 60 ? 'Good' : s >= 40 ? 'Needs Work' : 'Poor';
}

// ── Demo report export ────────────────────────────────────────────────────────

function exportDemoReport(email, company, seoData, geoData) {
  const issues  = getTopSeoIssues();
  const actions = getDemoActions(issues, geoData.score);
  const domain  = (() => { try { return new URL(startUrl).hostname; } catch { return startUrl; } })();
  const date    = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const seoClr  = scoreColor(seoData.score);
  const geoClr  = scoreColor(geoData.score);

  const issueRows = issues.map(i => `
    <tr>
      <td><span style="color:${i.status==='fail'?'#dc2626':'#d97706'}">${i.status==='fail'?'❌':'⚠'}</span> ${esc(i.name)}</td>
      <td style="text-align:right;color:#64748b">${i.count} page${i.count>1?'s':''}</td>
    </tr>`).join('');

  const actionRows = actions.map((a, idx) => `
    <div style="display:flex;gap:14px;padding:14px 0;border-bottom:1px solid #e2e8f0">
      <div style="width:28px;height:28px;border-radius:50%;background:${idx===0?'#dc2626':idx===1?'#d97706':'#2563eb'}18;color:${idx===0?'#dc2626':idx===1?'#d97706':'#2563eb'};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0">${idx+1}</div>
      <div>
        <div style="font-weight:700;color:#0f172a;margin-bottom:4px">${esc(a.title)}
          <span style="font-size:11px;font-weight:600;background:${a.impact==='High'?'#fee2e2':'#fef9c3'};color:${a.impact==='High'?'#b91c1c':'#b45309'};border-radius:4px;padding:1px 7px;margin-left:6px">${a.impact} Impact</span>
          <span style="font-size:11px;font-weight:600;background:#f0fdf4;color:#15803d;border-radius:4px;padding:1px 7px;margin-left:4px">${a.effort} Effort</span>
        </div>
        <div style="font-size:13px;color:#475569;line-height:1.5">${esc(a.detail)}</div>
      </div>
    </div>`).join('');

  const geoScored = allPages.filter(p => !p.fetchError && !p.httpError && p.checks?.length)
    .map(p => ({ path: p.path || '/', gs: calcGeoScore(p) }))
    .sort((a, b) => a.gs.score - b.gs.score)
    .slice(0, 8);
  const geoRows = geoScored.map(({ path, gs }) => {
    const tier = geoTier(gs.score);
    return `<tr>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(path)}</td>
      <td style="text-align:center;font-weight:700;color:${scoreColor(gs.score)}">${gs.score}</td>
      <td style="text-align:center"><span style="background:${scoreColor(gs.score)}18;color:${scoreColor(gs.score)};border-radius:4px;padding:1px 8px;font-size:11px;font-weight:700">${tier.label}</span></td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEO + GEO Audit — ${esc(domain)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;padding:32px 20px}
.wrap{max-width:760px;margin:0 auto}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px 32px;margin-bottom:20px}
h1{font-size:24px;font-weight:800}h2{font-size:17px;font-weight:700;margin-bottom:16px}
a{color:#2563eb;text-decoration:none}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid #e2e8f0;background:#f8fafc}
td{padding:9px 8px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
.scores{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:24px}
.sc{flex:1;min-width:150px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;text-align:center}
.sc-num{font-size:48px;font-weight:800;line-height:1}
.sc-lbl{font-size:13px;color:#64748b;margin-top:4px}
.sc-tier{font-size:12px;font-weight:700;margin-top:6px}
.cta{background:linear-gradient(135deg,#1e293b,#334155);color:#fff;border-radius:12px;padding:32px;text-align:center;margin-top:24px}
.cta h2{color:#fff;margin-bottom:8px}
.cta p{color:#cbd5e1;font-size:14px;margin-bottom:20px}
.cta a{display:inline-block;background:#f97316;color:#fff;font-weight:700;padding:12px 28px;border-radius:8px;font-size:15px}
.footer{text-align:center;font-size:12px;color:#94a3b8;margin-top:32px}
</style></head><body>
<div class="wrap">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:24px">
      <div>
        <div style="font-size:12px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">SEO + AI Visibility Audit</div>
        <h1>${esc(domain)}</h1>
        <div style="color:#64748b;font-size:13px;margin-top:4px">Generated ${date}${company ? ' · ' + esc(company) : ''}</div>
      </div>
      <div style="font-size:12px;color:#94a3b8;text-align:right">${seoData.pages} pages analysed<br>${email ? esc(email) : ''}</div>
    </div>
    <div class="scores">
      <div class="sc">
        <div class="sc-num" style="color:${seoClr}">${seoData.score}</div>
        <div class="sc-lbl">SEO Health Score</div>
        <div class="sc-tier" style="color:${seoClr}">${scoreTierLabel(seoData.score)}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px">${seoData.fail} fails · ${seoData.warn} warnings</div>
      </div>
      <div class="sc">
        <div class="sc-num" style="color:${geoClr}">${geoData.score}</div>
        <div class="sc-lbl">GEO Readiness Score</div>
        <div class="sc-tier" style="color:${geoClr}">${scoreTierLabel(geoData.score)}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px">AI citability · ${geoData.pages} pages</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Issues Breakdown</h2>
    <table><thead><tr><th>Issue</th><th style="text-align:right">Pages Affected</th></tr></thead>
    <tbody>${issueRows}</tbody></table>
  </div>

  <div class="card">
    <h2>GEO Readiness by Page</h2>
    <table><thead><tr><th>Page</th><th style="text-align:center">GEO Score</th><th style="text-align:center">Status</th></tr></thead>
    <tbody>${geoRows}</tbody></table>
  </div>

  <div class="card">
    <h2>Priority Action Plan</h2>
    <div>${actionRows}</div>
  </div>

  <div class="cta">
    <h2>Ready to Improve These Scores?</h2>
    <p>Our team can implement these improvements and track your progress month-over-month.</p>
    <a href="mailto:yeerhung.keok@elitez.asia">Get in Touch →</a>
  </div>

  <div class="footer">Generated by Elitez SEO + GEO Audit Tool · ${date}</div>
</div></body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `seo-geo-audit-${domain}-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
}

// ── Ring animation ────────────────────────────────────────────────────────────

function animateDemoRing(arcId, numId, score, color) {
  const arc = document.getElementById(arcId);
  const num = document.getElementById(numId);
  if (!arc || !num) return;
  const circ = 2 * Math.PI * 34; // ≈ 213.6
  arc.style.stroke      = color;
  arc.style.strokeLinecap = 'round';
  let current = 0;
  const step  = () => {
    current = Math.min(current + 2, score);
    arc.setAttribute('stroke-dasharray', `${(current / 100) * circ} ${circ}`);
    num.textContent = current;
    if (current < score) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── Phase management ──────────────────────────────────────────────────────────

function showDemoPhase(phase) {
  ['input', 'crawling', 'results'].forEach(p => {
    const el = document.getElementById(`demo-phase-${p}`);
    if (el) el.style.display = p === phase ? '' : 'none';
  });
}

// ── Issue list renderer (high-impact only by default) ─────────────────────────

let demoShowAllIssues = false;

function renderDemoIssueList(seoData) {
  const allIssues  = getTopSeoIssues();
  const failOnly   = allIssues.filter(i => i.status === 'fail');
  const warnOnly   = allIssues.filter(i => i.status === 'warn');
  const shown      = demoShowAllIssues ? allIssues : (failOnly.length ? failOnly : allIssues);

  const badge = document.getElementById('demo-issues-badge');
  if (badge) {
    badge.textContent = failOnly.length
      ? `${failOnly.length} critical${warnOnly.length ? ` + ${warnOnly.length} warnings` : ''}`
      : `${allIssues.length} issues`;
  }

  const list = document.getElementById('demo-issues-list');
  if (list) list.innerHTML = shown.map(issue => `
    <div class="demo-issue-row">
      <span class="demo-issue-icon ${issue.status === 'fail' ? 'demo-issue-fail' : 'demo-issue-warn'}">${issue.status === 'fail' ? '✕' : '!'}</span>
      <div class="demo-issue-body">
        <div class="demo-issue-name">${esc(issue.name)}</div>
        <div class="demo-issue-pages">${issue.count} page${issue.count > 1 ? 's' : ''} affected</div>
      </div>
      <div class="demo-issue-bar-wrap">
        <div class="demo-issue-bar" style="width:${Math.min(100, Math.round(issue.count / (seoData.pages || 1) * 100))}%;background:${issue.status === 'fail' ? '#fca5a5' : '#fde68a'}"></div>
      </div>
    </div>`).join('');

  const warnBtn = document.getElementById('demo-show-warns-btn');
  if (warnBtn && !demoShowAllIssues && warnOnly.length > 0 && failOnly.length > 0) {
    warnBtn.style.display = '';
    warnBtn.textContent   = `+ Show ${warnOnly.length} warning${warnOnly.length > 1 ? 's' : ''}`;
    warnBtn.onclick       = () => { demoShowAllIssues = true; renderDemoIssueList(seoData); warnBtn.style.display = 'none'; };
  } else if (warnBtn) {
    warnBtn.style.display = 'none';
  }
}

// ── Render results ────────────────────────────────────────────────────────────

function renderDemoResults() {
  demoShowAllIssues = false;
  const seoData = calcSeoHealthScore();
  const geoData = getDemoGeoScore();
  const actions = getDemoActions(getTopSeoIssues(), geoData.score);
  const seoClr  = scoreColor(seoData.score);
  const geoClr  = scoreColor(geoData.score);

  let domain = startUrl;
  try { domain = new URL(startUrl).hostname; } catch {}

  // Header
  const domEl = document.getElementById('demo-results-domain');
  if (domEl) domEl.textContent = domain;
  const gateEl = document.getElementById('demo-gate-domain');
  if (gateEl) gateEl.textContent = domain;

  // Score tiers
  const seoTierEl = document.getElementById('demo-seo-tier');
  if (seoTierEl) { seoTierEl.textContent = scoreTierLabel(seoData.score); seoTierEl.style.color = seoClr; }
  const geoTierEl = document.getElementById('demo-geo-tier');
  if (geoTierEl) { geoTierEl.textContent = scoreTierLabel(geoData.score); geoTierEl.style.color = geoClr; }

  // Score subs
  const seoSub = document.getElementById('demo-seo-sub');
  if (seoSub) seoSub.textContent = `${seoData.fail} critical · ${seoData.pages} pages`;
  const geoSub = document.getElementById('demo-geo-sub');
  if (geoSub) geoSub.textContent = `${geoData.pages} pages analysed`;

  // Issues (high-impact only)
  renderDemoIssueList(seoData);

  // Value teaser
  renderDemoTeaser(actions, geoData);

  // Consultant tools
  const ctEl = document.getElementById('demo-consultant-tools');
  if (ctEl) ctEl.style.display = '';

  showDemoPhase('results');

  // Animate rings
  setTimeout(() => {
    animateDemoRing('demo-seo-arc', 'demo-seo-num', seoData.score, seoClr);
    animateDemoRing('demo-geo-arc', 'demo-geo-num', geoData.score, geoClr);
  }, 150);
}

// ── Demo crawl ────────────────────────────────────────────────────────────────

function startDemoCrawl(rawUrl) {
  let url;
  try {
    url = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
    new URL(url); // validate
  } catch {
    alert('Please enter a valid website URL (e.g. https://example.com).');
    return;
  }

  allPages  = [];
  startUrl  = url;
  if (es) { es.close(); es = null; }

  let domain = url;
  try { domain = new URL(url).hostname; } catch {}

  showDemoPhase('crawling');
  const domEl = document.getElementById('demo-crawl-domain');
  if (domEl) domEl.textContent = domain;
  const statusEl = document.getElementById('demo-crawl-status');
  if (statusEl) statusEl.textContent = 'Reading sitemap…';
  const fill = document.getElementById('demo-progress-fill');
  const pct  = document.getElementById('demo-progress-pct');
  if (fill) fill.style.width = '0%';
  if (pct)  pct.textContent  = '0%';

  const DEMO_MAX = 10;
  const params   = new URLSearchParams({ url, maxPages: DEMO_MAX });
  es = new EventSource(`/api/crawl/stream?${params}`);

  es.addEventListener('progress', e => {
    const d     = JSON.parse(e.data);
    const done  = d.pagesProcessed || 0;
    const p     = Math.min(99, Math.round((done / DEMO_MAX) * 100));
    if (fill) fill.style.width = p + '%';
    if (pct)  pct.textContent  = p + '%';
    if (statusEl && d.phase === 'crawling')
      statusEl.textContent = `Checked ${done} of ${DEMO_MAX} pages…`;
  });

  es.addEventListener('page', e => {
    allPages.push(JSON.parse(e.data));
  });

  es.addEventListener('done', () => {
    if (fill) fill.style.width = '100%';
    if (pct)  pct.textContent  = '100%';
    es.close(); es = null;
    setTimeout(renderDemoResults, 400);
  });

  es.onerror = () => {
    es.close(); es = null;
    showDemoPhase('input');
    alert('Could not reach that URL. Please check the address and try again.');
  };
}

// ── Lead form submission ──────────────────────────────────────────────────────

function handleLeadSubmit(e) {
  e.preventDefault();
  const emailIn  = document.getElementById('demo-email-in');
  const companyIn = document.getElementById('demo-company-in');
  const errEl    = document.getElementById('demo-lead-error');
  const email    = (emailIn?.value || '').trim();
  const company  = (companyIn?.value || '').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (errEl) { errEl.textContent = 'Please enter a valid email address.'; errEl.style.display = ''; }
    emailIn?.focus();
    return;
  }
  if (errEl) errEl.style.display = 'none';

  const seoData = calcSeoHealthScore();
  const geoData = getDemoGeoScore();

  saveLead(email, company, startUrl, seoData.score, geoData.score);
  renderLeadsTable();
  exportDemoReport(email, company, seoData, geoData);

  // Show unlocked state, hide gate + teaser
  const gate    = document.getElementById('demo-gate');
  const teaser  = document.getElementById('demo-teaser');
  const unlocked = document.getElementById('demo-unlocked');
  if (gate)     gate.style.display    = 'none';
  if (teaser)   teaser.style.display  = 'none';
  if (unlocked) unlocked.style.display = '';

  // Wire up re-download and proposal buttons
  const reBtn = document.getElementById('demo-redownload-btn');
  if (reBtn) reBtn.onclick = () => exportDemoReport(email, company, seoData, geoData);

  const propBtn = document.getElementById('demo-proposal-btn');
  if (propBtn) propBtn.onclick = () => generateProposalDoc(email, company, seoData, geoData);
}

// ── Refresh / init ────────────────────────────────────────────────────────────

function refreshDemo() {
  renderLeadsTable();

  // If crawl data already exists, offer shortcut
  const existingWrap = document.getElementById('demo-use-existing');
  const existingUrl  = document.getElementById('demo-existing-url');
  if (existingWrap && existingUrl) {
    if (allPages.length > 0 && startUrl) {
      let host = startUrl;
      try { host = new URL(startUrl).hostname; } catch {}
      existingUrl.textContent    = host;
      existingWrap.style.display = '';
    } else {
      existingWrap.style.display = 'none';
    }
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

(function initDemoMode() {
  document.getElementById('demo-audit-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const val = (document.getElementById('demo-url-in')?.value || '').trim();
    if (val) startDemoCrawl(val);
  });

  document.getElementById('demo-use-existing-btn')?.addEventListener('click', () => {
    const gate     = document.getElementById('demo-gate');
    const unlocked = document.getElementById('demo-unlocked');
    const teaser   = document.getElementById('demo-teaser');
    if (gate)     gate.style.display     = '';
    if (unlocked) unlocked.style.display = 'none';
    if (teaser)   teaser.style.display   = 'none';
    renderDemoResults();
  });

  document.getElementById('demo-restart-btn')?.addEventListener('click', () => {
    const gate     = document.getElementById('demo-gate');
    const unlocked = document.getElementById('demo-unlocked');
    const teaser   = document.getElementById('demo-teaser');
    const ctTools  = document.getElementById('demo-consultant-tools');
    if (gate)     gate.style.display     = '';
    if (unlocked) unlocked.style.display = 'none';
    if (teaser)   teaser.style.display   = 'none';
    if (ctTools)  ctTools.style.display  = 'none';
    showDemoPhase('input');
    refreshDemo();
  });

  document.getElementById('demo-lead-form')?.addEventListener('submit', handleLeadSubmit);

  document.getElementById('demo-explain-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('demo-explain-panel');
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    const issues  = getTopSeoIssues();
    const seoData = calcSeoHealthScore();
    const geoData = getDemoGeoScore();
    panel.innerHTML     = generateClientExplanations(issues, seoData, geoData);
    panel.style.display = '';
  });

  document.getElementById('demo-proposal-standalone-btn')?.addEventListener('click', () => {
    const seoData = calcSeoHealthScore();
    const geoData = getDemoGeoScore();
    generateProposalDoc('', '', seoData, geoData);
  });

  document.getElementById('demo-leads-toggle')?.addEventListener('click', () => {
    const panel  = document.getElementById('demo-leads-panel');
    const chev   = document.querySelector('.demo-leads-chevron');
    if (!panel) return;
    const open = panel.style.display !== 'none';
    panel.style.display  = open ? 'none' : '';
    if (chev) chev.textContent = open ? '▾' : '▴';
    if (!open) renderLeadsTable();
  });

  document.getElementById('demo-leads-csv-btn')?.addEventListener('click', exportLeadsCSV);

  document.getElementById('demo-leads-clear-btn')?.addEventListener('click', () => {
    if (confirm('Delete all captured leads? This cannot be undone.')) {
      localStorage.removeItem(LEADS_KEY);
      renderLeadsTable();
    }
  });
})();


// ══════════════════════════════════════════════════════════════════════════════
// KEYWORD TRACKER MODULE
// ══════════════════════════════════════════════════════════════════════════════

const KW_KEY = 'seoKwTracker_v1';

const KW_COUNTRIES = {
  sg: 'Singapore', my: 'Malaysia', id: 'Indonesia', ph: 'Philippines',
  th: 'Thailand',  vn: 'Vietnam',  us: 'USA',       gb: 'UK',
  au: 'Australia', ca: 'Canada',
};

// ── Persistence ───────────────────────────────────────────────────────────────

function kwLoad() {
  try { return JSON.parse(localStorage.getItem(KW_KEY)) || []; } catch { return []; }
}

function kwSave(kws) {
  localStorage.setItem(KW_KEY, JSON.stringify(kws));
}

function kwAdd(data) {
  const kws = kwLoad();
  kws.unshift({ id: Date.now(), ...data, history: [] });
  kwSave(kws);
}

function kwUpdate(id, data) {
  const kws = kwLoad();
  const i   = kws.findIndex(k => k.id === id);
  if (i !== -1) kws[i] = { ...kws[i], ...data };
  kwSave(kws);
}

function kwDelete(id) {
  kwSave(kwLoad().filter(k => k.id !== id));
}

// ── GSC lookup ────────────────────────────────────────────────────────────────

function kwLookupGsc(keyword, country) {
  if (!gscRows.length || !gscDims.length) return { position: null, page: null };

  const qIdx  = gscDims.indexOf('query');
  const pgIdx = gscDims.indexOf('page');
  const cIdx  = gscDims.indexOf('country');

  if (qIdx === -1) return { position: null, page: null };

  const norm = keyword.trim().toLowerCase();
  const rows = gscRows.filter(r => {
    if ((r.keys?.[qIdx] || '').toLowerCase() !== norm) return false;
    if (country && cIdx !== -1) {
      if ((r.keys?.[cIdx] || '').toLowerCase() !== country.toLowerCase()) return false;
    }
    return true;
  });

  if (!rows.length) return { position: null, page: null };

  const bestRow = rows.reduce((best, r) =>
    (r.position || 999) < (best.position || 999) ? r : best, rows[0]);

  const position = Math.round(bestRow.position) || null;
  const page     = pgIdx !== -1 ? (bestRow.keys?.[pgIdx] || null) : null;

  return { position, page };
}

// ── Snapshot positions ────────────────────────────────────────────────────────

function kwSnapshotAll() {
  const kws   = kwLoad();
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0;

  kws.forEach(kw => {
    const { position, page } = kwLookupGsc(kw.keyword, kw.country);
    if (position === null) return;
    const last = kw.history[kw.history.length - 1];
    if (last && last.date === today) {
      last.position = position;
      last.page     = page;
    } else {
      kw.history.push({ date: today, position, page });
    }
    updated++;
  });

  kwSave(kws);
  return updated;
}

// ── GEO for page ──────────────────────────────────────────────────────────────

function kwGeoForPage(pageUrl) {
  if (!pageUrl || !allPages.length) return null;
  let path;
  try { path = new URL(pageUrl).pathname; } catch { path = pageUrl; }
  const page = allPages.find(p => {
    const pp = p.path || p.url || '';
    return pp === path || pp === pageUrl || (p.url && p.url.includes(path));
  });
  if (!page || !page.checks?.length) return null;
  return calcGeoScore(page);
}

// ── Trend ─────────────────────────────────────────────────────────────────────

function kwTrend(history) {
  if (history.length < 2) return { arrow: '\u2014', delta: 0, cls: 'kw-trend-flat' };
  const prev = history[history.length - 2].position;
  const curr = history[history.length - 1].position;
  if (!prev || !curr) return { arrow: '\u2014', delta: 0, cls: 'kw-trend-flat' };
  const delta = prev - curr;
  if (delta > 0)  return { arrow: '\u2191' + delta, delta, cls: 'kw-trend-up' };
  if (delta < 0)  return { arrow: '\u2193' + Math.abs(delta), delta, cls: 'kw-trend-down' };
  return { arrow: '\u2192', delta: 0, cls: 'kw-trend-flat' };
}

// ── Filter state ──────────────────────────────────────────────────────────────

let kwFilterCountry = '';
let kwFilterTag     = '';

// ── Render ────────────────────────────────────────────────────────────────────

function kwRender() {
  const allKws = kwLoad();
  const kws    = allKws.filter(k => {
    if (kwFilterCountry && k.country !== kwFilterCountry) return false;
    if (kwFilterTag     && k.tag     !== kwFilterTag)     return false;
    return true;
  });

  const empty   = document.getElementById('kw-empty');
  const tblWrap = document.getElementById('kw-table-wrap');
  const fbar    = document.getElementById('kw-filter-bar');

  if (!tblWrap) return;

  if (allKws.length === 0) {
    if (empty)   empty.style.display = '';
    tblWrap.innerHTML = '';
    if (fbar)    fbar.style.display  = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (fbar)  fbar.style.display  = '';

  kwPopulateFilters(allKws);

  const countEl = document.getElementById('kw-filter-count');
  if (countEl) countEl.textContent = `${kws.length} of ${allKws.length} keyword${allKws.length !== 1 ? 's' : ''}`;

  if (kws.length === 0) {
    tblWrap.innerHTML = '<div class="kw-no-match">No keywords match the selected filters.</div>';
    return;
  }

  tblWrap.innerHTML = `
    <div class="kw-table-scroll">
      <table class="kw-table">
        <thead>
          <tr>
            <th>Keyword</th>
            <th>Country</th>
            <th>Tag</th>
            <th class="kw-tc">Position</th>
            <th>Ranking Page</th>
            <th class="kw-tc">Target</th>
            <th class="kw-tc">Trend</th>
            <th class="kw-tc">GEO</th>
            <th class="kw-tc">Actions</th>
          </tr>
        </thead>
        <tbody id="kw-tbody">${kws.map(kw => kwBuildRow(kw)).join('')}</tbody>
      </table>
    </div>`;

  document.querySelectorAll('.kw-row-main').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.kw-actions')) return;
      const id  = Number(row.dataset.id);
      const det = document.getElementById('kw-detail-' + id);
      if (!det) return;
      const open = det.style.display !== 'none';
      det.style.display = open ? 'none' : '';
      row.classList.toggle('kw-row-open', !open);
    });
  });

  document.querySelectorAll('.kw-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      kwOpenForm(Number(btn.dataset.id));
    });
  });

  document.querySelectorAll('.kw-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const kw = kwLoad().find(k => k.id === id);
      if (kw && confirm('Delete "' + kw.keyword + '"?')) {
        kwDelete(id);
        kwRender();
      }
    });
  });
}

function kwBuildRow(kw) {
  const { position, page } = kwLookupGsc(kw.keyword, kw.country);
  const trend    = kwTrend(kw.history);
  const geo      = page ? kwGeoForPage(page) : null;
  const geoScore = geo ? geo.score : null;

  let targetMatch = '\u2014';
  let targetCls   = '';
  if (kw.targetPage && page) {
    let pagePath;
    try { pagePath = new URL(page).pathname; } catch { pagePath = page; }
    const norm  = s => s.replace(/\/$/, '').toLowerCase();
    const match = norm(pagePath) === norm(kw.targetPage);
    targetMatch = match ? '\u2713' : '\u2717';
    targetCls   = match ? 'kw-target-yes' : 'kw-target-no';
  }

  let posTxt = '\u2014';
  let posCls = '';
  if (position !== null) {
    posTxt = '#' + position;
    posCls = position <= 3 ? 'kw-pos-top' : position <= 10 ? 'kw-pos-good' : position <= 20 ? 'kw-pos-mid' : 'kw-pos-low';
  }

  let pageDisp = '\u2014';
  let pageFull = '';
  if (page) {
    try { pageDisp = new URL(page).pathname || '/'; } catch { pageDisp = page; }
    pageFull = page;
  }

  const countryLabel = kw.country ? (KW_COUNTRIES[kw.country] || kw.country.toUpperCase()) : '\u2014';

  let geoDisp = '\u2014';
  let geoCls  = '';
  if (geoScore !== null) {
    geoDisp = '' + geoScore;
    geoCls  = geoScore >= 70 ? 'kw-geo-good' : geoScore >= 50 ? 'kw-geo-mid' : 'kw-geo-low';
  }

  const detailHtml = kwBuildDetail(kw, { position, page, geo, trend });

  return `
    <tr class="kw-row-main" data-id="${kw.id}">
      <td class="kw-cell-kw">
        <span class="kw-expand-icon">\u25b6</span>
        <span class="kw-keyword-text">${esc(kw.keyword)}</span>
      </td>
      <td class="kw-cell-country">${esc(countryLabel)}</td>
      <td>${kw.tag ? '<span class="kw-tag-pill">' + esc(kw.tag) + '</span>' : '<span class="kw-no-data">\u2014</span>'}</td>
      <td class="kw-tc"><span class="kw-pos ${posCls}">${posTxt}</span></td>
      <td class="kw-cell-page">${page
        ? '<a href="' + esc(pageFull) + '" target="_blank" rel="noopener" class="kw-page-link" title="' + esc(pageFull) + '">' + esc(pageDisp) + '</a>'
        : '<span class="kw-no-data">\u2014</span>'}</td>
      <td class="kw-tc"><span class="${targetCls}">${targetMatch}</span></td>
      <td class="kw-tc"><span class="${trend.cls}">${trend.arrow}</span></td>
      <td class="kw-tc"><span class="kw-geo ${geoCls}">${geoDisp}</span></td>
      <td class="kw-tc kw-actions">
        <button class="kw-edit-btn kw-action-btn" data-id="${kw.id}" title="Edit">\u270f\ufe0f</button>
        <button class="kw-delete-btn kw-action-btn" data-id="${kw.id}" title="Delete">\uD83D\uDDD1\uFE0F</button>
      </td>
    </tr>
    <tr class="kw-row-detail" id="kw-detail-${kw.id}" style="display:none">
      <td colspan="9">${detailHtml}</td>
    </tr>`;
}

function kwBuildDetail(kw, { position, page, geo, trend }) {
  const countryLabel = kw.country ? (KW_COUNTRIES[kw.country] || kw.country.toUpperCase()) : 'Any';

  let histHtml = '<span class="kw-detail-none">No position history yet \u2014 click Snapshot to record current GSC positions.</span>';
  if (kw.history.length) {
    const rows = [...kw.history].reverse().slice(0, 10).map((h, i, arr) => {
      const prev  = arr[i + 1];
      const delta = prev ? (prev.position - h.position) : 0;
      const arrow = delta > 0 ? '<span class="kw-trend-up">\u2191' + delta + '</span>'
                  : delta < 0 ? '<span class="kw-trend-down">\u2193' + Math.abs(delta) + '</span>'
                  : '';
      let dispPage = h.page || '\u2014';
      try { dispPage = new URL(h.page).pathname; } catch {}
      return '<tr><td>' + esc(h.date) + '</td><td><strong>#' + h.position + '</strong> ' + arrow + '</td><td class="kw-detail-page">' + esc(dispPage) + '</td></tr>';
    }).join('');
    histHtml = '<table class="kw-hist-table"><thead><tr><th>Date</th><th>Position</th><th>Page</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  let geoHtml = '<span class="kw-detail-none">Load crawl data to see GEO readiness for the ranking page.</span>';
  if (geo) {
    const bars = Object.entries(geo.breakdown).map(([k, v]) => {
      const label = k.charAt(0).toUpperCase() + k.slice(1);
      const clr   = v >= 70 ? '#16a34a' : v >= 50 ? '#2563eb' : '#dc2626';
      return '<div class="kw-geo-bar-row"><span class="kw-geo-bar-label">' + esc(label) + '</span>' +
        '<div class="kw-geo-bar-track"><div class="kw-geo-bar-fill" style="width:' + v + '%;background:' + clr + '"></div></div>' +
        '<span class="kw-geo-bar-val">' + v + '</span></div>';
    }).join('');
    geoHtml = '<div class="kw-geo-bars">' + bars + '</div>';
  }

  let pagePath = '';
  if (page) { try { pagePath = new URL(page).pathname; } catch { pagePath = page; } }

  return `<div class="kw-detail-wrap">
    <div class="kw-detail-meta">
      <div class="kw-detail-meta-item"><span class="kw-dm-label">Keyword</span><strong>${esc(kw.keyword)}</strong></div>
      <div class="kw-detail-meta-item"><span class="kw-dm-label">Country</span>${esc(countryLabel)}</div>
      ${kw.targetPage ? '<div class="kw-detail-meta-item"><span class="kw-dm-label">Target Page</span>' + esc(kw.targetPage) + '</div>' : ''}
      ${kw.tag        ? '<div class="kw-detail-meta-item"><span class="kw-dm-label">Tag</span>' + esc(kw.tag) + '</div>' : ''}
      <div class="kw-detail-meta-item"><span class="kw-dm-label">Current Position</span>${position !== null ? '<strong>#' + position + '</strong>' : 'Not found in GSC'}</div>
      <div class="kw-detail-meta-item"><span class="kw-dm-label">Trend</span><span class="${trend.cls}">${trend.arrow}</span></div>
    </div>
    <div class="kw-detail-cols">
      <div class="kw-detail-col">
        <div class="kw-detail-col-hd">Position History</div>
        ${histHtml}
      </div>
      <div class="kw-detail-col">
        <div class="kw-detail-col-hd">GEO Readiness${pagePath ? ' \u2014 ' + esc(pagePath) : ''}</div>
        ${geoHtml}
      </div>
    </div>
  </div>`;
}

// ── Filter dropdowns ──────────────────────────────────────────────────────────

function kwPopulateFilters(kws) {
  const countryEl = document.getElementById('kw-filter-country');
  const tagEl     = document.getElementById('kw-filter-tag');
  if (!countryEl || !tagEl) return;

  const countries = [...new Set(kws.map(k => k.country).filter(Boolean))].sort();
  const tags      = [...new Set(kws.map(k => k.tag).filter(Boolean))].sort();

  countryEl.innerHTML = '<option value="">All Countries</option>' +
    countries.map(v => '<option value="' + esc(v) + '"' + (v === kwFilterCountry ? ' selected' : '') + '>' + esc(KW_COUNTRIES[v] || v.toUpperCase()) + '</option>').join('');

  tagEl.innerHTML = '<option value="">All Tags</option>' +
    tags.map(v => '<option value="' + esc(v) + '"' + (v === kwFilterTag ? ' selected' : '') + '>' + esc(v) + '</option>').join('');

  countryEl.value = kwFilterCountry;
  tagEl.value     = kwFilterTag;
}

// ── Form ──────────────────────────────────────────────────────────────────────

function kwOpenForm(id) {
  const wrap  = document.getElementById('kw-form-wrap');
  const errEl = document.getElementById('kw-form-err');
  if (!wrap) return;
  if (errEl) errEl.style.display = 'none';

  if (id) {
    const kw = kwLoad().find(k => k.id === id);
    if (!kw) return;
    const titleEl = document.getElementById('kw-form-title');
    if (titleEl) titleEl.textContent = 'Edit Keyword';
    document.getElementById('kw-f-id').value      = id;
    document.getElementById('kw-f-keyword').value = kw.keyword    || '';
    document.getElementById('kw-f-country').value = kw.country    || '';
    document.getElementById('kw-f-target').value  = kw.targetPage || '';
    document.getElementById('kw-f-tag').value     = kw.tag        || '';
  } else {
    const titleEl = document.getElementById('kw-form-title');
    if (titleEl) titleEl.textContent = 'Add Keyword';
    document.getElementById('kw-f-id').value      = '';
    document.getElementById('kw-f-keyword').value = '';
    document.getElementById('kw-f-country').value = '';
    document.getElementById('kw-f-target').value  = '';
    document.getElementById('kw-f-tag').value     = '';
  }

  wrap.style.display = '';
  document.getElementById('kw-f-keyword')?.focus();
}

function kwCloseForm() {
  const wrap = document.getElementById('kw-form-wrap');
  if (wrap) wrap.style.display = 'none';
}

function kwSaveForm() {
  const keyword = (document.getElementById('kw-f-keyword')?.value || '').trim();
  const errEl   = document.getElementById('kw-form-err');

  if (!keyword) {
    if (errEl) { errEl.textContent = 'Keyword is required.'; errEl.style.display = ''; }
    document.getElementById('kw-f-keyword')?.focus();
    return;
  }

  const data = {
    keyword,
    country:    (document.getElementById('kw-f-country')?.value || '').trim().toLowerCase(),
    targetPage: (document.getElementById('kw-f-target')?.value  || '').trim(),
    tag:        (document.getElementById('kw-f-tag')?.value     || '').trim(),
  };

  const id = Number(document.getElementById('kw-f-id')?.value || 0);
  if (id) { kwUpdate(id, data); } else { kwAdd(data); }

  kwCloseForm();
  kwRender();
}

// ── Init ──────────────────────────────────────────────────────────────────────

(function initKwTracker() {
  document.getElementById('kw-add-btn')?.addEventListener('click', () => kwOpenForm(null));
  document.getElementById('kw-form-save')?.addEventListener('click', kwSaveForm);
  document.getElementById('kw-form-cancel')?.addEventListener('click', kwCloseForm);

  document.getElementById('kw-filter-country')?.addEventListener('change', e => {
    kwFilterCountry = e.target.value;
    kwRender();
  });

  document.getElementById('kw-filter-tag')?.addEventListener('change', e => {
    kwFilterTag = e.target.value;
    kwRender();
  });

  document.getElementById('kw-snapshot-btn')?.addEventListener('click', () => {
    const n   = kwSnapshotAll();
    const msg = n > 0
      ? 'Snapshot saved \u2014 ' + n + ' position' + (n !== 1 ? 's' : '') + ' recorded.'
      : 'No GSC data loaded \u2014 connect GSC first to take a snapshot.';
    kwRender();
    alert(msg);
  });

  document.getElementById('kw-f-keyword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') kwSaveForm();
  });

  kwRender();
})();


// ══════════════════════════════════════════════════════════════════════════════
// COMPETITOR ANALYSIS MODULE
// ══════════════════════════════════════════════════════════════════════════════

// ── Signal extraction ─────────────────────────────────────────────────────────
// Parse structured metrics out of the SEO check results returned by the server.

function caExtractSignals(checks, responseTimeMs) {
  const get  = name  => checks.find(c => c.check === name);
  const numRe = (msg, re) => { const m = (msg || '').match(re); return m ? +m[1] : 0; };

  // Word count
  const wcCheck  = get('Word Count');
  const wordCount = numRe(wcCheck?.message, /(\d+)\s*words/);

  // Headings — parse "H1:1  H2:4  H3:2" from Heading Structure message
  const hsCheck = get('Heading Structure');
  const hsParse = (tag) => numRe(hsCheck?.message, new RegExp(tag + ':(\\d+)'));
  let h1 = hsParse('H1'), h2 = hsParse('H2'), h3 = hsParse('H3');
  // Fallback: if H1 Tag check passed, count as 1
  if (!h1 && get('H1 Tag')?.status === 'pass') h1 = 1;

  // Schema
  const schemaCheck = get('Schema Markup');
  const hasSchema   = schemaCheck?.status === 'pass';
  let schemaTypes   = [];
  if (hasSchema) {
    const m = (schemaCheck.message || '').match(/:\s*(.+)$/);
    if (m) schemaTypes = m[1].split(',').map(s => s.trim());
  }
  const hasFaqSchema  = schemaTypes.some(t => /faq/i.test(t));
  const hasHowTo      = schemaTypes.some(t => /howto|how.to/i.test(t));
  const hasLocalBiz   = schemaTypes.some(t => /local|business|organization/i.test(t));

  // Meta description
  const metaCheck  = get('Meta Description');
  const hasGoodMeta = metaCheck?.status === 'pass';
  const metaLen     = numRe(metaCheck?.message, /(\d+)\s*chars/);

  // Internal links
  const linkCheck    = get('Internal Links');
  const internalLinks = numRe(linkCheck?.message, /(\d+)\s*internal/);

  // Page speed
  const speedMs = responseTimeMs || 0;

  // Open Graph
  const ogCheck   = get('Open Graph Tags');
  const hasGoodOg = ogCheck?.status === 'pass';

  // Canonical
  const canCheck = get('Canonical Tag');
  const hasCanonical = canCheck?.status === 'pass';

  return {
    wordCount, h1, h2, h3,
    hasSchema, schemaTypes, hasFaqSchema, hasHowTo, hasLocalBiz,
    hasGoodMeta, metaLen,
    internalLinks,
    speedMs,
    hasGoodOg,
    hasCanonical,
  };
}

// ── GEO scoring from raw checks ───────────────────────────────────────────────
// Reuses our existing calcGeoScore which already parses check messages.

function caGeoScore(checks, url) {
  if (!checks || !checks.length) return { score: 0, breakdown: { content: 0, structure: 0, schema: 0, clarity: 0, authority: 0 } };
  return calcGeoScore({ checks, url: url || '' });
}

// ── "Why They Win" engine ─────────────────────────────────────────────────────
// Returns an ordered array of signal gaps between our page and a competitor.

function caWhyWins(us, them) {
  const reasons = [];

  // Content depth
  if (them.wordCount > 0 && (us.wordCount === 0 || them.wordCount > us.wordCount * 1.25)) {
    const uW = us.wordCount, tW = them.wordCount;
    const sev = tW > 1000 && uW < 500 ? 'high' : 'medium';
    reasons.push({
      signal: 'Content Depth',
      icon: '📝',
      severity: sev,
      gap: uW === 0 ? 'We have no content data' : `${tW.toLocaleString()} words vs our ${uW.toLocaleString()}`,
      detail: uW === 0
        ? 'Could not extract word count from our page. Ensure the page is crawled.'
        : `Their page is ${Math.round((tW / uW - 1) * 100)}% longer. Search engines and AI systems favour pages with more comprehensive, well-organised content for competitive terms.`,
      fix: 'Expand your page with deeper explanations, process breakdowns, FAQs, case study snippets, and supporting statistics. Target 800+ words for competitive keywords.',
    });
  }

  // Heading structure
  if (them.h2 > us.h2 + 1) {
    reasons.push({
      signal: 'Heading Structure',
      icon: '📋',
      severity: 'medium',
      gap: `${them.h2} H2s vs our ${us.h2}`,
      detail: 'More H2 subheadings create a clearer content outline. Both search engines and AI systems use heading hierarchy to extract and index individual topic sections.',
      fix: 'Add H2 headings for each major topic. For a service page, consider: What is X, Who is it for, How it works, Pricing, FAQs.',
    });
  }

  // FAQ schema
  if (them.hasFaqSchema && !us.hasFaqSchema) {
    reasons.push({
      signal: 'FAQ Schema',
      icon: '🤖',
      severity: 'high',
      gap: 'They have FAQPage schema — we do not',
      detail: 'FAQPage JSON-LD directly enables Google People Also Ask boxes and is one of the highest-value GEO signals. AI systems specifically look for Q&A structure when deciding what content to cite in generated answers.',
      fix: 'Add FAQPage JSON-LD to your page with 5–8 concise question/answer pairs. Focus on intent-matched questions your buyers actually ask.',
    });
  }

  // Schema markup (general)
  if (them.hasSchema && !us.hasSchema) {
    reasons.push({
      signal: 'Structured Data',
      icon: '🔖',
      severity: 'high',
      gap: `They use schema (${them.schemaTypes.slice(0, 2).join(', ') || 'structured data'}) — we have none`,
      detail: 'Schema markup provides machine-readable context about your business, services, and content. Without it, search engines and AI systems must guess your content meaning — reducing confidence and citation likelihood.',
      fix: 'Add at minimum an Organization schema. For service pages, add Service or LocalBusiness. For content pages, add Article or HowTo schema.',
    });
  }

  // Meta description
  if (them.hasGoodMeta && !us.hasGoodMeta) {
    reasons.push({
      signal: 'Meta Description',
      icon: '📌',
      severity: 'medium',
      gap: us.metaLen === 0 ? 'We have no meta description' : `Ours is ${us.metaLen} chars (weak)`,
      detail: 'A compelling meta description improves click-through rate from search results. AI systems also use it as a page summary signal when deciding what content to surface.',
      fix: 'Write a 120–160 character meta description that includes your primary keyword and a clear value proposition or call-to-action.',
    });
  }

  // Internal links
  if (them.internalLinks > us.internalLinks + 4) {
    reasons.push({
      signal: 'Internal Linking',
      icon: '🔗',
      severity: 'low',
      gap: `${them.internalLinks} internal links vs our ${us.internalLinks}`,
      detail: 'Stronger internal linking signals topical depth and distributes authority across related pages. It also helps AI systems map your content expertise hierarchy.',
      fix: 'Add contextual links to related service pages, blog content, case studies, and supporting resources from within the page body.',
    });
  }

  // Page speed
  if (us.speedMs > 0 && them.speedMs > 0 && them.speedMs < us.speedMs * 0.65 && us.speedMs > 1500) {
    reasons.push({
      signal: 'Page Speed',
      icon: '\u26a1',
      severity: 'medium',
      gap: `Their response: ${them.speedMs}ms — ours: ${us.speedMs}ms`,
      detail: 'Faster-loading pages receive ranking preference. Slow server response also increases bounce rate, reducing the engagement signals that reinforce rankings.',
      fix: 'Investigate hosting performance, enable server-side caching, optimise images, and consider a CDN for static assets.',
    });
  }

  // Sort: high first, then medium, then low
  const order = { high: 0, medium: 1, low: 2 };
  reasons.sort((a, b) => order[a.severity] - order[b.severity]);
  return reasons;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function caPageLabel(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + u.pathname; }
  catch { return url; }
}

function caHostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function caPosCell(pos) {
  if (!pos) return '<span class="ca-nd">\u2014</span>';
  const cls = pos <= 3 ? 'ca-pos-top' : pos <= 10 ? 'ca-pos-good' : pos <= 20 ? 'ca-pos-mid' : 'ca-pos-low';
  return '<span class="ca-pos ' + cls + '">#' + pos + '</span>';
}

function caGeoBar(score) {
  const clr = score >= 70 ? '#16a34a' : score >= 50 ? '#2563eb' : score >= 30 ? '#d97706' : '#dc2626';
  return '<div class="ca-geo-bar-wrap"><div class="ca-geo-bar" style="width:' + score + '%;background:' + clr + '"></div></div>' +
    '<span class="ca-geo-val" style="color:' + clr + '">' + score + '</span>';
}

function caSig(val, good, bad) {
  if (val === undefined || val === null) return '<span class="ca-nd">\u2014</span>';
  const ok = typeof val === 'boolean' ? val : val > 0;
  return ok
    ? '<span class="ca-sig-yes">\u2713 ' + esc(good || String(val)) + '</span>'
    : '<span class="ca-sig-no">\u2717 ' + esc(bad  || String(val)) + '</span>';
}

// ── Main render ───────────────────────────────────────────────────────────────

function caRenderResults(keyword, rows) {
  // rows: [{ url, label, pos, checks, responseTimeMs, status, error, isUs }]
  const good  = rows.filter(r => r.status === 'ok');
  const us    = rows.find(r => r.isUs);
  const comps = rows.filter(r => !r.isUs && r.status === 'ok');

  // ── 1. Ranking comparison table ──────────────────────────────
  const rankHtml = (() => {
    const cols = rows.map(r => {
      const host = caHostLabel(r.url);
      const page = caPageLabel(r.url);
      let statusBadge = '';
      if (r.status === 'error')   statusBadge = '<span class="ca-fetch-err">Fetch failed</span>';
      if (r.status === 'loading') statusBadge = '<span class="ca-fetching">Loading\u2026</span>';
      return `
        <tr class="${r.isUs ? 'ca-us-row' : ''}">
          <td>
            <div class="ca-site-cell">
              ${r.isUs ? '<span class="ca-us-badge">Us</span>' : ''}
              <span class="ca-site-host">${esc(host)}</span>
            </div>
            <div class="ca-site-page"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(page)}</a></div>
            ${statusBadge}
          </td>
          <td class="ca-tc">${caPosCell(r.pos)}</td>
          <td class="ca-tc">${r.status === 'ok' ? caGeoBar(r.geo.score) : '<span class="ca-nd">\u2014</span>'}</td>
          <td class="ca-tc">${r.status === 'ok' ? (r.signals.wordCount > 0 ? r.signals.wordCount.toLocaleString() : '\u2014') : '\u2014'}</td>
          <td class="ca-tc">${r.status === 'ok' ? ('H1:' + r.signals.h1 + ' H2:' + r.signals.h2) : '\u2014'}</td>
          <td class="ca-tc">${r.status === 'ok' ? caSig(r.signals.hasSchema, 'Yes', 'No') : '\u2014'}</td>
          <td class="ca-tc">${r.status === 'ok' ? caSig(r.signals.hasFaqSchema, 'Yes', 'No') : '\u2014'}</td>
          <td class="ca-tc">${r.signals?.speedMs ? r.signals.speedMs + 'ms' : '\u2014'}</td>
        </tr>`;
    }).join('');

    return `<div class="ca-table-scroll">
      <table class="ca-table">
        <thead><tr>
          <th>Page</th>
          <th class="ca-tc">Position</th>
          <th class="ca-tc">GEO Score</th>
          <th class="ca-tc">Words</th>
          <th class="ca-tc">Headings</th>
          <th class="ca-tc">Schema</th>
          <th class="ca-tc">FAQ Schema</th>
          <th class="ca-tc">Speed</th>
        </tr></thead>
        <tbody>${cols}</tbody>
      </table>
    </div>`;
  })();

  document.getElementById('ca-ranking-table').innerHTML = rankHtml;

  // ── 2. GEO breakdown comparison ──────────────────────────────
  const geoHtml = (() => {
    const components = ['content', 'structure', 'schema', 'clarity', 'authority'];
    const compLabels = { content: 'Content Depth', structure: 'Heading Structure', schema: 'Schema Signals', clarity: 'Answer Clarity', authority: 'Entity Signals' };

    const colHeaders = good.map(r =>
      '<th class="ca-tc">' +
      (r.isUs ? '<span class="ca-us-badge">Us</span><br>' : '') +
      esc(caHostLabel(r.url)) + '</th>'
    ).join('');

    const compRows = components.map(comp => {
      const cells = good.map(r => {
        const val = r.geo.breakdown?.[comp] ?? 0;
        const clr = val >= 70 ? '#16a34a' : val >= 50 ? '#2563eb' : val >= 30 ? '#d97706' : '#dc2626';
        return '<td class="ca-tc"><span style="font-weight:700;color:' + clr + '">' + val + '</span>' +
          '<div class="ca-mini-bar"><div class="ca-mini-fill" style="width:' + val + '%;background:' + clr + '"></div></div></td>';
      }).join('');
      return '<tr><td class="ca-comp-label">' + esc(compLabels[comp]) + '</td>' + cells + '</tr>';
    }).join('');

    const totalRow = '<tr class="ca-total-row"><td><strong>Overall GEO</strong></td>' +
      good.map(r => {
        const s = r.geo.score;
        const clr = s >= 70 ? '#16a34a' : s >= 50 ? '#2563eb' : s >= 30 ? '#d97706' : '#dc2626';
        return '<td class="ca-tc"><strong style="font-size:16px;color:' + clr + '">' + s + '</strong></td>';
      }).join('') + '</tr>';

    return '<div class="ca-table-scroll"><table class="ca-table ca-geo-table">' +
      '<thead><tr><th>Component</th>' + colHeaders + '</tr></thead>' +
      '<tbody>' + compRows + totalRow + '</tbody>' +
      '</table></div>';
  })();

  document.getElementById('ca-geo-table').innerHTML = geoHtml;

  // ── 3. Why they win ──────────────────────────────────────────
  const whyHtml = (() => {
    if (!us || us.status === 'error') {
      return '<div class="ca-why-empty">Our page analysis failed \u2014 fix the URL and re-run to see signal comparisons.</div>';
    }
    if (!comps.length) {
      return '<div class="ca-why-empty">No competitor pages fetched successfully.</div>';
    }

    const blocks = comps.map(comp => {
      const reasons = caWhyWins(us.signals, comp.signals);
      const host    = caHostLabel(comp.url);
      const geoGap  = comp.geo.score - us.geo.score;
      const geoGapTxt = geoGap > 0
        ? '<span class="ca-geo-ahead">Their GEO score is ' + geoGap + ' pts higher</span>'
        : geoGap < 0
        ? '<span class="ca-geo-behind">Our GEO score is ' + Math.abs(geoGap) + ' pts higher</span>'
        : '<span class="ca-geo-tied">GEO scores are equal</span>';

      if (!reasons.length) {
        return '<div class="ca-why-block"><div class="ca-why-hd">' + esc(host) + '</div>' +
          '<div class="ca-why-none">\u2713 No significant structural advantages found for this competitor. Our page is competitive on all measured signals.</div></div>';
      }

      const cards = reasons.map(r => {
        const sevCls = 'ca-sev-' + r.severity;
        return '<div class="ca-reason-card">' +
          '<div class="ca-reason-hd">' +
            '<span class="ca-reason-icon">' + r.icon + '</span>' +
            '<span class="ca-reason-signal">' + esc(r.signal) + '</span>' +
            '<span class="ca-sev-badge ' + sevCls + '">' + r.severity + '</span>' +
          '</div>' +
          '<div class="ca-reason-gap">' + esc(r.gap) + '</div>' +
          '<div class="ca-reason-detail">' + esc(r.detail) + '</div>' +
          '<div class="ca-reason-fix"><strong>Fix:</strong> ' + esc(r.fix) + '</div>' +
        '</div>';
      }).join('');

      return '<div class="ca-why-block">' +
        '<div class="ca-why-hd"><span>' + esc(host) + '</span>' + geoGapTxt + '</div>' +
        '<div class="ca-reason-cards">' + cards + '</div>' +
      '</div>';
    }).join('');

    return blocks;
  })();

  document.getElementById('ca-why-wins').innerHTML = whyHtml;
  document.getElementById('ca-results').style.display = '';
}

// ── Auto-detect our page from GSC ─────────────────────────────────────────────

function caAutoFillFromGsc(keyword, country) {
  const { position, page } = kwLookupGsc(keyword, country);
  const urlEl = document.getElementById('ca-our-url');
  const posEl = document.getElementById('ca-our-pos');
  if (page   && urlEl && !urlEl.value) urlEl.value = page;
  if (position && posEl && !posEl.value) posEl.value = position;
}

// ── Analyze handler ───────────────────────────────────────────────────────────

async function caAnalyze() {
  const keyword = (document.getElementById('ca-keyword')?.value || '').trim();
  const country = (document.getElementById('ca-country')?.value || '').trim();
  const ourUrl  = (document.getElementById('ca-our-url')?.value || '').trim();
  const ourPos  = parseInt(document.getElementById('ca-our-pos')?.value || '') || null;
  const errEl   = document.getElementById('ca-form-err');
  const spinner = document.getElementById('ca-spinner');

  if (!keyword) {
    if (errEl) { errEl.textContent = 'Please enter a keyword.'; errEl.style.display = ''; }
    document.getElementById('ca-keyword')?.focus();
    return;
  }

  // Collect competitor rows
  const compUrls = [...document.querySelectorAll('.ca-comp-url')]
    .map((el, i) => ({
      url: el.value.trim(),
      pos: parseInt(document.querySelectorAll('.ca-comp-pos')[i]?.value || '') || null,
    }))
    .filter(c => c.url && /^https?:\/\//i.test(c.url));

  if (!ourUrl && !compUrls.length) {
    if (errEl) { errEl.textContent = 'Enter at least one page URL to analyze.'; errEl.style.display = ''; }
    return;
  }

  if (errEl) errEl.style.display = 'none';
  if (spinner) spinner.style.display = '';
  document.getElementById('ca-results').style.display = 'none';
  document.getElementById('ca-analyze-btn').disabled = true;

  // Build pages array for the backend
  const pages = [];
  if (ourUrl) pages.push({ url: ourUrl, label: 'us' });
  compUrls.forEach((c, i) => pages.push({ url: c.url, label: 'comp-' + (i + 1) }));

  try {
    const resp = await fetch('/api/competitor/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Server error ' + resp.status);
    }

    const { results } = await resp.json();

    // Build enriched rows
    const rows = results.map((r, i) => {
      const isUs    = r.label === 'us';
      const compMeta = isUs ? { pos: ourPos } : compUrls[i - (ourUrl ? 1 : 0)] || {};
      const signals  = r.status === 'ok' ? caExtractSignals(r.checks, r.responseTimeMs) : null;
      const geo      = r.status === 'ok' ? caGeoScore(r.checks, r.url) : { score: 0, breakdown: {} };
      return { ...r, isUs, pos: compMeta.pos, signals: signals || {}, geo };
    });

    // If our URL wasn't fetched but we have GSC + crawl data, try to fill from allPages
    if (ourUrl && !rows.find(r => r.isUs && r.status === 'ok')) {
      const gscLookup = kwLookupGsc(keyword, country);
      if (gscLookup.page) {
        const localPage = allPages.find(p => p.url === gscLookup.page || p.path === gscLookup.page);
        if (localPage) {
          const uRow = rows.find(r => r.isUs);
          if (uRow) {
            uRow.status  = 'ok';
            uRow.signals = caExtractSignals(localPage.checks || [], localPage.responseTimeMs);
            uRow.geo     = caGeoScore(localPage.checks || [], localPage.url);
            uRow.pos     = uRow.pos || ourPos;
          }
        }
      }
    }

    caRenderResults(keyword, rows);

  } catch (err) {
    if (errEl) { errEl.textContent = 'Analysis failed: ' + err.message; errEl.style.display = ''; }
  } finally {
    if (spinner) spinner.style.display = 'none';
    document.getElementById('ca-analyze-btn').disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

(function initCompetitor() {
  document.getElementById('ca-analyze-btn')?.addEventListener('click', caAnalyze);

  // Auto-fill our URL from GSC when keyword/country changes
  const tryAutoFill = () => {
    const kw      = (document.getElementById('ca-keyword')?.value || '').trim();
    const country = (document.getElementById('ca-country')?.value || '').trim();
    if (kw) caAutoFillFromGsc(kw, country);
  };

  document.getElementById('ca-keyword')?.addEventListener('blur',  tryAutoFill);
  document.getElementById('ca-country')?.addEventListener('change', tryAutoFill);

  // Allow Enter in keyword field to trigger analysis
  document.getElementById('ca-keyword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') caAnalyze();
  });
})();
