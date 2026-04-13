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

let gscInitialized = false;
let gscRows        = [];   // last fetched rows (for re-sorting)
let gscDims        = [];   // active dimensions during last fetch
let gscSortKey     = 'clicks';
let gscSortDir     = -1;   // -1 = descending

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
  gscInitialized = false;
  gscRows = [];
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

    gscRows    = body.rows || [];
    gscSortKey = 'clicks';
    gscSortDir = -1;
    renderGSCData(gscRows, fmt(start), fmt(end));
  } catch (err) {
    resultsEl.innerHTML = `<div class="gsc-error-banner" style="margin:24px">${esc(err.message)}</div>`;
  }
}

// ── Render results ────────────────────────────────────────────────────────────
function renderGSCData(rows, startDate, endDate) {
  const container = document.getElementById('gsc-results');

  if (!rows || rows.length === 0) {
    container.innerHTML = '<div class="gsc-empty">No data found for this property and date range.</div>';
    return;
  }

  const totClicks = rows.reduce((s, r) => s + r.clicks,      0);
  const totImp    = rows.reduce((s, r) => s + r.impressions, 0);
  const avgCTR    = totImp > 0 ? (totClicks / totImp) * 100 : 0;
  const avgPos    = rows.reduce((s, r) => s + r.position, 0) / rows.length;

  container.innerHTML = `
    <div class="gsc-summary">
      <div class="gm-card"><div class="gm-label">Total Clicks</div><div class="gm-value">${totClicks.toLocaleString()}</div></div>
      <div class="gm-card"><div class="gm-label">Total Impressions</div><div class="gm-value">${totImp.toLocaleString()}</div></div>
      <div class="gm-card"><div class="gm-label">Avg CTR</div><div class="gm-value">${avgCTR.toFixed(1)}%</div></div>
      <div class="gm-card"><div class="gm-label">Avg Position</div><div class="gm-value">${avgPos.toFixed(1)}</div></div>
    </div>
    <div class="gsc-meta">${rows.length.toLocaleString()} rows &nbsp;·&nbsp; ${startDate} → ${endDate}</div>
    <div class="gsc-table-wrap" id="gsc-table-wrap"></div>
  `;

  renderGSCTable();
}

function renderGSCTable() {
  const wrap = document.getElementById('gsc-table-wrap');
  if (!wrap) return;

  const sorted = [...gscRows].sort((a, b) => {
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
