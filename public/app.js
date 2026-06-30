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

  // Refresh AI module page selectors now that allPages is fully populated
  rbPopulatePageSelect();
  agPopulateSelects();
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

// ── Audit Export ──────────────────────────────────────────────────────────────

function showAuditExportMenu(e) {
  if (e) e.stopPropagation();
  const menu = $('audit-export-menu');
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    function closeMenu(ev) {
      if (!menu.contains(ev.target) && ev.target.id !== 'audit-export-btn') {
        menu.style.display = 'none';
        document.removeEventListener('click', closeMenu);
      }
    }
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }
}

function _auditFilename(ext) {
  const slug = (startUrl || 'report')
    .replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').slice(0, 40);
  return `seo-audit-${slug}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function _auditScoreColor(s) {
  if (s >= 90) return '#16a34a';
  if (s >= 75) return '#22c55e';
  if (s >= 50) return '#f59e0b';
  if (s >= 25) return '#f97316';
  return '#dc2626';
}

function _auditScoreLabel(s) {
  if (s >= 90) return 'Excellent';
  if (s >= 75) return 'Strong';
  if (s >= 50) return 'Needs Improvement';
  if (s >= 25) return 'Poor';
  return 'Critical';
}

function _auditBuildGroups() {
  const groups = new Map();
  for (const page of allPages) {
    for (const c of [...(page.checks || []), ...(page.convChecks || [])]) {
      if (c.status === 'info') continue;
      const key = `${c.status}|${c.category || 'Other'}|${c.check}`;
      if (!groups.has(key)) groups.set(key, { status: c.status, category: c.category || 'Other', check: c.check, detail: c.detail || '', pages: [] });
      groups.get(key).pages.push({ url: page.url, path: page.path, message: c.message });
    }
  }
  const order = { fail: 0, warn: 1, pass: 2 };
  return [...groups.values()].sort((a, b) => {
    const od = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    return od !== 0 ? od : b.pages.length - a.pages.length;
  });
}

function exportAuditHTML() {
  if (!allPages.length) return;

  const scores   = computeScores(allPages);
  const totalFail = allPages.reduce((n, p) => n + (p.issueCount?.fail || 0), 0);
  const totalWarn = allPages.reduce((n, p) => n + (p.issueCount?.warn || 0), 0);
  const totalPass = allPages.reduce((n, p) => n + (p.issueCount?.pass || 0), 0);
  const date      = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const groups    = _auditBuildGroups();
  const errors    = groups.filter(g => g.status === 'fail');
  const warnings  = groups.filter(g => g.status === 'warn');

  function renderGroups(gs, dotColor, badgeColor, badgeLabel) {
    if (!gs.length) return '<p style="color:#888;font-style:italic;padding:8px 0">None found.</p>';
    return gs.map(g => `
      <div style="border:1px solid #e5e7eb;border-radius:8px;margin-bottom:12px;overflow:hidden">
        <div style="background:${badgeColor}12;padding:12px 16px;display:flex;align-items:flex-start;gap:12px;border-bottom:1px solid #e5e7eb">
          <span style="background:${badgeColor};color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap;margin-top:3px">${badgeLabel}</span>
          <div style="flex:1">
            <div style="font-weight:600;font-size:14px;color:#111">${esc(g.check)}</div>
            <div style="font-size:12px;color:#888;margin-top:2px">${g.pages.length} page${g.pages.length !== 1 ? 's' : ''} affected · ${esc(g.category)}</div>
          </div>
        </div>
        ${g.detail ? `<div style="padding:10px 16px;background:#fffbeb;font-size:13px;color:#78530a;border-bottom:1px solid #fde68a">💡 <strong>How to fix:</strong> ${esc(g.detail)}</div>` : ''}
        <div style="padding:0 16px">
          ${g.pages.map(p => `
            <div style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:13px">
              <div style="color:#1d4ed8;font-weight:500">${esc(p.path || '/')}</div>
              <div style="color:#555;margin-top:2px">${esc(p.message)}</div>
            </div>
          `).join('')}
        </div>
      </div>`).join('');
  }

  const pageRows = [...allPages]
    .sort((a, b) => (b.issueCount?.fail || 0) - (a.issueCount?.fail || 0))
    .map(p => {
      const fail = p.issueCount?.fail ?? 0;
      const warn = p.issueCount?.warn ?? 0;
      const ms   = p.responseTimeMs || 0;
      return `<tr>
        <td>${esc(p.path || '/')}<br><small style="color:#aaa;font-size:11px">${esc(p.url)}</small></td>
        <td style="text-align:center">${p.status || '?'}</td>
        <td style="text-align:center;color:${fail > 0 ? '#dc2626' : '#bbb'};font-weight:${fail > 0 ? '700' : '400'}">${fail || '—'}</td>
        <td style="text-align:center;color:${warn > 0 ? '#d97706' : '#bbb'};font-weight:${warn > 0 ? '600' : '400'}">${warn || '—'}</td>
        <td style="text-align:center;color:${ms > 3000 ? '#dc2626' : ms > 0 ? '#333' : '#bbb'}">${ms > 0 ? ms + 'ms' : '—'}</td>
      </tr>`;
    }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEO Audit Report — ${esc(startUrl)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;color:#111;line-height:1.5;font-size:15px}
.wrap{max-width:860px;margin:0 auto;padding:48px 24px 80px}
h2{font-size:18px;font-weight:700;color:#111;margin:36px 0 14px;padding-bottom:8px;border-bottom:2px solid #e5e7eb}
.header-top{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:8px}
.report-title{font-size:26px;font-weight:800;color:#111}
.report-brand{font-size:12px;color:#aaa;margin-top:4px}
.meta{color:#666;font-size:13px;margin-bottom:32px;line-height:1.6}
.score-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:28px}
.sc{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;text-align:center}
.sc-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#999}
.sc-num{font-size:42px;font-weight:800;line-height:1;margin:6px 0 4px}
.sc-tier{font-size:12px;font-weight:700}
.counts{display:flex;gap:12px;margin-bottom:32px;flex-wrap:wrap}
.cnt{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 20px;font-size:14px;display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:13px}
th{background:#f3f4f6;padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.4px}
td{padding:10px 14px;border-top:1px solid #f3f4f6;vertical-align:top}
.footer{margin-top:48px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#bbb;text-align:center}
@media print{body{background:#fff}.wrap{padding:20px 16px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header-top">
    <div>
      <div class="report-title">SEO Audit Report</div>
      <div class="report-brand">Elitez Group · SEO Audit Tool</div>
    </div>
    <div style="text-align:right;font-size:13px;color:#888">${date}</div>
  </div>
  <div class="meta">
    <strong style="color:#111">${esc(startUrl)}</strong><br>
    ${allPages.length} page${allPages.length !== 1 ? 's' : ''} scanned
  </div>

  <div class="score-grid">
    <div class="sc">
      <div class="sc-label">Overall Score</div>
      <div class="sc-num" style="color:${_auditScoreColor(scores.overall)}">${scores.overall}</div>
      <div class="sc-tier" style="color:${_auditScoreColor(scores.overall)}">${_auditScoreLabel(scores.overall)}</div>
    </div>
    <div class="sc">
      <div class="sc-label">SEO Score</div>
      <div class="sc-num" style="color:${_auditScoreColor(scores.seo)}">${scores.seo}</div>
      <div class="sc-tier" style="color:${_auditScoreColor(scores.seo)}">${_auditScoreLabel(scores.seo)}</div>
    </div>
    <div class="sc">
      <div class="sc-label">Pages Scanned</div>
      <div class="sc-num" style="color:#333">${allPages.length}</div>
    </div>
  </div>

  <div class="counts">
    <div class="cnt"><span class="dot" style="background:#dc2626"></span><strong style="color:#dc2626">${totalFail}</strong>&nbsp;Errors</div>
    <div class="cnt"><span class="dot" style="background:#d97706"></span><strong style="color:#d97706">${totalWarn}</strong>&nbsp;Warnings</div>
    <div class="cnt"><span class="dot" style="background:#16a34a"></span><strong style="color:#16a34a">${totalPass}</strong>&nbsp;Passed</div>
  </div>

  <h2>🔴 Critical Errors to Fix First</h2>
  ${renderGroups(errors, '#dc2626', '#dc2626', 'Error')}

  <h2>🟡 Warnings to Address</h2>
  ${renderGroups(warnings, '#d97706', '#d97706', 'Warning')}

  <h2>📄 Page-by-Page Summary</h2>
  <table>
    <tr>
      <th>Page</th>
      <th style="text-align:center">HTTP</th>
      <th style="text-align:center">Errors</th>
      <th style="text-align:center">Warnings</th>
      <th style="text-align:center">Load Time</th>
    </tr>
    ${pageRows}
  </table>

  <div class="footer">Generated by Elitez SEO Audit Tool · ${date}</div>
</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = _auditFilename('html');
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportAuditCSV() {
  if (!allPages.length) return;

  const rows = [
    ['Page URL', 'Path', 'HTTP Status', 'Load Time (ms)', 'Category', 'Severity', 'Check', 'Message', 'How to Fix']
  ];

  for (const page of allPages) {
    const checks = [...(page.checks || []), ...(page.convChecks || [])];
    if (checks.length === 0) {
      rows.push([page.url, page.path || '/', page.status || '', page.responseTimeMs || '', '', '', page.httpError || page.fetchError || '', '', '']);
      continue;
    }
    for (const c of checks) {
      if (c.status === 'info') continue;
      rows.push([
        page.url,
        page.path || '/',
        page.status || '',
        page.responseTimeMs || '',
        c.category || 'Other',
        c.status === 'fail' ? 'Error' : c.status === 'warn' ? 'Warning' : 'Pass',
        c.check,
        c.message,
        c.detail || ''
      ]);
    }
  }

  const csv = rows.map(row =>
    row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = _auditFilename('csv');
  a.click();
  URL.revokeObjectURL(a.href);
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
      if (target === 'agent')     agPopulateSelects();
      if (target === 'blueprint') rbPopulatePageSelect();
      if (target === 'optcycle')  ocInit();
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
// RANK TARGET KEYWORD MODULE
// ══════════════════════════════════════════════════════════════════════════════

const RT_KEY = 'seoRankTarget_v1';

const RT_COUNTRIES = {
  sg: 'Singapore', my: 'Malaysia', id: 'Indonesia', ph: 'Philippines',
  th: 'Thailand',  vn: 'Vietnam',  us: 'USA',       gb: 'UK',
  au: 'Australia', ca: 'Canada',
};

// ── State ─────────────────────────────────────────────────────────────────────

var rtCurrentData      = null;
var rtCurrentDiagnosis = '';
var rtCurrentAutoFix   = '';
var rtCurrentMissionId = null;

// ── Persistence ───────────────────────────────────────────────────────────────

function rtLoad() {
  try { return JSON.parse(localStorage.getItem(RT_KEY)) || []; } catch { return []; }
}

function rtSave(missions) {
  localStorage.setItem(RT_KEY, JSON.stringify(missions));
}

function rtGetMission(id) {
  return rtLoad().find(function(m) { return m.id === id; }) || null;
}

function rtSaveMission(mission) {
  var missions = rtLoad();
  var idx = missions.findIndex(function(m) { return m.id === mission.id; });
  if (idx !== -1) { missions[idx] = mission; } else { missions.unshift(mission); }
  rtSave(missions);
}

function rtDeleteMission(id) {
  rtSave(rtLoad().filter(function(m) { return m.id !== id; }));
}

// ── GSC Lookup (extended) ─────────────────────────────────────────────────────

function rtLookupGsc(keyword, country) {
  var empty = { position: null, page: null, clicks: 0, impressions: 0, ctr: 0 };
  if (!gscRows.length || !gscDims.length) return empty;

  var qIdx  = gscDims.indexOf('query');
  var pgIdx = gscDims.indexOf('page');
  var cIdx  = gscDims.indexOf('country');
  if (qIdx === -1) return empty;

  var norm = keyword.trim().toLowerCase();
  var rows = gscRows.filter(function(r) {
    if ((r.keys && r.keys[qIdx] || '').toLowerCase() !== norm) return false;
    if (country && cIdx !== -1) {
      if ((r.keys && r.keys[cIdx] || '').toLowerCase() !== country.toLowerCase()) return false;
    }
    return true;
  });

  if (!rows.length) return empty;

  var bestRow = rows.reduce(function(best, r) {
    return (r.position || 999) < (best.position || 999) ? r : best;
  }, rows[0]);

  var totClicks = rows.reduce(function(s, r) { return s + (r.clicks || 0); }, 0);
  var totImpr   = rows.reduce(function(s, r) { return s + (r.impressions || 0); }, 0);

  return {
    position:    Math.round(bestRow.position) || null,
    page:        pgIdx !== -1 ? (bestRow.keys && bestRow.keys[pgIdx] || null) : null,
    clicks:      totClicks,
    impressions: totImpr,
    ctr:         totImpr > 0 ? totClicks / totImpr : 0
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rtEsc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rtFmtCtr(ctr) {
  return (Number(ctr) * 100).toFixed(1) + '%';
}

function rtPosCls(pos) {
  if (!pos) return 'rt-pos-none';
  if (pos <= 3)  return 'rt-pos-top';
  if (pos <= 10) return 'rt-pos-good';
  if (pos <= 20) return 'rt-pos-mid';
  return 'rt-pos-low';
}

function rtNormPath(s) {
  try { return new URL(s).pathname.replace(/\/$/, '').toLowerCase(); } catch { return String(s || '').replace(/\/$/, '').toLowerCase(); }
}


// ── GSC Check Renderer ────────────────────────────────────────────────────────

function rtRenderGscCheck(gscData, targetPage) {
  if (!gscRows.length) {
    return '<div class="rt-gsc-notice rt-gsc-warn">⚠️ GSC data not loaded — connect Google Search Console in the Search Performance tab to see live rankings.</div>'
      + '<div class="rt-gsc-no-data">Analysis will proceed using keyword input only. AI diagnosis will still work without live GSC data.</div>';
  }

  var pos    = gscData.position;
  var page   = gscData.page;
  var posCls = rtPosCls(pos);

  var targetMatchHtml = '';
  if (targetPage && page) {
    var match = rtNormPath(page) === rtNormPath(targetPage);
    targetMatchHtml = ' <span class="' + (match ? 'rt-match-yes' : 'rt-match-no') + '">'
      + (match ? '✓ Matches target page' : '✗ Different page is ranking') + '</span>';
  }

  var pageDisp = page ? (rtNormPath(page) || '/') : null;

  var posMsg = '';
  if (!pos) {
    posMsg = '<div class="rt-gsc-msg rt-gsc-msg-warn">Not found in GSC data. The keyword may be ranking beyond position 100, or may have no impressions in the selected period.</div>';
  } else if (pos > 10) {
    posMsg = '<div class="rt-gsc-msg rt-gsc-msg-info">Position ' + pos + ' — outside Page 1. The gap diagnosis below will identify what\'s holding it back.</div>';
  } else {
    posMsg = '<div class="rt-gsc-msg rt-gsc-msg-good">Position ' + pos + ' — already on Page 1! Use the diagnosis to push toward the top 3.</div>';
  }

  return '<div class="rt-gsc-grid">'
    + '<div class="rt-gsc-kpi"><div class="rt-gsc-kpi-val ' + posCls + '">' + (pos ? '#' + pos : 'N/A') + '</div><div class="rt-gsc-kpi-label">Current Position</div></div>'
    + '<div class="rt-gsc-kpi"><div class="rt-gsc-kpi-val">' + (gscData.impressions || 0).toLocaleString() + '</div><div class="rt-gsc-kpi-label">Impressions</div></div>'
    + '<div class="rt-gsc-kpi"><div class="rt-gsc-kpi-val">' + (gscData.clicks || 0).toLocaleString() + '</div><div class="rt-gsc-kpi-label">Clicks</div></div>'
    + '<div class="rt-gsc-kpi"><div class="rt-gsc-kpi-val">' + rtFmtCtr(gscData.ctr) + '</div><div class="rt-gsc-kpi-label">CTR</div></div>'
    + '</div>'
    + (pageDisp
        ? '<div class="rt-gsc-page-row"><span class="rt-gsc-page-label">Ranking page:</span> <a href="' + rtEsc(page) + '" target="_blank" rel="noopener" class="rt-gsc-page-link">' + rtEsc(pageDisp) + '</a>' + targetMatchHtml + '</div>'
        : '<div class="rt-gsc-page-row rt-gsc-page-none">No ranking page found in GSC data for this keyword.</div>')
    + posMsg;
}

// ── AI Output Renderer ────────────────────────────────────────────────────────

function rtRenderAIOutput(md) {
  var html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');

  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, function(_, code) {
    return '<pre class="rt-code-block"><code>' + code + '</code></pre>';
  });

  html = html.replace(/^## (.+)$/gm, '</div><div class="rt-ai-section"><h3 class="rt-ai-h3">$1</h3>');
  html = html.replace(/^### (.+)$/gm, '<h4 class="rt-ai-h4">$1</h4>');

  html = html.replace(/^(🔴|🟡|🟢)\s*(HIGH|MEDIUM|LOW)\s*\|\s*(.+?)\s*\|\s*Impact:\s*(.+?)\s*\|\s*Effort:\s*(.+)$/gm, function(_, emoji, tier, title, impact, effort) {
    var cls = tier === 'HIGH' ? 'rt-act-high' : tier === 'MEDIUM' ? 'rt-act-med' : 'rt-act-low';
    return '<div class="rt-action-block ' + cls + '"><div class="rt-action-hdr">'
      + emoji + ' <span class="rt-action-tier">' + tier + '</span> — ' + title + '</div>'
      + '<div class="rt-action-meta"><span class="rt-meta-badge rt-meta-impact">Impact: ' + rtEsc(impact) + '</span>'
      + '<span class="rt-meta-badge rt-meta-effort">Effort: ' + rtEsc(effort) + '</span></div>';
  });

  html = html.replace(/^[–\-]\s*(Page|Section|Add|Replace|Why|Fix|Current state|Priority):\s*(.*)$/gm, function(_, label, val) {
    if (label === 'Add' || label === 'Replace') {
      return '<div class="rt-action-field rt-action-add"><span class="rt-field-label">' + rtEsc(label) + ':</span> <code class="rt-add-code">' + val + '</code></div>';
    }
    if (label === 'Priority') {
      var pc = val.trim() === 'HIGH' ? 'rt-priority-high' : val.trim() === 'MEDIUM' ? 'rt-priority-med' : 'rt-priority-low';
      return '<div class="rt-action-field"><span class="rt-field-label">' + rtEsc(label) + ':</span> <span class="' + pc + '">' + rtEsc(val) + '</span></div>';
    }
    return '<div class="rt-action-field"><span class="rt-field-label">' + rtEsc(label) + ':</span> ' + val + '</div>';
  });

  html = html.replace(/^[ \t]*[-•]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/^(?!<)(.+)$/gm, '<p>$1</p>');

  html = '<div class="rt-ai-content"><div></div><div>' + html + '</div></div>';
  return html;
}

// ── Analyze ───────────────────────────────────────────────────────────────────

function rtAnalyze() {
  var kwEl   = document.getElementById('rt-kw');
  var ctrEl  = document.getElementById('rt-country');
  var tgtEl  = document.getElementById('rt-target-url');
  var catEl  = document.getElementById('rt-category');
  var compEl = document.getElementById('rt-competitors');
  var errEl  = document.getElementById('rt-input-err');

  var keyword    = (kwEl   && kwEl.value   || '').trim();
  var country    = (ctrEl  && ctrEl.value  || '').trim();
  var targetPage = (tgtEl  && tgtEl.value  || '').trim();
  var category   = (catEl  && catEl.value  || '').trim();
  var compText   = (compEl && compEl.value || '').trim();

  if (!keyword) {
    if (errEl) { errEl.textContent = 'Target keyword is required.'; errEl.style.display = ''; }
    if (kwEl) kwEl.focus();
    return;
  }
  if (errEl) errEl.style.display = 'none';

  var competitors = compText ? compText.split('\n').map(function(s) { return s.trim(); }).filter(Boolean) : [];
  var gscData     = rtLookupGsc(keyword, country);

  rtCurrentData      = { keyword: keyword, country: country, targetPage: targetPage, category: category, competitors: competitors, gscData: gscData };
  rtCurrentDiagnosis = '';
  rtCurrentAutoFix   = '';
  rtCurrentMissionId = null;

  var gscCard = document.getElementById('rt-gsc-card');
  var gscBody = document.getElementById('rt-gsc-body');
  if (gscCard && gscBody) { gscCard.style.display = ''; gscBody.innerHTML = rtRenderGscCheck(gscData, targetPage); }

  var gapCard = document.getElementById('rt-gap-card');
  var gapBody = document.getElementById('rt-gap-body');
  if (gapCard && gapBody) {
    gapCard.style.display = '';
    gapBody.innerHTML = '<div class="rt-ai-hint">Click "Run AI Diagnosis" to analyse why this keyword isn\'t on Page 1 and get a prioritized blueprint.</div>';
    var runBtn = document.getElementById('rt-gap-run-btn');
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '🤖 Run AI Diagnosis'; }
  }

  var fixCard = document.getElementById('rt-fix-card');
  var fixBody = document.getElementById('rt-fix-body');
  if (fixCard && fixBody) {
    fixCard.style.display = '';
    fixBody.innerHTML = '<div class="rt-ai-hint">Generate copy-ready title, meta, H1, FAQ, schema, and GEO answer block for this keyword.</div>';
    var fixBtn = document.getElementById('rt-fix-run-btn');
    if (fixBtn) { fixBtn.disabled = false; fixBtn.textContent = '✍️ Generate Copy-Ready Fixes'; }
  }

  var missionCard = document.getElementById('rt-mission-card');
  var missionBody = document.getElementById('rt-mission-body');
  if (missionCard && missionBody) { missionCard.style.display = ''; missionBody.innerHTML = rtRenderMissionProgress(null); }

  var saveMissionBtn = document.getElementById('rt-save-mission-btn');
  if (saveMissionBtn) saveMissionBtn.textContent = '💾 Save as Mission';

  if (gscCard) gscCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Stream Gap Diagnosis ──────────────────────────────────────────────────────

async function rtStreamDiagnosis() {
  if (!rtCurrentData) return;
  var btn    = document.getElementById('rt-gap-run-btn');
  var bodyEl = document.getElementById('rt-gap-body');
  if (!bodyEl) return;

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyzing…'; }
  bodyEl.innerHTML = '<div class="rt-ai-streaming"><span class="rt-streaming-dot"></span> AI is diagnosing ranking gaps…</div>';

  var cd = rtCurrentData;
  var payload = {
    task:        'rank-gap-diagnosis',
    keyword:     cd.keyword,
    country:     RT_COUNTRIES[cd.country] || cd.country || 'Any',
    targetPage:  cd.targetPage  || '(not specified)',
    category:    cd.category    || '(not specified)',
    competitors: cd.competitors.join('\n') || 'None provided',
    position:    cd.gscData.position,
    rankingPage: cd.gscData.page,
    clicks:      cd.gscData.clicks,
    impressions: cd.gscData.impressions,
    ctr:         cd.gscData.ctr
  };

  try {
    var res = await fetch('/api/agent/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok || !res.body) {
      bodyEl.innerHTML = '<div class="rt-error">⚠️ Request failed. Check your Anthropic API key and server.</div>';
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Run AI Diagnosis'; }
      return;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    rtCurrentDiagnosis = '';
    while (true) {
      var rd = await reader.read();
      if (rd.done) break;
      buffer += decoder.decode(rd.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith('data:')) continue;
        var raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          var d = JSON.parse(raw);
          if (d.type === 'chunk') { rtCurrentDiagnosis += d.text; bodyEl.innerHTML = rtRenderAIOutput(rtCurrentDiagnosis); }
          if (d.type === 'error') {
            bodyEl.innerHTML = '<div class="rt-error">⚠️ ' + rtEsc(d.message || 'AI error') + '</div>';
            if (btn) { btn.disabled = false; btn.textContent = '🤖 Run AI Diagnosis'; }
            return;
          }
        } catch(e) {}
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Re-run Diagnosis'; }
    if (rtCurrentMissionId) {
      var mission = rtGetMission(rtCurrentMissionId);
      if (mission) { mission.lastDiagnosis = rtCurrentDiagnosis; mission.tasks = rtExtractTasks(rtCurrentDiagnosis); rtSaveMission(mission); rtRefreshMissionBody(); }
    }
  } catch(err) {
    bodyEl.innerHTML = '<div class="rt-error">⚠️ Network error: ' + rtEsc(err.message) + '</div>';
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Run AI Diagnosis'; }
  }
}

// ── Stream Auto Fixes ─────────────────────────────────────────────────────────

async function rtStreamAutoFixes() {
  if (!rtCurrentData) return;
  var btn    = document.getElementById('rt-fix-run-btn');
  var bodyEl = document.getElementById('rt-fix-body');
  if (!bodyEl) return;

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
  bodyEl.innerHTML = '<div class="rt-ai-streaming"><span class="rt-streaming-dot"></span> Generating copy-ready fixes…</div>';

  var cd = rtCurrentData;
  var pageTitle = '';
  if (cd.targetPage && allPages.length) {
    var pg = allPages.find(function(p) { return rtNormPath(p.path || p.url || '') === rtNormPath(cd.targetPage); });
    if (pg) pageTitle = pg.title || '';
  }

  var payload = {
    task:       'rank-auto-fixes',
    keyword:    cd.keyword,
    country:    RT_COUNTRIES[cd.country] || cd.country || 'Any',
    targetPage: cd.targetPage || '(not specified)',
    category:   cd.category   || '(not specified)',
    pageTitle:  pageTitle     || '(unknown)',
    position:   cd.gscData.position
  };

  try {
    var res2 = await fetch('/api/agent/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res2.ok || !res2.body) {
      bodyEl.innerHTML = '<div class="rt-error">⚠️ Request failed. Check your Anthropic API key and server.</div>';
      if (btn) { btn.disabled = false; btn.textContent = '✍️ Generate Copy-Ready Fixes'; }
      return;
    }
    var reader2 = res2.body.getReader();
    var decoder2 = new TextDecoder();
    var buffer2 = '';
    rtCurrentAutoFix = '';
    while (true) {
      var rd2 = await reader2.read();
      if (rd2.done) break;
      buffer2 += decoder2.decode(rd2.value, { stream: true });
      var lines2 = buffer2.split('\n');
      buffer2 = lines2.pop();
      for (var j = 0; j < lines2.length; j++) {
        var line2 = lines2[j].trim();
        if (!line2.startsWith('data:')) continue;
        var raw2 = line2.slice(5).trim();
        if (!raw2) continue;
        try {
          var d2 = JSON.parse(raw2);
          if (d2.type === 'chunk') { rtCurrentAutoFix += d2.text; bodyEl.innerHTML = rtRenderAIOutput(rtCurrentAutoFix); }
          if (d2.type === 'error') {
            bodyEl.innerHTML = '<div class="rt-error">⚠️ ' + rtEsc(d2.message || 'AI error') + '</div>';
            if (btn) { btn.disabled = false; btn.textContent = '✍️ Generate Copy-Ready Fixes'; }
            return;
          }
        } catch(e) {}
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Regenerate Fixes'; }
  } catch(err) {
    bodyEl.innerHTML = '<div class="rt-error">⚠️ Network error: ' + rtEsc(err.message) + '</div>';
    if (btn) { btn.disabled = false; btn.textContent = '✍️ Generate Copy-Ready Fixes'; }
  }
}

// ── Extract Tasks ─────────────────────────────────────────────────────────────

function rtExtractTasks(diagnosisText) {
  var tasks = [];
  var lines = diagnosisText.split('\n');
  lines.forEach(function(line) {
    var m = line.match(/^[🔴🟡🟢]\s*(HIGH|MEDIUM|LOW)\s*\|\s*(.+?)\s*\|/);
    if (m) {
      tasks.push({ id: 'rt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), priority: m[1], title: m[2].trim(), done: false });
    }
  });
  return tasks;
}

// ── Mission Progress Renderer (updated with fix tracking + roadmap + export) ──

function rtRenderMissionProgress(mission) {
  if (!mission) {
    return '<div class="rt-mission-empty"><p>No mission saved yet. Run the analysis above, then click "Save as Mission" to track this keyword\'s progress over time.</p></div>';
  }
  var tasks  = mission.tasks || [];
  var done   = tasks.filter(function(t) { return t.done; }).length;
  var total  = tasks.length;
  var pct    = total > 0 ? Math.round(done / total * 100) : 0;
  var status = rtGetMissionStatus(mission);

  var histHtml = '';
  if (mission.history && mission.history.length) {
    var rows = mission.history.slice().reverse().slice(0, 8).map(function(h, i, arr) {
      var prev  = arr[i + 1];
      var delta = (prev && prev.position && h.position) ? prev.position - h.position : 0;
      var arrow = delta > 0 ? '<span class="rt-trend-up">↑' + delta + '</span>'
                : delta < 0 ? '<span class="rt-trend-down">↓' + Math.abs(delta) + '</span>' : '';
      return '<tr><td>' + rtEsc(h.date) + '</td><td><strong>' + (h.position ? '#' + h.position : '—') + '</strong> ' + arrow + '</td>'
        + '<td>' + (h.clicks || 0) + '</td><td>' + (h.impressions || 0) + '</td></tr>';
    }).join('');
    histHtml = '<table class="rt-hist-table"><thead><tr><th>Date</th><th>Position</th><th>Clicks</th><th>Impr.</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } else {
    histHtml = '<p class="rt-mission-empty-sub">No history yet — click "📸 Record Position" to save today\'s GSC data.</p>';
  }

  var tasksHtml = '';
  if (tasks.length) {
    tasksHtml = tasks.map(function(t) {
      var pCls = t.priority === 'HIGH' ? 'rt-tier-high' : t.priority === 'MEDIUM' ? 'rt-tier-med' : 'rt-tier-low';
      return '<label class="rt-task-row' + (t.done ? ' rt-task-done' : '') + '">'
        + '<input type="checkbox" class="rt-task-check" data-task-id="' + rtEsc(t.id) + '"' + (t.done ? ' checked' : '') + '/>'
        + '<span class="rt-task-tier ' + pCls + '">' + rtEsc(t.priority) + '</span>'
        + '<span class="rt-task-title">' + rtEsc(t.title) + '</span></label>';
    }).join('');
  } else {
    tasksHtml = '<p class="rt-mission-empty-sub">Run AI Diagnosis to generate action tasks for this mission.</p>';
  }

  return '<div class="rt-mission-wrap">'
    + '<div class="rt-mission-meta">'
    + '<div class="rt-mission-kw">' + rtEsc(mission.keyword) + '</div>'
    + (mission.targetPage ? '<div class="rt-mission-page">Target: ' + rtEsc(mission.targetPage) + '</div>' : '')
    + '<span class="rt-status-badge ' + status.cls + '">' + status.label + '</span>'
    + '<div class="rt-mission-date">Saved: ' + rtEsc(mission.createdAt) + '</div>'
    + '</div>'
    + '<div class="rt-mission-progress-bar-wrap"><div class="rt-mission-progress-bar" style="width:' + pct + '%"></div></div>'
    + '<div class="rt-mission-progress-label">' + done + ' / ' + total + ' tasks done (' + pct + '%)</div>'

    // Two-column: history + tasks
    + '<div class="rt-mission-cols">'
    + '<div class="rt-mission-col"><div class="rt-mission-col-hd">Position History</div>'
    + '<div class="rt-mission-toolbar"><button id="rt-snapshot-btn" class="btn-ghost rt-sm-btn">📸 Record Position</button></div>'
    + histHtml + '</div>'
    + '<div class="rt-mission-col"><div class="rt-mission-col-hd">Action Tasks</div>'
    + '<div class="rt-task-list">' + tasksHtml + '</div></div>'
    + '</div>'

    // Fix completion tracking
    + rtRenderFixTracking(mission)

    // 30/60/90 roadmap
    + rtRenderRoadmap(mission)

    // Export
    + '<div class="rt-export-bar">'
    + '<span class="rt-export-label">Export Report:</span>'
    + '<button class="btn-ghost rt-sm-btn rt-export-mission-btn" data-format="html">⬇ HTML</button>'
    + '<button class="btn-ghost rt-sm-btn rt-export-mission-btn" data-format="md">⬇ Markdown</button>'
    + '</div>'
    + '</div>';
}

// ── Save / Update Mission ─────────────────────────────────────────────────────

function rtSaveAsMission() {
  if (!rtCurrentData) return;
  var today = new Date().toISOString().slice(0, 10);
  var cd    = rtCurrentData;
  var mission;

  if (rtCurrentMissionId) {
    mission = rtGetMission(rtCurrentMissionId) || {};
  } else {
    mission = {
      id: Date.now(), keyword: cd.keyword, country: cd.country,
      targetPage: cd.targetPage, category: cd.category, competitors: cd.competitors,
      createdAt: today, history: [], tasks: [],
      fixChecks: { title_meta: false, h1: false, intro: false, faq: false, links: false, schema: false, geo: false },
      roadmap: { day30: '', day60: '', day90: '' }
    };
    rtCurrentMissionId = mission.id;
  }

  // Ensure new fields exist on older missions
  if (!mission.fixChecks) mission.fixChecks = { title_meta: false, h1: false, intro: false, faq: false, links: false, schema: false, geo: false };
  if (!mission.roadmap)   mission.roadmap   = { day30: '', day60: '', day90: '' };

  mission.keyword       = cd.keyword;
  mission.targetPage    = cd.targetPage;
  mission.category      = cd.category;
  mission.competitors   = cd.competitors;
  mission.lastDiagnosis = rtCurrentDiagnosis || mission.lastDiagnosis || '';
  mission.lastAutoFix   = rtCurrentAutoFix   || mission.lastAutoFix   || '';
  if (rtCurrentDiagnosis) mission.tasks = rtExtractTasks(rtCurrentDiagnosis);

  if (cd.gscData.position) {
    if (!mission.history) mission.history = [];
    var existing = mission.history.find(function(h) { return h.date === today; });
    if (existing) {
      existing.position = cd.gscData.position; existing.page = cd.gscData.page;
      existing.clicks = cd.gscData.clicks; existing.impressions = cd.gscData.impressions;
    } else {
      mission.history.push({ date: today, position: cd.gscData.position, page: cd.gscData.page, clicks: cd.gscData.clicks, impressions: cd.gscData.impressions });
    }
  }

  rtSaveMission(mission);
  rtRefreshMissionBody();
  var btn = document.getElementById('rt-save-mission-btn');
  if (btn) { btn.textContent = '✓ Mission Saved'; setTimeout(function() { btn.textContent = '💾 Update Mission'; }, 2000); }
}

function rtSnapshotPosition() {
  if (!rtCurrentData || !rtCurrentMissionId) return;
  var mission = rtGetMission(rtCurrentMissionId);
  if (!mission) return;
  var today   = new Date().toISOString().slice(0, 10);
  var gscData = rtLookupGsc(rtCurrentData.keyword, rtCurrentData.country);
  rtCurrentData.gscData = gscData;
  if (!mission.history) mission.history = [];
  var existing = mission.history.find(function(h) { return h.date === today; });
  if (existing) {
    existing.position = gscData.position; existing.page = gscData.page;
    existing.clicks = gscData.clicks; existing.impressions = gscData.impressions;
  } else {
    mission.history.push({ date: today, position: gscData.position, page: gscData.page, clicks: gscData.clicks, impressions: gscData.impressions });
  }
  rtSaveMission(mission);
  rtRefreshMissionBody();
}

function rtRefreshMissionBody() {
  var missionBody = document.getElementById('rt-mission-body');
  if (!missionBody || !rtCurrentMissionId) return;
  var mission = rtGetMission(rtCurrentMissionId);
  missionBody.innerHTML = rtRenderMissionProgress(mission);
  rtBindTaskChecks();
  rtBindSnapshotBtn();
  rtBindFixChecks();
  rtBindRoadmapFields();
  rtBindRoadmapGenerateBtn();
  rtBindExportBtns();
}

function rtBindTaskChecks() {
  document.querySelectorAll('.rt-task-check').forEach(function(cb) {
    cb.addEventListener('change', function() {
      if (!rtCurrentMissionId) return;
      var mission = rtGetMission(rtCurrentMissionId);
      if (!mission) return;
      var task = (mission.tasks || []).find(function(t) { return t.id === cb.dataset.taskId; });
      if (task) {
        task.done = cb.checked;
        rtSaveMission(mission);
        var row = cb.closest('.rt-task-row');
        if (row) row.classList.toggle('rt-task-done', cb.checked);
      }
    });
  });
}

function rtBindSnapshotBtn() {
  var btn = document.getElementById('rt-snapshot-btn');
  if (!btn) return;
  btn.addEventListener('click', function() {
    rtSnapshotPosition();
    btn.textContent = '✓ Recorded';
    setTimeout(function() { btn.textContent = '📸 Record Position'; }, 2000);
  });
}

function rtBindFixChecks() {
  document.querySelectorAll('.rt-fix-check').forEach(function(cb) {
    cb.addEventListener('change', function() {
      rtToggleFixCheck(cb.dataset.fixKey, cb.checked);
      var row = cb.closest('.rt-fix-item');
      if (row) row.classList.toggle('rt-fix-done', cb.checked);
    });
  });
}

function rtBindRoadmapFields() {
  document.querySelectorAll('.rt-roadmap-textarea').forEach(function(ta) {
    ta.addEventListener('blur', function() { rtSaveRoadmapField(ta.dataset.day, ta.value); });
  });
}

function rtBindRoadmapGenerateBtn() {
  var btn = document.getElementById('rt-roadmap-generate-btn');
  if (btn) btn.addEventListener('click', rtStreamRoadmap);
}

function rtBindExportBtns() {
  document.querySelectorAll('.rt-export-mission-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (rtCurrentMissionId) rtExportMission(rtCurrentMissionId, btn.dataset.format);
    });
  });
}

// ── Mission Status ────────────────────────────────────────────────────────────

function rtGetMissionStatus(mission) {
  var history = mission.history || [];
  if (!history.length) return { label: 'Not Ranking', cls: 'rt-status-none' };

  var latest = history[history.length - 1];
  var prev   = history.length > 1 ? history[history.length - 2] : null;

  if (!latest.position) return { label: 'Not Ranking', cls: 'rt-status-none' };

  // Wrong page check
  if (mission.targetPage && latest.page && rtNormPath(latest.page) !== rtNormPath(mission.targetPage)) {
    return { label: 'Wrong Page', cls: 'rt-status-wrong' };
  }

  var delta = (prev && prev.position && latest.position) ? prev.position - latest.position : 0;

  if (latest.position <= 3) {
    return { label: delta > 0 ? 'Top 3 ↑' : 'Top 3', cls: 'rt-status-top3' };
  }
  if (latest.position <= 10) {
    if (delta > 0) return { label: 'Page 1 ↑', cls: 'rt-status-p1-up' };
    if (delta < 0) return { label: 'Page 1 ↓', cls: 'rt-status-p1-dn' };
    return { label: 'Page 1', cls: 'rt-status-p1' };
  }
  if (latest.position <= 20) {
    if (delta > 0) return { label: 'Page 2 ↑', cls: 'rt-status-improving' };
    if (delta < 0) return { label: 'Page 2 ↓', cls: 'rt-status-dropping' };
    return { label: 'Page 2', cls: 'rt-status-p2' };
  }
  if (delta > 0) return { label: 'Improving ↑', cls: 'rt-status-improving' };
  if (delta < 0) return { label: 'Dropping ↓', cls: 'rt-status-dropping' };
  return { label: 'Pos ' + latest.position, cls: 'rt-status-p3' };
}

function rtCalcProgress(mission) {
  var tasks = mission.tasks || [];
  if (!tasks.length) return 0;
  return Math.round(tasks.filter(function(t) { return t.done; }).length / tasks.length * 100);
}

// ── Fix Completion Tracking ───────────────────────────────────────────────────

var RT_FIX_LABELS = {
  title_meta: 'Title & Meta updated',
  h1:         'H1 tag updated',
  intro:      'Intro paragraph updated',
  faq:        'FAQ section added',
  links:      'Internal links added',
  schema:     'Schema markup added',
  geo:        'GEO answer block added'
};

function rtRenderFixTracking(mission) {
  var checks = mission.fixChecks || {};
  var done   = Object.keys(RT_FIX_LABELS).filter(function(k) { return checks[k]; }).length;
  var total  = Object.keys(RT_FIX_LABELS).length;

  return '<div class="rt-fix-section">'
    + '<div class="rt-fix-hd">Fix Completion <span class="rt-fix-count">' + done + '/' + total + '</span></div>'
    + '<div class="rt-fix-grid">'
    + Object.keys(RT_FIX_LABELS).map(function(key) {
        var checked = checks[key] || false;
        return '<label class="rt-fix-item' + (checked ? ' rt-fix-done' : '') + '">'
          + '<input type="checkbox" class="rt-fix-check" data-fix-key="' + key + '"' + (checked ? ' checked' : '') + '/>'
          + '<span class="rt-fix-label">' + RT_FIX_LABELS[key] + '</span>'
          + '</label>';
      }).join('')
    + '</div></div>';
}

function rtToggleFixCheck(fixKey, checked) {
  if (!rtCurrentMissionId) return;
  var mission = rtGetMission(rtCurrentMissionId);
  if (!mission) return;
  if (!mission.fixChecks) mission.fixChecks = {};
  mission.fixChecks[fixKey] = checked;
  rtSaveMission(mission);
  var countEl = document.querySelector('.rt-fix-count');
  if (countEl) {
    var done = Object.keys(RT_FIX_LABELS).filter(function(k) { return mission.fixChecks[k]; }).length;
    countEl.textContent = done + '/' + Object.keys(RT_FIX_LABELS).length;
  }
}

// ── 30/60/90 Roadmap ─────────────────────────────────────────────────────────

function rtRenderRoadmap(mission) {
  var roadmap = mission.roadmap || {};
  return '<div class="rt-roadmap-section">'
    + '<div class="rt-roadmap-hd">'
    + '<span>📅 30/60/90-Day Roadmap</span>'
    + '<button id="rt-roadmap-generate-btn" class="rt-run-btn">🤖 Generate Roadmap</button>'
    + '</div>'
    + '<div class="rt-roadmap-days">'
    + ['30', '60', '90'].map(function(day) {
        return '<div class="rt-roadmap-day">'
          + '<div class="rt-roadmap-day-hd">Day ' + day + ' Goal</div>'
          + '<textarea class="rt-roadmap-textarea" data-day="' + day
          + '" placeholder="What should be done by day ' + day + '…" rows="5">'
          + rtEsc(roadmap['day' + day] || '') + '</textarea>'
          + '</div>';
      }).join('')
    + '</div></div>';
}

function rtSaveRoadmapField(day, value) {
  if (!rtCurrentMissionId) return;
  var mission = rtGetMission(rtCurrentMissionId);
  if (!mission) return;
  if (!mission.roadmap) mission.roadmap = {};
  mission.roadmap['day' + day] = value;
  rtSaveMission(mission);
}

async function rtStreamRoadmap() {
  if (!rtCurrentData || !rtCurrentMissionId) return;
  var btn     = document.getElementById('rt-roadmap-generate-btn');
  var mission = rtGetMission(rtCurrentMissionId);
  if (!mission) return;

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }

  var pendingTasks = (mission.tasks || []).filter(function(t) { return !t.done; }).slice(0, 8)
    .map(function(t) { return t.priority + ': ' + t.title; }).join('\n');

  var statusObj = rtGetMissionStatus(mission);
  var payload = {
    task:        'rank-roadmap',
    keyword:     rtCurrentData.keyword,
    country:     RT_COUNTRIES[rtCurrentData.country] || rtCurrentData.country || 'Any',
    targetPage:  rtCurrentData.targetPage || '(not specified)',
    category:    rtCurrentData.category   || '(not specified)',
    position:    rtCurrentData.gscData.position,
    status:      statusObj ? statusObj.label : 'Unknown',
    pendingTasks: pendingTasks || 'None yet — run AI Diagnosis first'
  };

  try {
    var res = await fetch('/api/agent/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok || !res.body) {
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Generate Roadmap'; }
      return;
    }

    var reader  = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer  = '';
    var fullText = '';

    while (true) {
      var rd = await reader.read();
      if (rd.done) break;
      buffer += decoder.decode(rd.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith('data:')) continue;
        var raw = line.slice(5).trim();
        if (!raw) continue;
        try { var d = JSON.parse(raw); if (d.type === 'chunk') fullText += d.text; } catch(e) {}
      }
    }

    // Parse sections
    var d30 = (fullText.match(/##\s*Day 30[\s\S]*?\n([\s\S]+?)(?=##\s*Day 60|$)/i) || ['',''])[1].trim();
    var d60 = (fullText.match(/##\s*Day 60[\s\S]*?\n([\s\S]+?)(?=##\s*Day 90|$)/i) || ['',''])[1].trim();
    var d90 = (fullText.match(/##\s*Day 90[\s\S]*?\n([\s\S]+?)$/i) || ['',''])[1].trim();

    mission.roadmap = { day30: d30, day60: d60, day90: d90 };
    rtSaveMission(mission);

    var ta30 = document.querySelector('.rt-roadmap-textarea[data-day="30"]');
    var ta60 = document.querySelector('.rt-roadmap-textarea[data-day="60"]');
    var ta90 = document.querySelector('.rt-roadmap-textarea[data-day="90"]');
    if (ta30) ta30.value = d30;
    if (ta60) ta60.value = d60;
    if (ta90) ta90.value = d90;

    if (btn) { btn.disabled = false; btn.textContent = '🔄 Regenerate'; }
  } catch(err) {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Generate Roadmap'; }
  }
}

// ── Mission Dashboard ─────────────────────────────────────────────────────────

function rtRenderDashboard() {
  var panel = document.getElementById('rt-missions-panel');
  var list  = document.getElementById('rt-missions-list');
  if (!panel || !list) return;

  var missions = rtLoad();
  var sortEl   = document.getElementById('rt-dash-sort');
  var sort     = sortEl ? sortEl.value : 'date';

  missions.sort(function(a, b) {
    if (sort === 'position') {
      var ap = (a.history && a.history.length) ? (a.history[a.history.length - 1].position || 999) : 999;
      var bp = (b.history && b.history.length) ? (b.history[b.history.length - 1].position || 999) : 999;
      return ap - bp;
    }
    if (sort === 'progress') return rtCalcProgress(b) - rtCalcProgress(a);
    if (sort === 'status') {
      var order = { 'rt-status-top3': 0, 'rt-status-p1-up': 1, 'rt-status-p1': 2, 'rt-status-p1-dn': 3, 'rt-status-improving': 4, 'rt-status-p2': 5, 'rt-status-p3': 6, 'rt-status-dropping': 7, 'rt-status-wrong': 8, 'rt-status-none': 9 };
      var ao = order[rtGetMissionStatus(a).cls] || 9;
      var bo = order[rtGetMissionStatus(b).cls] || 9;
      return ao - bo;
    }
    return (b.id || 0) - (a.id || 0);  // date desc
  });

  var hdrSpan = panel.querySelector('.rt-missions-hd span');
  if (hdrSpan) hdrSpan.textContent = '📊 Mission Dashboard — ' + missions.length + ' keyword' + (missions.length !== 1 ? 's' : '');

  if (!missions.length) {
    list.innerHTML = '<div class="rt-dash-controls"></div><div class="rt-missions-empty">No saved missions yet. Analyse a keyword and click "Save as Mission" to start tracking.</div>';
    panel.style.display = '';
    rtRebindDashboardSort(sort);
    return;
  }

  var rows = missions.map(function(m) {
    var status  = rtGetMissionStatus(m);
    var pct     = rtCalcProgress(m);
    var latest  = m.history && m.history.length ? m.history[m.history.length - 1] : null;
    var pos     = latest && latest.position ? '#' + latest.position : '—';
    var updated = latest ? latest.date : m.createdAt;
    var fixes   = m.fixChecks || {};
    var fixDone = Object.keys(RT_FIX_LABELS).filter(function(k) { return fixes[k]; }).length;

    return '<div class="rt-dash-row">'
      + '<div class="rt-dash-row-main">'
      + '<div class="rt-dash-row-top">'
      + '<span class="rt-dash-kw">' + rtEsc(m.keyword) + '</span>'
      + '<span class="rt-status-badge ' + status.cls + '">' + status.label + '</span>'
      + '</div>'
      + (m.targetPage ? '<div class="rt-dash-page">' + rtEsc(m.targetPage) + '</div>' : '')
      + '<div class="rt-dash-meta">'
      + '<span>Pos: <strong>' + pos + '</strong></span>'
      + '<span>Tasks: ' + pct + '%</span>'
      + '<span>Fixes: ' + fixDone + '/' + Object.keys(RT_FIX_LABELS).length + '</span>'
      + '<span class="rt-dash-upd">Updated: ' + rtEsc(updated) + '</span>'
      + '</div>'
      + '<div class="rt-dash-progress-wrap"><div class="rt-dash-progress-bar" style="width:' + pct + '%"></div></div>'
      + '</div>'
      + '<div class="rt-dash-actions">'
      + '<button class="btn-ghost rt-sm-btn rt-mi-load-btn" data-id="' + m.id + '">▶ Load</button>'
      + '<button class="btn-ghost rt-sm-btn rt-mi-export-btn" data-id="' + m.id + '">⬇ Export</button>'
      + '<button class="rt-sm-btn rt-mi-delete-btn" data-id="' + m.id + '" title="Delete">✕</button>'
      + '</div>'
      + '</div>';
  }).join('');

  list.innerHTML = '<div class="rt-dash-controls"></div>' + rows;
  panel.style.display = '';
  rtRebindDashboardSort(sort);

  list.querySelectorAll('.rt-mi-load-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { rtLoadMission(Number(btn.dataset.id)); panel.style.display = 'none'; });
  });
  list.querySelectorAll('.rt-mi-export-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { rtShowExportMenu(Number(btn.dataset.id), btn); });
  });
  list.querySelectorAll('.rt-mi-delete-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (confirm('Delete this Ranking Mission?')) { rtDeleteMission(Number(btn.dataset.id)); rtRenderDashboard(); }
    });
  });
}

function rtRebindDashboardSort(currentSort) {
  var ctrl = document.querySelector('.rt-dash-controls');
  if (!ctrl) return;
  ctrl.innerHTML = '<label class="rt-dash-sort-label">Sort by:</label>'
    + '<select id="rt-dash-sort" class="rt-dash-sort-sel">'
    + '<option value="date"' + (currentSort === 'date' ? ' selected' : '') + '>Last Added</option>'
    + '<option value="position"' + (currentSort === 'position' ? ' selected' : '') + '>Current Position</option>'
    + '<option value="progress"' + (currentSort === 'progress' ? ' selected' : '') + '>Progress %</option>'
    + '<option value="status"' + (currentSort === 'status' ? ' selected' : '') + '>Status</option>'
    + '</select>';
  var sel = document.getElementById('rt-dash-sort');
  if (sel) sel.addEventListener('change', rtRenderDashboard);
}

function rtShowExportMenu(id, anchorBtn) {
  document.querySelectorAll('.rt-export-menu').forEach(function(m) { m.remove(); });
  var menu = document.createElement('div');
  menu.className = 'rt-export-menu';
  menu.innerHTML = '<button class="rt-export-opt" data-format="html">HTML Report</button>'
    + '<button class="rt-export-opt" data-format="md">Markdown Report</button>';
  anchorBtn.parentNode.style.position = 'relative';
  anchorBtn.parentNode.appendChild(menu);
  menu.querySelectorAll('.rt-export-opt').forEach(function(btn) {
    btn.addEventListener('click', function() { rtExportMission(id, btn.dataset.format); menu.remove(); });
  });
  setTimeout(function() {
    document.addEventListener('click', function handler(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', handler); }
    });
  }, 100);
}

// ── Export ────────────────────────────────────────────────────────────────────

function rtExportMission(id, format) {
  var mission = rtGetMission(id);
  if (!mission) return;
  var content, filename, mimeType;
  if (format === 'html') {
    content  = rtBuildMissionHTML(mission);
    filename = 'ranking-mission-' + mission.keyword.replace(/\s+/g, '-').toLowerCase() + '.html';
    mimeType = 'text/html';
  } else {
    content  = rtBuildMissionMarkdown(mission);
    filename = 'ranking-mission-' + mission.keyword.replace(/\s+/g, '-').toLowerCase() + '.md';
    mimeType = 'text/markdown';
  }
  var blob = new Blob([content], { type: mimeType });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function rtBuildMissionMarkdown(mission) {
  var status = rtGetMissionStatus(mission);
  var pct    = rtCalcProgress(mission);
  var lines  = [];

  lines.push('# Ranking Mission Report: ' + mission.keyword);
  lines.push('');
  lines.push('**Generated:** ' + new Date().toISOString().slice(0, 10));
  lines.push('**Status:** ' + status.label);
  lines.push('**Target Page:** ' + (mission.targetPage || 'Not specified'));
  lines.push('**Category:** ' + (mission.category || 'Not specified'));
  lines.push('**Task Progress:** ' + pct + '% complete');
  lines.push('');

  if (mission.history && mission.history.length) {
    lines.push('## Position History');
    lines.push('');
    lines.push('| Date | Position | Clicks | Impressions |');
    lines.push('|------|----------|--------|-------------|');
    mission.history.slice().reverse().forEach(function(h) {
      lines.push('| ' + h.date + ' | ' + (h.position ? '#' + h.position : '—') + ' | ' + (h.clicks || 0) + ' | ' + (h.impressions || 0) + ' |');
    });
    lines.push('');
  }

  var rm = mission.roadmap || {};
  if (rm.day30 || rm.day60 || rm.day90) {
    lines.push('## 30/60/90-Day Roadmap');
    lines.push('');
    if (rm.day30) { lines.push('### Day 30'); lines.push(rm.day30); lines.push(''); }
    if (rm.day60) { lines.push('### Day 60'); lines.push(rm.day60); lines.push(''); }
    if (rm.day90) { lines.push('### Day 90'); lines.push(rm.day90); lines.push(''); }
  }

  var checks = mission.fixChecks || {};
  lines.push('## Fix Implementation');
  lines.push('');
  Object.keys(RT_FIX_LABELS).forEach(function(k) {
    lines.push('- [' + (checks[k] ? 'x' : ' ') + '] ' + RT_FIX_LABELS[k]);
  });
  lines.push('');

  if (mission.tasks && mission.tasks.length) {
    lines.push('## Action Tasks');
    lines.push('');
    mission.tasks.forEach(function(t) {
      lines.push('- [' + (t.done ? 'x' : ' ') + '] **' + t.priority + '** — ' + t.title);
    });
    lines.push('');
  }

  if (mission.lastDiagnosis) {
    lines.push('## Ranking Gap Diagnosis & Blueprint');
    lines.push('');
    lines.push(mission.lastDiagnosis);
    lines.push('');
  }

  if (mission.lastAutoFix) {
    lines.push('## Auto Fix Suggestions');
    lines.push('');
    lines.push(mission.lastAutoFix);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by SEO Audit Tool*');
  return lines.join('\n');
}

function rtBuildMissionHTML(mission) {
  var status = rtGetMissionStatus(mission);
  var pct    = rtCalcProgress(mission);
  var checks = mission.fixChecks || {};
  var rm     = mission.roadmap   || {};

  var statusColor = {
    'rt-status-top3': '#16a34a', 'rt-status-p1-up': '#16a34a', 'rt-status-p1': '#2563eb',
    'rt-status-p1-dn': '#d97706', 'rt-status-improving': '#16a34a', 'rt-status-p2': '#d97706',
    'rt-status-dropping': '#dc2626', 'rt-status-wrong': '#dc2626',
    'rt-status-p3': '#dc2626', 'rt-status-none': '#94a3b8'
  }[status.cls] || '#64748b';

  var css = 'body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:24px;color:#0f172a;line-height:1.65}'
    + 'h1{font-size:26px;font-weight:800;border-bottom:3px solid #2563eb;padding-bottom:10px}'
    + 'h2{font-size:18px;font-weight:700;margin-top:32px;color:#1e40af;border-bottom:1px solid #e2e8f0;padding-bottom:6px}'
    + 'h3{font-size:15px;font-weight:700;margin-top:16px}'
    + 'table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}'
    + 'th,td{padding:8px 12px;border:1px solid #e2e8f0;text-align:left}'
    + 'th{background:#f8fafc;font-weight:700;font-size:12px;color:#64748b}'
    + '.meta-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:16px 0}'
    + '.meta-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px}'
    + '.meta-label{font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.5px}'
    + '.meta-val{font-size:16px;font-weight:700;color:#0f172a;margin-top:4px}'
    + '.status-badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:13px;font-weight:700;background:#f0fdf4;color:' + statusColor + '}'
    + '.progress-bar{height:8px;background:#e2e8f0;border-radius:4px;margin:8px 0}'
    + '.progress-fill{height:100%;background:#2563eb;border-radius:4px}'
    + '.roadmap-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin:16px 0}'
    + '.roadmap-col{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px}'
    + '.roadmap-col h3{margin-top:0;color:#1e40af;font-size:14px}'
    + '.fix-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}'
    + '.fix-item{padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;display:flex;align-items:center;gap:8px}'
    + '.fix-done{background:#f0fdf4;border-color:#86efac}'
    + '.task{padding:8px 14px;border-left:3px solid #e2e8f0;margin:4px 0;font-size:14px;border-radius:0 6px 6px 0}'
    + '.task-HIGH{border-color:#dc2626}.task-MEDIUM{border-color:#f59e0b}.task-LOW{border-color:#16a34a}'
    + '.task-done{opacity:.55;text-decoration:line-through}'
    + 'pre{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;overflow-x:auto;font-size:13px;white-space:pre-wrap}'
    + 'code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}'
    + '.footer{margin-top:48px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center}';

  var body = '<h1>🎯 Ranking Mission: ' + mission.keyword + '</h1>'
    + '<div class="meta-grid">'
    + '<div class="meta-card"><div class="meta-label">Status</div><div class="meta-val"><span class="status-badge">' + status.label + '</span></div></div>'
    + '<div class="meta-card"><div class="meta-label">Target Page</div><div class="meta-val">' + rtEsc(mission.targetPage || 'Not specified') + '</div></div>'
    + '<div class="meta-card"><div class="meta-label">Category</div><div class="meta-val">' + rtEsc(mission.category || 'Not specified') + '</div></div>'
    + '</div>'
    + '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>'
    + '<p style="font-size:13px;color:#64748b;margin:4px 0 0">' + pct + '% of action tasks completed</p>';

  // Position history
  if (mission.history && mission.history.length) {
    body += '<h2>Position History</h2><table><thead><tr><th>Date</th><th>Position</th><th>Clicks</th><th>Impressions</th></tr></thead><tbody>'
      + mission.history.slice().reverse().map(function(h) {
          return '<tr><td>' + h.date + '</td><td><strong>' + (h.position ? '#' + h.position : '—') + '</strong></td><td>' + (h.clicks || 0) + '</td><td>' + (h.impressions || 0) + '</td></tr>';
        }).join('')
      + '</tbody></table>';
  }

  // Roadmap
  if (rm.day30 || rm.day60 || rm.day90) {
    body += '<h2>30/60/90-Day Roadmap</h2><div class="roadmap-grid">'
      + ['30','60','90'].map(function(d) {
          return '<div class="roadmap-col"><h3>Day ' + d + ' Goal</h3><p>' + rtEsc(rm['day'+d] || '—').replace(/\n/g, '<br>') + '</p></div>';
        }).join('')
      + '</div>';
  }

  // Fix tracking
  body += '<h2>Fix Implementation</h2><div class="fix-grid">'
    + Object.keys(RT_FIX_LABELS).map(function(k) {
        var done = checks[k];
        return '<div class="fix-item' + (done ? ' fix-done' : '') + '">'
          + (done ? '✅' : '⬜') + ' ' + RT_FIX_LABELS[k] + '</div>';
      }).join('')
    + '</div>';

  // Tasks
  if (mission.tasks && mission.tasks.length) {
    body += '<h2>Action Tasks</h2>'
      + mission.tasks.map(function(t) {
          var cls = 'task task-' + t.priority + (t.done ? ' task-done' : '');
          return '<div class="' + cls + '">' + (t.done ? '✅ ' : '⬜ ') + '<strong>' + rtEsc(t.priority) + '</strong> — ' + rtEsc(t.title) + '</div>';
        }).join('');
  }

  // Diagnosis (render safely)
  if (mission.lastDiagnosis) {
    var diagHtml = mission.lastDiagnosis
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/^## (.+)$/gm,'<h3>$1</h3>')
      .replace(/^### (.+)$/gm,'<h4>$1</h4>')
      .replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>');
    body += '<h2>Ranking Gap Diagnosis &amp; Blueprint</h2><div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:14px;line-height:1.7"><p>' + diagHtml + '</p></div>';
  }

  // Auto fixes
  if (mission.lastAutoFix) {
    var fixHtml = mission.lastAutoFix
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/^## (.+)$/gm,'<h3>$1</h3>')
      .replace(/```[\w]*\n([\s\S]*?)```/g,'<pre>$1</pre>')
      .replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>');
    body += '<h2>Auto Fix Suggestions</h2><div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:14px;line-height:1.7"><p>' + fixHtml + '</p></div>';
  }

  body += '<div class="footer">Generated by SEO Audit Tool · ' + new Date().toISOString().slice(0, 10) + '</div>';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ranking Mission: ' + mission.keyword + '</title><style>' + css + '</style></head><body>' + body + '</body></html>';
}

// ── Load Mission (updated to bind new listeners) ──────────────────────────────

function rtLoadMission(id) {
  var mission = rtGetMission(id);
  if (!mission) return;

  var kwEl   = document.getElementById('rt-kw');
  var ctrEl  = document.getElementById('rt-country');
  var tgtEl  = document.getElementById('rt-target-url');
  var catEl  = document.getElementById('rt-category');
  var compEl = document.getElementById('rt-competitors');
  if (kwEl)   kwEl.value   = mission.keyword    || '';
  if (ctrEl)  ctrEl.value  = mission.country    || '';
  if (tgtEl)  tgtEl.value  = mission.targetPage || '';
  if (catEl)  catEl.value  = mission.category   || '';
  if (compEl) compEl.value = (mission.competitors || []).join('\n');

  var gscData = rtLookupGsc(mission.keyword, mission.country);
  rtCurrentData = { keyword: mission.keyword, country: mission.country, targetPage: mission.targetPage, category: mission.category, competitors: mission.competitors || [], gscData: gscData };
  rtCurrentDiagnosis = mission.lastDiagnosis || '';
  rtCurrentAutoFix   = mission.lastAutoFix   || '';
  rtCurrentMissionId = mission.id;

  var gscCard = document.getElementById('rt-gsc-card');
  var gscBody = document.getElementById('rt-gsc-body');
  if (gscCard && gscBody) { gscCard.style.display = ''; gscBody.innerHTML = rtRenderGscCheck(gscData, mission.targetPage); }

  var gapCard = document.getElementById('rt-gap-card');
  var gapBody = document.getElementById('rt-gap-body');
  if (gapCard && gapBody) {
    gapCard.style.display = '';
    gapBody.innerHTML = rtCurrentDiagnosis ? rtRenderAIOutput(rtCurrentDiagnosis) : '<div class="rt-ai-hint">Click "Run AI Diagnosis" to analyse this keyword.</div>';
    var runBtn = document.getElementById('rt-gap-run-btn');
    if (runBtn) runBtn.textContent = rtCurrentDiagnosis ? '🔄 Re-run Diagnosis' : '🤖 Run AI Diagnosis';
  }

  var fixCard = document.getElementById('rt-fix-card');
  var fixBody = document.getElementById('rt-fix-body');
  if (fixCard && fixBody) {
    fixCard.style.display = '';
    fixBody.innerHTML = rtCurrentAutoFix ? rtRenderAIOutput(rtCurrentAutoFix) : '<div class="rt-ai-hint">Generate copy-ready fixes for this keyword.</div>';
    var fixBtn = document.getElementById('rt-fix-run-btn');
    if (fixBtn) fixBtn.textContent = rtCurrentAutoFix ? '🔄 Regenerate Fixes' : '✍️ Generate Copy-Ready Fixes';
  }

  var missionCard = document.getElementById('rt-mission-card');
  var missionBody = document.getElementById('rt-mission-body');
  if (missionCard && missionBody) {
    missionCard.style.display = '';
    missionBody.innerHTML = rtRenderMissionProgress(mission);
    rtBindTaskChecks();
    rtBindSnapshotBtn();
    rtBindFixChecks();
    rtBindRoadmapFields();
    rtBindRoadmapGenerateBtn();
    rtBindExportBtns();
  }

  var saveMissionBtn = document.getElementById('rt-save-mission-btn');
  if (saveMissionBtn) saveMissionBtn.textContent = '💾 Update Mission';

  var inputCard = document.getElementById('rt-input-card');
  if (inputCard) inputCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Init ──────────────────────────────────────────────────────────────────────

(function initRtTracker() {
  var analyzeBtn       = document.getElementById('rt-analyze-btn');
  var gapRunBtn        = document.getElementById('rt-gap-run-btn');
  var fixRunBtn        = document.getElementById('rt-fix-run-btn');
  var saveMissionBtn   = document.getElementById('rt-save-mission-btn');
  var kwInput          = document.getElementById('rt-kw');
  var missionsBtn      = document.getElementById('rt-missions-btn');
  var missionsCloseBtn = document.getElementById('rt-missions-close-btn');

  if (analyzeBtn)       analyzeBtn.addEventListener('click', rtAnalyze);
  if (gapRunBtn)        gapRunBtn.addEventListener('click', rtStreamDiagnosis);
  if (fixRunBtn)        fixRunBtn.addEventListener('click', rtStreamAutoFixes);
  if (saveMissionBtn)   saveMissionBtn.addEventListener('click', rtSaveAsMission);

  if (kwInput) kwInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') rtAnalyze(); });

  if (missionsBtn) missionsBtn.addEventListener('click', function() {
    var panel = document.getElementById('rt-missions-panel');
    if (!panel) return;
    if (panel.style.display === 'none' || !panel.style.display) { rtRenderDashboard(); } else { panel.style.display = 'none'; }
  });

  if (missionsCloseBtn) missionsCloseBtn.addEventListener('click', function() {
    var panel = document.getElementById('rt-missions-panel');
    if (panel) panel.style.display = 'none';
  });
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
  const { position, page } = rtLookupGsc(keyword, country);
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
      const gscLookup = rtLookupGsc(keyword, country);
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

// ══════════════════════════════════════════════════════════════════════════════
// AI AGENT MODULE
// ══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let agActiveTool  = 'content';
let agGenerating  = false;

// ── Page selector helpers ─────────────────────────────────────────────────────
function agPopulateSelects() {
  const pages  = allPages.filter(p => p.url && !p.fetchError);
  const noData = pages.length === 0;

  function makeOption(p) {
    const path  = p.path || '/';
    const title = rbGetPageTitle(p);
    const label = title ? path + '  —  ' + title.slice(0, 50) : path;
    return '<option value="' + esc(p.url) + '" data-path="' + esc(path) + '">' + esc(label) + '</option>';
  }

  const placeholder = noData
    ? '<option value="">No pages found — run Technical Audit first</option>'
    : '<option value="">— Select a page —</option>';

  const opts    = placeholder + pages.map(makeOption).join('');
  const withAll = '<option value="">— All pages (site-wide) —</option>' + pages.map(makeOption).join('');

  ['ag-content-page','ag-geo-page','ag-fixes-page'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = opts; el.disabled = noData; }
  });
  const linksEl = document.getElementById('ag-links-page');
  if (linksEl) { linksEl.innerHTML = withAll; linksEl.disabled = false; }
}

// ── SSE streaming via fetch (POST — EventSource only supports GET) ─────────────
async function agStream(payload, outputEl) {
  outputEl.innerHTML = '<div class="ag-streaming"><div class="ag-streaming-text" id="ag-stream-buf"></div></div>';
  const bufEl = document.getElementById('ag-stream-buf');
  let   fullText = '';

  let resp;
  try {
    resp = await fetch('/api/agent/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    agShowError(outputEl, 'Network error: ' + err.message);
    return;
  }

  if (!resp.ok) {
    agShowError(outputEl, 'Server error ' + resp.status);
    return;
  }

  const reader = resp.body.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let d;
      try { d = JSON.parse(line.slice(6)); } catch { continue; }

      if (d.type === 'chunk') {
        fullText += d.text;
        if (bufEl) bufEl.textContent = fullText;
      }
      if (d.type === 'error') {
        agShowError(outputEl, d.message);
        return;
      }
      if (d.type === 'done') {
        agRenderSections(agParseOutput(fullText), outputEl, d.usage);
        return;
      }
    }
  }

  // If stream closed without a done event, render what we have
  if (fullText) agRenderSections(agParseOutput(fullText), outputEl, null);
}

// ── Parse streamed markdown into sections ─────────────────────────────────────
function agParseOutput(text) {
  const raw   = text.trim().split(/\n(?=## )/);
  const parts = [];
  for (const chunk of raw) {
    const match = chunk.match(/^##\s+(.+?)\n([\s\S]*)$/);
    if (match) {
      parts.push({ title: match[1].trim(), content: match[2].trim() });
    } else if (parts.length === 0 && chunk.trim()) {
      parts.push({ title: 'Overview', content: chunk.trim() });
    }
  }
  return parts.length ? parts : [{ title: 'Output', content: text.trim() }];
}

// ── Render sections as copy-ready cards ───────────────────────────────────────
function agRenderSections(sections, outputEl, usage) {
  const cards = sections.map(s => {
    const codeMatch = s.content.match(/^```(\w*)\n([\s\S]*?)```/);
    if (codeMatch) {
      const lang = codeMatch[1] || 'code';
      const code = codeMatch[2].trim();
      const rest = s.content.slice(codeMatch[0].length).trim();
      return (
        '<div class="ag-section-card">' +
          '<div class="ag-section-hd">' +
            '<span class="ag-section-title">' + esc(s.title) + '</span>' +
            '<button class="ag-copy-btn" data-copy="' + esc(code) + '">Copy ' + lang.toUpperCase() + '</button>' +
          '</div>' +
          '<div class="ag-section-body ag-code-block"><pre><code>' + esc(code) + '</code></pre></div>' +
          (rest ? '<div class="ag-section-body ag-section-prose">' + agMarkdownToHtml(rest) + '</div>' : '') +
        '</div>'
      );
    }
    return (
      '<div class="ag-section-card">' +
        '<div class="ag-section-hd">' +
          '<span class="ag-section-title">' + esc(s.title) + '</span>' +
          '<button class="ag-copy-btn" data-copy="' + esc(s.content) + '">Copy</button>' +
        '</div>' +
        '<div class="ag-section-body ag-section-prose">' + agMarkdownToHtml(s.content) + '</div>' +
      '</div>'
    );
  }).join('');

  const usageHtml = usage
    ? '<div class="ag-usage">Tokens used: ' + usage.input_tokens + ' in / ' + usage.output_tokens + ' out' +
      (usage.cache_read_input_tokens ? ' &middot; ' + usage.cache_read_input_tokens + ' cached' : '') + '</div>'
    : '';

  outputEl.innerHTML = '<div class="ag-sections">' + cards + '</div>' + usageHtml;

  outputEl.querySelectorAll('.ag-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.copy;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('ag-copy-success');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('ag-copy-success'); }, 2000);
      }).catch(() => {});
    });
  });
}

// ── Minimal markdown → HTML ───────────────────────────────────────────────────
function agMarkdownToHtml(text) {
  let h = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Convert numbered and bulleted list lines into <li> items wrapped in <ul>/<ol>
  const lines = h.split('\n');
  const out   = [];
  let inList  = false;

  for (const line of lines) {
    const numMatch = line.match(/^(\d+)\.\s+(.+)/);
    const bulMatch = line.match(/^[-*]\s+(.+)/);
    if (numMatch || bulMatch) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + (numMatch ? numMatch[2] : bulMatch[1]) + '</li>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(line);
    }
  }
  if (inList) out.push('</ul>');

  return out.join('\n')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>').replace(/$/, '</p>')
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/<p>(<ul>)/g, '$1')
    .replace(/(<\/ul>)<\/p>/g, '$1');
}

// ── Error display ─────────────────────────────────────────────────────────────
function agShowError(outputEl, msg) {
  outputEl.innerHTML = '<div class="ag-error">⚠️ ' + esc(msg) + '</div>';
  agGenerating = false;
  agResetBtns();
}

function agResetBtns() {
  ['ag-content-btn','ag-geo-btn','ag-fixes-btn','ag-links-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Generate'; }
  });
}

// ── Main generate handler ─────────────────────────────────────────────────────
async function agGenerate(tool) {
  if (agGenerating) return;

  const outputEl = document.getElementById('ag-' + tool + '-output');
  if (!outputEl) return;

  let payload = { task: tool };

  if (tool === 'content' || tool === 'geo') {
    const sel  = document.getElementById('ag-' + tool + '-page');
    const kw   = document.getElementById('ag-' + tool + '-keyword');
    const url  = sel ? sel.value : '';
    if (!url) { agShowError(outputEl, 'Please select a page first.'); return; }
    const pageData = allPages.find(p => p.url === url);
    payload = {
      task:      tool,
      pageUrl:   url,
      pagePath:  sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].dataset.path : '/',
      pageTitle: pageData ? (pageData.title || '') : '',
      checks:    pageData ? (pageData.checks || []) : [],
      keyword:   kw ? kw.value.trim() : '',
    };
  }

  if (tool === 'fixes') {
    const sel  = document.getElementById('ag-fixes-page');
    const url  = sel ? sel.value : '';
    if (!url) { agShowError(outputEl, 'Please select a page first.'); return; }
    const pageData = allPages.find(p => p.url === url);
    const issues   = pageData ? (pageData.checks || []).filter(c => c.status === 'fail' || c.status === 'warn') : [];
    if (issues.length === 0) { agShowError(outputEl, 'No issues found on this page — nothing to fix!'); return; }
    payload = {
      task:      'fixes',
      pageUrl:   url,
      pagePath:  sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].dataset.path : '/',
      pageTitle: pageData ? (pageData.title || '') : '',
      checks:    pageData ? (pageData.checks || []) : [],
    };
  }

  if (tool === 'links') {
    if (allPages.length === 0) { agShowError(outputEl, 'Run a crawl first so there are pages to analyse.'); return; }
    const sel  = document.getElementById('ag-links-page');
    const url  = sel ? sel.value : '';
    const path = url && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].dataset.path : '';
    payload = {
      task:     'links',
      pageUrl:  url,
      pagePath: path,
      pages: allPages
        .filter(p => !p.fetchError)
        .map(p => ({
          url:               p.url,
          path:              p.path || '/',
          title:             p.title || '',
          wordCount:         p.wordCount || 0,
          internalLinkCount: (p.checks || []).reduce((n, c) => {
            return c.name && c.name.toLowerCase().includes('internal link') ? (c.count || 0) : n;
          }, 0),
        })),
    };
  }

  agGenerating = true;
  const btn = document.getElementById('ag-' + tool + '-btn');
  if (btn) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    await agStream(payload, outputEl);
  } finally {
    agGenerating = false;
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Generate'; }
  }
}

// ── Switch tabs ───────────────────────────────────────────────────────────────
function agSwitchTool(tool) {
  agActiveTool = tool;
  document.querySelectorAll('.ag-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  document.querySelectorAll('.ag-panel').forEach(p => { p.style.display = p.id === 'ag-panel-' + tool ? 'block' : 'none'; });
}

// ── Init ──────────────────────────────────────────────────────────────────────
(function initAgent() {
  document.querySelectorAll('.ag-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => agSwitchTool(btn.dataset.tool));
  });
  document.getElementById('ag-content-btn') && document.getElementById('ag-content-btn').addEventListener('click', () => agGenerate('content'));
  document.getElementById('ag-geo-btn')     && document.getElementById('ag-geo-btn').addEventListener('click',     () => agGenerate('geo'));
  document.getElementById('ag-fixes-btn')   && document.getElementById('ag-fixes-btn').addEventListener('click',   () => agGenerate('fixes'));
  document.getElementById('ag-links-btn')   && document.getElementById('ag-links-btn').addEventListener('click',   () => agGenerate('links'));
})();

// ══════════════════════════════════════════════════════════════════════════════
// RANKING BLUEPRINT MODULE
// ══════════════════════════════════════════════════════════════════════════════

// ── Dimension metadata (used for visual rendering) ────────────────────────────
const RB_DIMS = {
  'search intent alignment': { icon: '🎯', color: '#3b82f6' },
  'e-e-a-t signals':         { icon: '🏆', color: '#7c3aed' },
  'topic cluster coverage':  { icon: '🗺️', color: '#0891b2' },
  'technical seo priorities':{ icon: '⚙️', color: '#475569' },
  'authority signals':       { icon: '🔗', color: '#ea580c' },
  'content freshness':       { icon: '📅', color: '#d97706' },
  'keyword strategy':        { icon: '🔍', color: '#4f46e5' },
  'local seo':               { icon: '📍', color: '#16a34a' },
  'master action plan':      { icon: '📋', color: '#dc2626' },
  '30-60-90 day roadmap':    { icon: '🗓️', color: '#0284c7' },
};

// Normalise a section title to match RB_DIMS keys
function rbDimKey(title) {
  return title.toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/[^a-z0-9\- ]/g, '').trim();
}

// ── Page title helper (used by both Blueprint and Agent selectors) ─────────────
function rbGetPageTitle(p) {
  if (p.title) return p.title;
  // Fall back to the detail text of the first title-related check
  const tc = (p.checks || []).find(c => c.name && /title/i.test(c.name) && c.detail);
  return tc ? tc.detail.trim().slice(0, 70) : '';
}

// ── Page selector population ──────────────────────────────────────────────────
function rbPopulatePageSelect() {
  const el = document.getElementById('rb-page');
  if (!el) return;

  const pages = allPages.filter(p => p.url && !p.fetchError);

  if (!pages.length) {
    el.innerHTML = '<option value="">No pages found — run Technical Audit first</option>';
    el.disabled  = true;
    return;
  }

  el.disabled  = false;
  el.innerHTML = '<option value="">— Select a page —</option>' +
    pages.map(p => {
      const path  = p.path || '/';
      const title = rbGetPageTitle(p);
      const label = title ? path + '  —  ' + title.slice(0, 50) : path;
      return '<option value="' + esc(p.url) + '" data-path="' + esc(path) + '">' + esc(label) + '</option>';
    }).join('');
}

// ── SSE streaming (reuses same /api/agent/generate endpoint) ─────────────────
async function rbStream(payload) {
  const outputEl = document.getElementById('rb-output');
  if (!outputEl) return;

  outputEl.innerHTML =
    '<div class="rb-streaming">' +
      '<div class="rb-streaming-header">' +
        '<div class="rb-spinner"></div>' +
        '<span>Claude is analysing your page across 8 dimensions…</span>' +
      '</div>' +
      '<div class="rb-streaming-text" id="rb-stream-buf"></div>' +
    '</div>';

  const bufEl    = document.getElementById('rb-stream-buf');
  let   fullText = '';

  let resp;
  try {
    resp = await fetch('/api/agent/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    rbShowError('Network error: ' + err.message);
    return;
  }

  if (!resp.ok) {
    rbShowError('Server error ' + resp.status + ' — check server console for details.');
    return;
  }

  const reader = resp.body.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let d;
      try { d = JSON.parse(line.slice(6)); } catch { continue; }

      if (d.type === 'chunk') {
        fullText += d.text;
        if (bufEl) bufEl.textContent = fullText;
      }
      if (d.type === 'error') { rbShowError(d.message); return; }
      if (d.type === 'done') {
        rbRenderBlueprint(fullText, d.usage);
        return;
      }
    }
  }

  if (fullText) rbRenderBlueprint(fullText, null);
}

// ── Parse output into sections ────────────────────────────────────────────────
function rbParseOutput(text) {
  const raw   = text.trim().split(/\n(?=## )/);
  const parts = [];
  for (const chunk of raw) {
    const match = chunk.match(/^##\s+(.+?)\n([\s\S]*)$/);
    if (match) {
      parts.push({ title: match[1].trim(), content: match[2].trim() });
    } else if (parts.length === 0 && chunk.trim()) {
      parts.push({ title: 'Overview', content: chunk.trim() });
    }
  }
  return parts;
}

// ── Render full blueprint ─────────────────────────────────────────────────────
function rbRenderBlueprint(text, usage) {
  const outputEl = document.getElementById('rb-output');
  if (!outputEl) return;

  const sections = rbParseOutput(text);

  // Separate action plan + roadmap from dimension sections
  const dimSections    = sections.filter(s => {
    const k = rbDimKey(s.title);
    return k !== 'master action plan' && k !== '30-60-90 day roadmap';
  });
  const actionSection  = sections.find(s => rbDimKey(s.title) === 'master action plan');
  const roadmapSection = sections.find(s => rbDimKey(s.title) === '30-60-90 day roadmap');

  let html = '';

  // ── 1. Dimension cards grid ────────────────────────────────────────────────
  if (dimSections.length) {
    html += '<div class="rb-dims-grid">';
    html += dimSections.map(s => rbRenderDimCard(s)).join('');
    html += '</div>';
  }

  // ── 2. Master action plan ─────────────────────────────────────────────────
  if (actionSection) {
    html += rbRenderActionPlan(actionSection);
  }

  // ── 3. Roadmap ────────────────────────────────────────────────────────────
  if (roadmapSection) {
    html += rbRenderRoadmap(roadmapSection);
  }

  // ── 4. Usage ──────────────────────────────────────────────────────────────
  if (usage) {
    html += '<div class="rb-usage">Tokens: ' + usage.input_tokens + ' in / ' + usage.output_tokens + ' out' +
      (usage.cache_read_input_tokens ? ' · ' + usage.cache_read_input_tokens + ' cached' : '') + '</div>';
  }

  outputEl.innerHTML = html || '<div class="rb-error">No output received — please try again.</div>';

  // Wire all copy buttons (rb-copy-btn and rb-copy-add-btn)
  outputEl.querySelectorAll('.rb-copy-btn, .rb-copy-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy || '').then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('rb-copy-ok');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('rb-copy-ok'); }, 2000);
      }).catch(() => {});
    });
  });
}

// ── Render a single dimension card ───────────────────────────────────────────
// ── Parse 5-field action block from a cluster of lines ───────────────────────
function rbParseActionBlock(headerLine, remainingLines, startIdx) {
  const highMatch = headerLine.match(/^🔴\s*HIGH\s*\|\s*(.+?)\s*\|\s*Impact:\s*(.+?)\s*\|\s*Effort:\s*(.+)/i);
  const medMatch  = headerLine.match(/^🟡\s*MEDIUM\s*\|\s*(.+?)\s*\|\s*Impact:\s*(.+?)\s*\|\s*Effort:\s*(.+)/i);
  const lowMatch  = headerLine.match(/^🟢\s*LOW\s*\|\s*(.+?)\s*\|\s*Impact:\s*(.+?)\s*\|\s*Effort:\s*(.+)/i);
  const match = highMatch || medMatch || lowMatch;
  if (!match) return null;

  const tier   = highMatch ? 'high' : medMatch ? 'med' : 'low';
  const title  = match[1].trim();
  const impact = match[2].trim();
  const effort = match[3].trim();

  // Collect sub-field lines (– Page:, – Section:, – Add:, – Why:, plain – detail)
  const fields  = { page: '', section: '', add: '', why: '', detail: [] };
  let   i       = startIdx;
  while (i < remainingLines.length && /^\s*[–\-]/.test(remainingLines[i])) {
    const raw = remainingLines[i].trim().replace(/^[–\-]\s*/, '');
    const pageM    = raw.match(/^Page:\s*(.+)/i);
    const sectionM = raw.match(/^Section:\s*(.+)/i);
    const addM     = raw.match(/^Add:\s*(.+)/i);
    const whyM     = raw.match(/^Why:\s*(.+)/i);
    if      (pageM)    fields.page    = pageM[1].trim();
    else if (sectionM) fields.section = sectionM[1].trim();
    else if (addM)     fields.add     = addM[1].trim().replace(/^[""]|[""]$/g, '');
    else if (whyM)     fields.why     = whyM[1].trim();
    else               fields.detail.push(raw);
    i++;
  }

  return { tier, title, impact, effort, fields, linesConsumed: i - startIdx };
}

// ── Render a single structured action card ────────────────────────────────────
function rbRenderActionCard(action) {
  const { tier, title, impact, effort, fields } = action;
  const badgeLabel = tier === 'high' ? '🔴 HIGH' : tier === 'med' ? '🟡 MEDIUM' : '🟢 LOW';
  const addText    = fields.add   || fields.detail.join(' ');
  const hasAdd     = addText.length > 0;

  return (
    '<div class="rb-action-row rb-action-' + tier + '">' +
      '<div class="rb-action-top">' +
        '<span class="rb-action-badge rb-badge-' + tier + '">' + badgeLabel + '</span>' +
        '<span class="rb-action-title">' + esc(title) + '</span>' +
        '<span class="rb-action-meta-inline">' +
          '<span class="rb-action-impact">Impact: ' + esc(impact) + '</span>' +
          '<span class="rb-action-effort">Effort: ' + esc(effort) + '</span>' +
        '</span>' +
      '</div>' +
      (fields.page || fields.section ? (
        '<div class="rb-action-fields">' +
          (fields.page    ? '<div class="rb-action-field"><span class="rb-field-label">Page</span><code class="rb-field-url">' + esc(fields.page) + '</code></div>' : '') +
          (fields.section ? '<div class="rb-action-field"><span class="rb-field-label">Section</span><span class="rb-field-val">' + esc(fields.section) + '</span></div>' : '') +
        '</div>'
      ) : '') +
      (hasAdd ? (
        '<div class="rb-action-add">' +
          '<span class="rb-field-label rb-add-label">Add / Replace</span>' +
          '<div class="rb-add-content">' + esc(addText) + '</div>' +
          '<button class="rb-copy-add-btn" data-copy="' + esc(addText) + '">Copy</button>' +
        '</div>'
      ) : '') +
      (fields.why ? (
        '<div class="rb-action-why">' +
          '<span class="rb-field-label">Why it ranks</span>' +
          '<span class="rb-field-why-text">' + esc(fields.why) + '</span>' +
        '</div>'
      ) : '') +
    '</div>'
  );
}

function rbRenderDimCard(section) {
  const key  = rbDimKey(section.title);
  const meta = RB_DIMS[key] || { icon: '📌', color: '#64748b' };

  const lines      = section.content.split('\n');
  const statusLine = lines[0] && /^[🔴🟡🟢🔵]/.test(lines[0].trim()) ? lines[0].trim() : null;

  let statusClass = 'rb-status-ok';
  if (statusLine) {
    if (statusLine.includes('🔴')) statusClass = 'rb-status-critical';
    else if (statusLine.includes('🟡')) statusClass = 'rb-status-warn';
    else if (statusLine.includes('🔵')) statusClass = 'rb-status-na';
  }

  // Split into prose paragraphs vs. action blocks
  const bodyLines = statusLine ? lines.slice(1) : lines;
  let   proseLines = [], actionCards = '', i = 0;

  while (i < bodyLines.length) {
    const line    = bodyLines[i].trim();
    const isHigh  = /^🔴\s*HIGH/i.test(line);
    const isMed   = /^🟡\s*MEDIUM/i.test(line);
    const isLow   = /^🟢\s*LOW/i.test(line);

    if (isHigh || isMed || isLow) {
      // Flush prose first
      if (proseLines.length) {
        actionCards += '<div class="rb-dim-prose">' + rbMarkdown(proseLines.join('\n').trim()) + '</div>';
        proseLines = [];
      }
      const action = rbParseActionBlock(line, bodyLines, i + 1);
      if (action) {
        actionCards += rbRenderActionCard(action);
        i += 1 + action.linesConsumed;
        continue;
      }
    }
    proseLines.push(bodyLines[i]);
    i++;
  }
  if (proseLines.length) {
    actionCards += '<div class="rb-dim-prose">' + rbMarkdown(proseLines.join('\n').trim()) + '</div>';
  }

  return (
    '<div class="rb-dim-card">' +
      '<div class="rb-dim-hd" style="border-left-color:' + meta.color + '">' +
        '<span class="rb-dim-icon">' + meta.icon + '</span>' +
        '<span class="rb-dim-title">' + esc(section.title) + '</span>' +
        (statusLine ? '<span class="rb-status-badge ' + statusClass + '">' +
          esc(statusLine.replace(/^[🔴🟡🟢🔵]\s*/,'').split('—')[0].trim()) +
        '</span>' : '') +
        '<button class="rb-copy-btn" data-copy="' + esc(section.content) + '">Copy</button>' +
      '</div>' +
      '<div class="rb-dim-body">' + (actionCards || rbMarkdown(section.content)) + '</div>' +
    '</div>'
  );
}

// ── Render Master Action Plan ─────────────────────────────────────────────────
function rbRenderActionPlan(section) {
  const lines = section.content.split('\n');
  let highCards = '', medCards = '', lowCards = '';
  let i = 0;

  while (i < lines.length) {
    const line    = lines[i].trim();
    const isHigh  = /^🔴\s*HIGH/i.test(line);
    const isMed   = /^🟡\s*MEDIUM/i.test(line);
    const isLow   = /^🟢\s*LOW/i.test(line);

    if (isHigh || isMed || isLow) {
      const action = rbParseActionBlock(line, lines, i + 1);
      if (action) {
        const card = rbRenderActionCard(action);
        if (action.tier === 'high') highCards += card;
        else if (action.tier === 'med') medCards += card;
        else lowCards += card;
        i += 1 + action.linesConsumed;
        continue;
      }
    }
    i++;
  }

  const hasCards = highCards || medCards || lowCards;
  const totalCount = (highCards.match(/rb-action-row/g) || []).length +
                     (medCards.match(/rb-action-row/g) || []).length +
                     (lowCards.match(/rb-action-row/g) || []).length;

  const buildGroup = (label, emoji, colorClass, cards) => cards
    ? '<div class="rb-priority-group">' +
        '<div class="rb-priority-label ' + colorClass + '">' + emoji + ' ' + label +
          ' <span class="rb-priority-count">' + (cards.match(/rb-action-row/g) || []).length + ' actions</span>' +
        '</div>' +
        cards +
      '</div>'
    : '';

  return (
    '<div class="rb-action-wrap">' +
      '<div class="rb-section-hd">' +
        '<span class="rb-section-icon">📋</span>' +
        '<span class="rb-section-title">Master Action Plan</span>' +
        (totalCount ? '<span class="rb-action-total">' + totalCount + ' actions</span>' : '') +
        '<button class="rb-copy-btn" data-copy="' + esc(section.content) + '">Copy All</button>' +
      '</div>' +
      (hasCards
        ? '<div class="rb-action-list">' +
            buildGroup('High Priority', '🔴', 'rb-pl-high', highCards) +
            buildGroup('Medium Priority', '🟡', 'rb-pl-med', medCards) +
            buildGroup('Low Priority', '🟢', 'rb-pl-low', lowCards) +
          '</div>'
        : '<div class="rb-dim-body">' + rbMarkdown(section.content) + '</div>') +
    '</div>'
  );
}

// ── Render 30-60-90 Roadmap ───────────────────────────────────────────────────
function rbRenderRoadmap(section) {
  const phases = [
    { label: 'Days 1–30', key: '1.30', emoji: '🚀', color: '#dc2626' },
    { label: 'Days 31–60', key: '31.60', emoji: '📈', color: '#d97706' },
    { label: 'Days 61–90', key: '61.90', emoji: '🏁', color: '#16a34a' },
  ];

  const content = section.content;
  const lines   = content.split('\n');

  // Try to split by phase headings
  const phaseBlocks = {};
  let   currentPhase = null;
  for (const line of lines) {
    const heading = line.match(/days?\s*(1[\-–]30|31[\-–]60|61[\-–]90)/i);
    if (heading) {
      const key = heading[1].replace(/[–]/g, '.');
      currentPhase = key.includes('1') && !key.includes('31') && !key.includes('61') ? '1.30'
                   : key.includes('31') ? '31.60' : '61.90';
      phaseBlocks[currentPhase] = '';
    } else if (currentPhase) {
      phaseBlocks[currentPhase] = (phaseBlocks[currentPhase] || '') + line + '\n';
    }
  }

  const hasPhases = Object.keys(phaseBlocks).length > 0;

  return (
    '<div class="rb-roadmap-wrap">' +
      '<div class="rb-section-hd">' +
        '<span class="rb-section-icon">🗓️</span>' +
        '<span class="rb-section-title">30-60-90 Day Roadmap</span>' +
        '<button class="rb-copy-btn" data-copy="' + esc(section.content) + '">Copy</button>' +
      '</div>' +
      (hasPhases
        ? '<div class="rb-roadmap-grid">' +
          phases.map(ph => (
            '<div class="rb-roadmap-phase" style="border-top-color:' + ph.color + '">' +
              '<div class="rb-phase-label" style="color:' + ph.color + '">' + ph.emoji + ' ' + ph.label + '</div>' +
              '<div class="rb-phase-body">' + rbMarkdown((phaseBlocks[ph.key] || '').trim()) + '</div>' +
            '</div>'
          )).join('') +
          '</div>'
        : '<div class="rb-dim-body">' + rbMarkdown(content) + '</div>') +
    '</div>'
  );
}

// ── Minimal markdown → HTML ───────────────────────────────────────────────────
function rbMarkdown(text) {
  if (!text) return '';
  let h = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');

  const lines = h.split('\n');
  const out   = [];
  let inList  = false;

  for (const line of lines) {
    const numMatch = line.match(/^\d+\.\s+(.+)/);
    const bulMatch = line.match(/^[-*–]\s+(.+)/);
    if (numMatch || bulMatch) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + (numMatch ? numMatch[1] : bulMatch[1]) + '</li>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(line);
    }
  }
  if (inList) out.push('</ul>');

  return out.join('\n')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>').replace(/$/, '</p>')
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/<p>(<ul>)/g, '$1')
    .replace(/(<\/ul>)<\/p>/g, '$1');
}

// ── Error helper ──────────────────────────────────────────────────────────────
function rbShowError(msg) {
  const outputEl = document.getElementById('rb-output');
  if (outputEl) outputEl.innerHTML = '<div class="rb-error">⚠️ ' + esc(msg) + '</div>';
  const btn = document.getElementById('rb-generate-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label || 'Generate Ranking Blueprint'; }
}

// ── Main generate handler ─────────────────────────────────────────────────────
async function rbGenerate() {
  const sel     = document.getElementById('rb-page');
  const keyword = (document.getElementById('rb-keyword') || {}).value || '';
  const bizType = (document.getElementById('rb-biz-type') || {}).value || '';
  const location = (document.getElementById('rb-location') || {}).value || '';

  const url = sel ? sel.value : '';
  if (!url) {
    rbShowError('Please select a page first. Run a crawl if no pages appear.');
    return;
  }

  const pageData = allPages.find(p => p.url === url);
  if (!pageData) { rbShowError('Page data not found — try re-selecting.'); return; }

  const payload = {
    task:      'blueprint',
    pageUrl:   url,
    pagePath:  sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].dataset.path : '/',
    pageTitle: pageData.title || '',
    checks:    pageData.checks || [],
    keyword:   keyword.trim(),
    bizType,
    location:  location.trim(),
    pages: allPages.filter(p => !p.fetchError).map(p => ({
      url:       p.url,
      path:      p.path || '/',
      title:     p.title || '',
      wordCount: p.wordCount || 0,
      failCount: (p.issueCount || {}).fail || (p.checks || []).filter(c => c.status === 'fail').length,
      warnCount: (p.issueCount || {}).warn || (p.checks || []).filter(c => c.status === 'warn').length,
    })),
  };

  const btn = document.getElementById('rb-generate-btn');
  if (btn) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:rb-spin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Generating Blueprint…';
  }

  try {
    await rbStream(payload);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label || 'Generate Ranking Blueprint'; }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(function initBlueprint() {
  const btn = document.getElementById('rb-generate-btn');
  if (btn) btn.addEventListener('click', rbGenerate);
  // Tab population is now handled centrally in initSectionNav()
})();

// ══════════════════════════════════════════════════════════════════════════════
// FIX PACK MODULE
// ══════════════════════════════════════════════════════════════════════════════

// Section metadata: icon, label, language for syntax highlight class
var FP_SECTIONS = {
  'title tag':               { icon: '🏷️',  label: 'Title Tag',              lang: 'html', hint: 'Paste inside <head>' },
  'meta description':        { icon: '📝',  label: 'Meta Description',        lang: 'html', hint: 'Paste inside <head>' },
  'h1 tag':                  { icon: '✍️',  label: 'H1 Heading',              lang: 'html', hint: 'Replace first <h1> in page body' },
  'faq section':             { icon: '❓',  label: 'FAQ Section',             lang: 'html', hint: 'Paste into page body' },
  'schema markup':           { icon: '📊',  label: 'Schema Markup',           lang: 'json', hint: 'Paste inside <head> or before </body>' },
  'local business schema':   { icon: '📍',  label: 'Local Business Schema',   lang: 'json', hint: 'Paste inside <head> or before </body>' },
  'internal link suggestions': { icon: '🔗', label: 'Internal Links',         lang: 'html', hint: 'Add to page body at suggested locations' },
  'fix pack summary':        { icon: '📋',  label: 'Fix Pack Summary',        lang: 'text', hint: 'Share with your developer or content team' },
};

// Normalise section title to match FP_SECTIONS keys
function fpKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Parse ## sections ─────────────────────────────────────────────────────────
function fpParseOutput(text) {
  var raw   = text.trim().split(/\n(?=## )/);
  var parts = [];
  for (var i = 0; i < raw.length; i++) {
    var chunk = raw[i];
    var match = chunk.match(/^##\s+(.+?)\n([\s\S]*)$/);
    if (match) {
      parts.push({ title: match[1].trim(), content: match[2].trim() });
    } else if (parts.length === 0 && chunk.trim()) {
      parts.push({ title: 'Overview', content: chunk.trim() });
    }
  }
  return parts;
}

// ── Extract code block from section content ───────────────────────────────────
function fpExtractCode(content) {
  var match = content.match(/```(\w*)\n?([\s\S]*?)```/);
  if (!match) return null;
  return { lang: match[1] || 'html', code: match[2].trim(), rest: content.replace(match[0], '').trim() };
}

// ── Render a single fix section card ─────────────────────────────────────────
function fpRenderCard(section) {
  var key    = fpKey(section.title);
  var meta   = FP_SECTIONS[key] || { icon: '📄', label: section.title, lang: 'html', hint: '' };
  var parsed = fpExtractCode(section.content);
  var prose  = parsed ? parsed.rest : section.content;
  var code   = parsed ? parsed.code : '';
  var lang   = parsed ? parsed.lang : meta.lang;

  var codeBlock = code
    ? '<div class="fp-code-wrap">' +
        '<div class="fp-code-toolbar">' +
          '<span class="fp-code-lang">' + esc(lang.toUpperCase() || 'CODE') + '</span>' +
          '<span class="fp-code-hint">' + esc(meta.hint) + '</span>' +
          '<button class="fp-copy-btn" data-copy="' + esc(code) + '">Copy ' + esc(lang.toUpperCase() || 'Code') + '</button>' +
        '</div>' +
        '<pre class="fp-code"><code>' + esc(code) + '</code></pre>' +
      '</div>'
    : '';

  var proseBlock = prose
    ? '<div class="fp-prose">' + fpMarkdown(prose) + '</div>'
    : '';

  return (
    '<div class="fp-card" id="fp-card-' + esc(key.replace(/\s/g, '-')) + '">' +
      '<div class="fp-card-hd">' +
        '<span class="fp-card-icon">' + meta.icon + '</span>' +
        '<div class="fp-card-title-wrap">' +
          '<span class="fp-card-title">' + esc(meta.label || section.title) + '</span>' +
          (meta.hint ? '<span class="fp-card-where">' + esc(meta.hint) + '</span>' : '') +
        '</div>' +
        (code ? '<button class="fp-copy-btn fp-copy-sm" data-copy="' + esc(code) + '">Copy</button>' : '') +
      '</div>' +
      codeBlock +
      proseBlock +
    '</div>'
  );
}

// ── Minimal markdown → HTML ───────────────────────────────────────────────────
function fpMarkdown(text) {
  if (!text) return '';
  var h = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  var lines = h.split('\n'), out = [], inList = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var numM = line.match(/^\d+\.\s+(.+)/);
    var bulM = line.match(/^[-*•]\s+(.+)/);
    if (numM || bulM) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + (numM ? numM[1] : bulM[1]) + '</li>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(line);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n')
    .replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')
    .replace(/^/, '<p>').replace(/$/, '</p>')
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/<p>(<ul>)/g,'$1').replace(/(<\/ul>)<\/p>/g,'$1');
}

// ── Build full fix pack HTML ──────────────────────────────────────────────────
function fpRenderFixPack(text, meta, usage) {
  var outputEl = document.getElementById('fp-output');
  if (!outputEl) return;

  var sections = fpParseOutput(text);
  if (!sections.length) {
    outputEl.innerHTML = '<div class="fp-error">No output received — please try again.</div>';
    return;
  }

  var date    = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  var cards   = sections.map(fpRenderCard).join('');
  var usageLine = usage
    ? '<span class="fp-usage">Tokens: ' + usage.input_tokens + ' in / ' + usage.output_tokens + ' out' +
      (usage.cache_read_input_tokens ? ' · ' + usage.cache_read_input_tokens + ' cached' : '') + '</span>'
    : '';

  outputEl.innerHTML =
    '<div class="fp-wrap">' +
      '<div class="fp-header">' +
        '<div class="fp-header-left">' +
          '<span class="fp-header-icon">📦</span>' +
          '<div>' +
            '<div class="fp-header-title">Fix Pack</div>' +
            '<div class="fp-header-sub">' + esc(meta.pagePath || meta.pageUrl || '') + ' &middot; ' + esc(meta.keyword || 'target keyword') + ' &middot; ' + date + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="fp-header-right">' +
          usageLine +
          '<button id="fp-download-btn" class="fp-download-btn">&#8595; Download .md</button>' +
        '</div>' +
      '</div>' +
      '<div class="fp-toc">' +
        sections.map(function(s) {
          var k = fpKey(s.title);
          var m = FP_SECTIONS[k] || { icon: '📄', label: s.title };
          return '<a class="fp-toc-item" href="#fp-card-' + esc(k.replace(/\s/g,'-')) + '">' + m.icon + ' ' + esc(m.label || s.title) + '</a>';
        }).join('') +
      '</div>' +
      '<div class="fp-cards">' + cards + '</div>' +
    '</div>';

  // Wire copy buttons
  outputEl.querySelectorAll('.fp-copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      navigator.clipboard.writeText(btn.dataset.copy || '').then(function() {
        var orig = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('fp-copy-ok');
        setTimeout(function() { btn.textContent = orig; btn.classList.remove('fp-copy-ok'); }, 2000);
      }).catch(function() {});
    });
  });

  // Download button
  var dlBtn = document.getElementById('fp-download-btn');
  if (dlBtn) {
    dlBtn.addEventListener('click', function() { fpDownload(sections, meta, date); });
  }

  // Smooth-scroll TOC links
  outputEl.querySelectorAll('.fp-toc-item').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      var target = document.querySelector(a.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// ── Download as Markdown ──────────────────────────────────────────────────────
function fpDownload(sections, meta, date) {
  var lines = [];
  lines.push('# Fix Pack: ' + (meta.pagePath || meta.pageUrl || 'page'));
  lines.push('');
  lines.push('**URL:** ' + (meta.pageUrl || ''));
  lines.push('**Keyword:** ' + (meta.keyword || ''));
  lines.push('**Business type:** ' + (meta.bizType || ''));
  lines.push('**Generated:** ' + date);
  lines.push('');
  lines.push('---');
  lines.push('');

  sections.forEach(function(s, idx) {
    var key    = fpKey(s.title);
    var meta2  = FP_SECTIONS[key] || { icon: '📄', label: s.title, hint: '' };
    var parsed = fpExtractCode(s.content);

    lines.push('## ' + (idx + 1) + '. ' + meta2.icon + ' ' + (meta2.label || s.title));
    if (meta2.hint) lines.push('> **Where to paste:** ' + meta2.hint);
    lines.push('');

    if (parsed) {
      lines.push('```' + (parsed.lang || 'html'));
      lines.push(parsed.code);
      lines.push('```');
      if (parsed.rest) {
        lines.push('');
        lines.push(parsed.rest);
      }
    } else {
      lines.push(s.content);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  lines.push('*Generated by SEO Audit Tool — Elitez Group of Companies*');

  var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  var slug = (meta.pagePath || 'page').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  a.href     = url;
  a.download = 'fix-pack-' + slug + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Streaming ─────────────────────────────────────────────────────────────────
async function fpStream(payload, meta) {
  var outputEl = document.getElementById('fp-output');
  if (!outputEl) return;
  outputEl.style.display = 'block';

  outputEl.innerHTML =
    '<div class="fp-streaming">' +
      '<div class="fp-streaming-hd">' +
        '<div class="fp-spinner"></div>' +
        '<span>Generating Fix Pack — writing paste-ready code for each element…</span>' +
      '</div>' +
      '<div class="fp-stream-text" id="fp-stream-buf"></div>' +
    '</div>';

  var bufEl    = document.getElementById('fp-stream-buf');
  var fullText = '';

  var resp;
  try {
    resp = await fetch('/api/agent/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    fpShowError('Network error: ' + err.message);
    return;
  }

  if (!resp.ok) {
    fpShowError('Server error ' + resp.status);
    return;
  }

  var reader = resp.body.getReader();
  var dec    = new TextDecoder();
  var buf    = '';

  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    var lines = buf.split('\n');
    buf = lines.pop();

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.startsWith('data: ')) continue;
      var d;
      try { d = JSON.parse(line.slice(6)); } catch(e) { continue; }
      if (d.type === 'chunk') {
        fullText += d.text;
        if (bufEl) bufEl.textContent = fullText;
      }
      if (d.type === 'error') { fpShowError(d.message); return; }
      if (d.type === 'done')  { fpRenderFixPack(fullText, meta, d.usage); return; }
    }
  }
  if (fullText) fpRenderFixPack(fullText, meta, null);
}

// ── Error helper ──────────────────────────────────────────────────────────────
function fpShowError(msg) {
  var outputEl = document.getElementById('fp-output');
  if (outputEl) {
    outputEl.style.display = 'block';
    outputEl.innerHTML = '<div class="fp-error">⚠️ ' + esc(msg) + '</div>';
  }
  var btn = document.getElementById('fp-generate-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label || 'Apply Fix Pack'; }
}

// ── Main generate handler ─────────────────────────────────────────────────────
async function fpGenerate() {
  var sel      = document.getElementById('rb-page');
  var keyword  = (document.getElementById('rb-keyword') || {}).value || '';
  var bizType  = (document.getElementById('rb-biz-type') || {}).value || '';
  var location = (document.getElementById('rb-location') || {}).value || '';

  var url = sel ? sel.value : '';
  if (!url) {
    fpShowError('Please select a page first. Run a crawl if no pages appear.');
    return;
  }

  var pageData = allPages.find(function(p) { return p.url === url; });
  if (!pageData) { fpShowError('Page data not found — try re-selecting.'); return; }

  var pagePath = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].dataset.path : '/';

  var meta = { pageUrl: url, pagePath: pagePath, keyword: keyword.trim(), bizType: bizType, location: location.trim() };

  var payload = {
    task:      'fix-pack',
    maxTokens: 7000,
    pageUrl:   url,
    pagePath:  pagePath,
    pageTitle: pageData.title || '',
    checks:    pageData.checks || [],
    keyword:   keyword.trim(),
    bizType:   bizType,
    location:  location.trim(),
    pages: allPages.filter(function(p) { return !p.fetchError; }).map(function(p) {
      return { url: p.url, path: p.path || '/', title: p.title || '' };
    }),
  };

  var btn = document.getElementById('fp-generate-btn');
  if (btn) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.textContent = 'Generating…'; }

  // Scroll to output area
  var outputEl = document.getElementById('fp-output');
  if (outputEl) {
    outputEl.style.display = 'block';
    setTimeout(function() { outputEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
  }

  try {
    await fpStream(payload, meta);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label || 'Apply Fix Pack'; }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(function initFixPack() {
  var btn = document.getElementById('fp-generate-btn');
  if (btn) btn.addEventListener('click', fpGenerate);
})();


// ── AI OPTIMIZATION CYCLE ─────────────────────────────────────────────────────

function ocDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function ocPeriodDates(periodDays) {
  var lag = 3;
  var now = new Date();
  var endDate = new Date(now);
  endDate.setDate(endDate.getDate() - lag);

  var startCurrent = new Date(endDate);
  startCurrent.setDate(startCurrent.getDate() - periodDays + 1);

  var endPrev = new Date(startCurrent);
  endPrev.setDate(endPrev.getDate() - 1);

  var startPrev = new Date(endPrev);
  startPrev.setDate(startPrev.getDate() - periodDays + 1);

  return {
    current: { start: ocDateStr(startCurrent), end: ocDateStr(endDate) },
    prev:    { start: ocDateStr(startPrev),    end: ocDateStr(endPrev)  }
  };
}

async function ocFetchRows(siteUrl, startDate, endDate) {
  var res = await fetch('/api/gsc/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteUrl: siteUrl, startDate: startDate, endDate: endDate, dimensions: ['query', 'page'], rowLimit: 500 })
  });
  if (!res.ok) throw new Error('GSC query failed: ' + res.status);
  var json = await res.json();
  return json.rows || [];
}

function ocComputeDeltas(currentRows, prevRows) {
  var prevMap = {};
  prevRows.forEach(function(r) { prevMap[(r.keys || []).join('|')] = r; });

  var drops = [], ctrDrops = [], opportunities = [], rising = [];

  currentRows.forEach(function(r) {
    var key   = (r.keys || []).join('|');
    var query = (r.keys && r.keys[0]) || '';
    var page  = (r.keys && r.keys[1]) || '';
    var prev  = prevMap[key];

    if (!prev) {
      if (r.impressions >= 10) {
        opportunities.push({ query: query, page: page, clicks: r.clicks, impressions: r.impressions, position: r.position, ctr: r.ctr });
      }
      return;
    }

    var posChange = r.position - prev.position;
    var ctrChange = r.ctr - prev.ctr;

    if (posChange >= 3 && prev.clicks >= 2) {
      drops.push({ query: query, page: page, posNow: r.position, posPrev: prev.position, posChange: posChange, clicksNow: r.clicks, clicksPrev: prev.clicks });
    }
    if (ctrChange <= -0.02 && prev.impressions >= 20) {
      ctrDrops.push({ query: query, page: page, ctrNow: r.ctr, ctrPrev: prev.ctr, ctrChange: ctrChange, impressions: r.impressions });
    }
    if (r.clicks - prev.clicks >= 3 && posChange <= -1) {
      rising.push({ query: query, page: page, posNow: r.position, posPrev: prev.position, clicksNow: r.clicks, clicksPrev: prev.clicks });
    }
  });

  drops.sort(function(a, b) { return b.posChange - a.posChange; });
  ctrDrops.sort(function(a, b) { return a.ctrChange - b.ctrChange; });
  opportunities.sort(function(a, b) { return b.impressions - a.impressions; });
  rising.sort(function(a, b) { return b.clicksNow - a.clicksNow; });

  var totals = {
    currentClicks:      currentRows.reduce(function(s, r) { return s + r.clicks; }, 0),
    prevClicks:         prevRows.reduce(function(s, r) { return s + r.clicks; }, 0),
    currentImpressions: currentRows.reduce(function(s, r) { return s + r.impressions; }, 0),
    prevImpressions:    prevRows.reduce(function(s, r) { return s + r.impressions; }, 0),
    currentAvgPos:      currentRows.length ? currentRows.reduce(function(s, r) { return s + r.position; }, 0) / currentRows.length : 0,
    prevAvgPos:         prevRows.length    ? prevRows.reduce(function(s, r)    { return s + r.position; }, 0) / prevRows.length    : 0
  };

  return {
    drops:         drops.slice(0, 20),
    ctrDrops:      ctrDrops.slice(0, 20),
    opportunities: opportunities.slice(0, 20),
    rising:        rising.slice(0, 10),
    totals:        totals
  };
}

function ocSaveSnapshot(siteUrl, rows, dateRange) {
  try {
    var key = 'oc_snapshot_' + siteUrl.replace(/[^a-z0-9]/gi, '_');
    localStorage.setItem(key, JSON.stringify({ rows: rows, dateRange: dateRange, savedAt: Date.now() }));
  } catch (e) {}
}

function ocFmt(n, decimals) {
  decimals = decimals == null ? 0 : decimals;
  return typeof n === 'number' ? n.toFixed(decimals) : '—';
}

function ocDeltaBadge(now, prev, lowerIsBetter) {
  var diff = now - prev;
  if (Math.abs(diff) < 0.01 * Math.abs(prev || 1)) return '';
  var pct     = prev ? ((diff / Math.abs(prev)) * 100).toFixed(1) : '—';
  var positive = lowerIsBetter ? diff < 0 : diff > 0;
  var cls     = positive ? 'oc-badge-up' : 'oc-badge-down';
  var sign    = diff > 0 ? '+' : '';
  return '<span class="oc-badge ' + cls + '">' + sign + pct + '%</span>';
}

function ocEsc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ocShortPath(url) {
  return (url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 40) || '/';
}

function ocRenderDeltaSummary(deltas, dates) {
  var drops = deltas.drops, ctrDrops = deltas.ctrDrops,
      opportunities = deltas.opportunities, rising = deltas.rising,
      totals = deltas.totals;

  var html = '<div class="oc-delta-section">'
    + '<div class="oc-period-bar">'
    + '<span class="oc-period-label">Current: <strong>' + dates.current.start + ' → ' + dates.current.end + '</strong></span>'
    + '<span class="oc-period-sep">vs</span>'
    + '<span class="oc-period-label">Previous: <strong>' + dates.prev.start + ' → ' + dates.prev.end + '</strong></span>'
    + '</div>'
    + '<div class="oc-kpi-grid">'
    + '<div class="oc-kpi"><div class="oc-kpi-val">' + ocFmt(totals.currentClicks) + ocDeltaBadge(totals.currentClicks, totals.prevClicks, false) + '</div><div class="oc-kpi-label">Clicks</div></div>'
    + '<div class="oc-kpi"><div class="oc-kpi-val">' + ocFmt(totals.currentImpressions) + ocDeltaBadge(totals.currentImpressions, totals.prevImpressions, false) + '</div><div class="oc-kpi-label">Impressions</div></div>'
    + '<div class="oc-kpi"><div class="oc-kpi-val">' + ocFmt(totals.currentAvgPos, 1) + ocDeltaBadge(totals.currentAvgPos, totals.prevAvgPos, true) + '</div><div class="oc-kpi-label">Avg Position</div></div>'
    + '<div class="oc-kpi oc-kpi-alert"><div class="oc-kpi-val">' + drops.length + '</div><div class="oc-kpi-label">Ranking Drops</div></div>'
    + '<div class="oc-kpi oc-kpi-warn"><div class="oc-kpi-val">' + ctrDrops.length + '</div><div class="oc-kpi-label">CTR Drops</div></div>'
    + '<div class="oc-kpi oc-kpi-good"><div class="oc-kpi-val">' + opportunities.length + '</div><div class="oc-kpi-label">Opportunities</div></div>'
    + '</div>';

  if (drops.length) {
    html += '<div class="oc-table-section"><h4 class="oc-table-title oc-title-drop">🔴 Ranking Drops (' + drops.length + ')</h4>'
      + '<table class="oc-table"><thead><tr><th>Query</th><th>Page</th><th>Pos Now</th><th>Pos Prev</th><th>Δ</th><th>Clicks</th></tr></thead><tbody>'
      + drops.map(function(d) {
          return '<tr><td class="oc-cell-q">' + ocEsc(d.query) + '</td>'
            + '<td class="oc-cell-p"><a href="' + ocEsc(d.page) + '" target="_blank" title="' + ocEsc(d.page) + '">' + ocEsc(ocShortPath(d.page)) + '</a></td>'
            + '<td>' + ocFmt(d.posNow, 1) + '</td><td>' + ocFmt(d.posPrev, 1) + '</td>'
            + '<td class="oc-delta-neg">+' + ocFmt(d.posChange, 1) + '</td>'
            + '<td>' + d.clicksNow + '</td></tr>';
        }).join('')
      + '</tbody></table></div>';
  }

  if (ctrDrops.length) {
    html += '<div class="oc-table-section"><h4 class="oc-table-title oc-title-warn">🟡 CTR Drops (' + ctrDrops.length + ')</h4>'
      + '<table class="oc-table"><thead><tr><th>Query</th><th>Page</th><th>CTR Now</th><th>CTR Prev</th><th>Impressions</th></tr></thead><tbody>'
      + ctrDrops.map(function(d) {
          return '<tr><td class="oc-cell-q">' + ocEsc(d.query) + '</td>'
            + '<td class="oc-cell-p"><a href="' + ocEsc(d.page) + '" target="_blank" title="' + ocEsc(d.page) + '">' + ocEsc(ocShortPath(d.page)) + '</a></td>'
            + '<td>' + (d.ctrNow * 100).toFixed(1) + '%</td><td>' + (d.ctrPrev * 100).toFixed(1) + '%</td>'
            + '<td>' + d.impressions + '</td></tr>';
        }).join('')
      + '</tbody></table></div>';
  }

  if (opportunities.length) {
    html += '<div class="oc-table-section"><h4 class="oc-table-title oc-title-good">🟢 New Opportunities (' + opportunities.length + ')</h4>'
      + '<table class="oc-table"><thead><tr><th>Query</th><th>Page</th><th>Impressions</th><th>Position</th><th>Clicks</th></tr></thead><tbody>'
      + opportunities.map(function(d) {
          return '<tr><td class="oc-cell-q">' + ocEsc(d.query) + '</td>'
            + '<td class="oc-cell-p"><a href="' + ocEsc(d.page) + '" target="_blank" title="' + ocEsc(d.page) + '">' + ocEsc(ocShortPath(d.page)) + '</a></td>'
            + '<td>' + d.impressions + '</td><td>' + ocFmt(d.position, 1) + '</td><td>' + d.clicks + '</td></tr>';
        }).join('')
      + '</tbody></table></div>';
  }

  if (rising.length) {
    html += '<div class="oc-table-section"><h4 class="oc-table-title oc-title-rise">🚀 Rising Keywords (' + rising.length + ')</h4>'
      + '<table class="oc-table"><thead><tr><th>Query</th><th>Page</th><th>Pos Now</th><th>Pos Prev</th><th>Clicks Now</th><th>Clicks Prev</th></tr></thead><tbody>'
      + rising.map(function(d) {
          return '<tr><td class="oc-cell-q">' + ocEsc(d.query) + '</td>'
            + '<td class="oc-cell-p"><a href="' + ocEsc(d.page) + '" target="_blank" title="' + ocEsc(d.page) + '">' + ocEsc(ocShortPath(d.page)) + '</a></td>'
            + '<td>' + ocFmt(d.posNow, 1) + '</td><td>' + ocFmt(d.posPrev, 1) + '</td>'
            + '<td>' + d.clicksNow + '</td><td>' + d.clicksPrev + '</td></tr>';
        }).join('')
      + '</tbody></table></div>';
  }

  html += '</div>';
  return html;
}

function ocRenderAIOutput(md) {
  var html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  // ## Section headers — open a new section div each time
  html = html.replace(/^## (.+)$/gm, '<div class="oc-ai-section"><h3 class="oc-ai-h3">$1</h3>');

  // Action header lines with priority emoji
  html = html.replace(/^([\u{1F534}\u{1F7E1}\u{1F7E2}]|🔴|🟡|🟢)\s*(HIGH|MEDIUM|LOW)\s*\|\s*(.+)$/gmu, function(_, emoji, tier, rest) {
    var cls = tier === 'HIGH' ? 'oc-act-high' : tier === 'MEDIUM' ? 'oc-act-med' : 'oc-act-low';
    return '<div class="oc-action-block ' + cls + '"><div class="oc-action-header">'
      + emoji + ' <span class="oc-action-tier">' + tier + '</span> — ' + rest + '</div>';
  });

  // Sub-field lines (– Page: / – Section: / – Add: / – Why:)
  html = html.replace(/^[–\-]\s*(Page|Section|Add|Replace|Why):\s*(.*)$/gm, function(_, label, val) {
    if (label === 'Add' || label === 'Replace') {
      return '<div class="oc-action-field oc-action-add"><span class="oc-field-label">' + label + ':</span> <code class="oc-add-code">' + val + '</code></div>';
    }
    return '<div class="oc-action-field"><span class="oc-field-label">' + label + ':</span> ' + val + '</div>';
  });

  // Bullet lines
  html = html.replace(/^[ \t]*[-•]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, '<ul>$&</ul>');

  // Plain paragraphs
  html = html.replace(/^(?!<)(.+)$/gm, '<p>$1</p>');

  html = '<div class="oc-ai-content">' + html + '</div></div>';
  return html;
}

async function ocStreamAnalysis(payload, siteUrl, dates, totals) {
  var outputEl = document.getElementById('oc-output');
  if (!outputEl) return;
  outputEl.style.display = 'block';
  outputEl.innerHTML = '<div class="oc-ai-header"><span>🤖 AI Analysis</span>'
    + '<span class="oc-streaming-badge">Analyzing…</span></div>'
    + '<div id="oc-ai-body" class="oc-ai-body ag-streaming"></div>';

  var bodyEl = document.getElementById('oc-ai-body');

  var res = await fetch('/api/agent/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok || !res.body) {
    bodyEl.textContent = 'AI analysis failed. Please try again.';
    return;
  }

  var reader  = res.body.getReader();
  var decoder = new TextDecoder();
  var buffer  = '', fullText = '';

  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop();

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!line.startsWith('data: ')) continue;
      var raw = line.slice(6).trim();
      try {
        var d = JSON.parse(raw);
        if (d.type === 'chunk') { fullText += d.text; bodyEl.innerHTML = ocRenderAIOutput(fullText); }
        if (d.type === 'error') {
          bodyEl.innerHTML = '<div class="oc-error">⚠️ ' + ocEsc(d.message || 'AI error') + '</div>';
          return;
        }
      } catch (e) {}
    }
  }

  // Parse structured actions, save report, switch to interactive task list
  var actions  = ocParseActions(fullText);
  var reportId = ocSaveReport(siteUrl, dates, fullText, actions, totals);

  bodyEl.classList.remove('ag-streaming');
  var badge = outputEl.querySelector('.oc-streaming-badge');
  if (badge) badge.remove();

  bodyEl.innerHTML = ocRenderTaskList(actions, reportId)
    + '<details class="oc-raw-details"><summary class="oc-raw-summary">View raw AI output</summary>'
    + '<div class="oc-raw-body">' + ocRenderAIOutput(fullText) + '</div></details>';

  var histEl = document.getElementById('oc-history');
  if (histEl) histEl.innerHTML = ocRenderHistory(siteUrl);

  outputEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function ocRun() {
  var siteSelect   = document.getElementById('oc-site-select');
  var periodSelect = document.getElementById('oc-period-select');
  var runBtn       = document.getElementById('oc-run-btn');
  var deltaEl      = document.getElementById('oc-delta');
  var outputEl     = document.getElementById('oc-output');

  var siteUrl = siteSelect ? siteSelect.value : '';
  if (!siteUrl) { alert('Please select a GSC property first.'); return; }

  var periodDays = parseInt((periodSelect ? periodSelect.value : '') || '28', 10);
  var dates = ocPeriodDates(periodDays);

  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Loading GSC data…'; }
  if (deltaEl) deltaEl.style.display = 'none';
  if (outputEl) outputEl.style.display = 'none';

  try {
    if (runBtn) runBtn.textContent = '⏳ Fetching current period…';
    var currentRows = await ocFetchRows(siteUrl, dates.current.start, dates.current.end);

    if (runBtn) runBtn.textContent = '⏳ Fetching previous period…';
    var prevRows = await ocFetchRows(siteUrl, dates.prev.start, dates.prev.end);

    var deltas = ocComputeDeltas(currentRows, prevRows);

    if (deltaEl) {
      deltaEl.innerHTML = ocRenderDeltaSummary(deltas, dates);
      deltaEl.style.display = 'block';
    }

    if (runBtn) runBtn.textContent = '⏳ Generating AI plan…';

    var payload = {
      task: 'optimization-cycle',
      maxTokens: 4096,
      data: {
        siteUrl:      siteUrl,
        periodDays:   periodDays,
        dates:        dates,
        drops:        deltas.drops,
        ctrDrops:     deltas.ctrDrops,
        opportunities: deltas.opportunities,
        rising:       deltas.rising,
        totals:       deltas.totals
      }
    };

    await ocStreamAnalysis(payload, siteUrl, dates, deltas.totals);

  } catch (err) {
    if (deltaEl) {
      deltaEl.innerHTML = '<div class="oc-error">Error: ' + ocEsc(err.message) + '</div>';
      deltaEl.style.display = 'block';
    }
    console.error('OC error:', err);
  } finally {
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '🔄 Run Optimization Cycle'; }
  }
}

var _ocInitDone = false;

async function ocInit() {
  // Only run once per page load — avoids re-fetching GSC on every tab switch
  if (_ocInitDone) return;

  var statusEl   = document.getElementById('oc-gsc-status');
  var siteSelect = document.getElementById('oc-site-select');
  var runBtn     = document.getElementById('oc-run-btn');
  if (!statusEl) return;

  try {
    var res  = await fetch('/api/gsc/status');
    var data = await res.json();

    if (!data.connected) {
      statusEl.innerHTML = '<div class="oc-gsc-bar-inner oc-gsc-disconnected">'
        + '<span>⚠️ Google Search Console not connected.</span>'
        + '<a href="/api/gsc/auth" class="oc-gsc-connect-btn">Connect GSC</a></div>';
      return; // Don't set _ocInitDone so reconnect re-checks next time
    }

    statusEl.innerHTML = '<div class="oc-gsc-bar-inner oc-gsc-connected">'
      + '<span>✅ GSC connected: <strong>' + ocEsc(data.email || 'Account') + '</strong></span></div>';

    var sitesRes  = await fetch('/api/gsc/sites');
    var sitesData = await sitesRes.json();
    var sites     = sitesData.siteEntry || [];

    if (siteSelect) {
      siteSelect.innerHTML = sites.length
        ? sites.map(function(s) { return '<option value="' + ocEsc(s.siteUrl) + '">' + ocEsc(s.siteUrl) + '</option>'; }).join('')
        : '<option value="">No properties found</option>';
      if (runBtn) runBtn.disabled = sites.length === 0;

      // Show saved report history for the first/selected site
      var histEl = document.getElementById('oc-history');
      if (histEl) histEl.innerHTML = ocRenderHistory(siteSelect.value);

      // Refresh history when property changes
      siteSelect.onchange = function() {
        var hEl = document.getElementById('oc-history');
        if (hEl) hEl.innerHTML = ocRenderHistory(siteSelect.value);
      };
    }

    _ocInitDone = true;

  } catch (err) {
    statusEl.innerHTML = '<div class="oc-gsc-bar-inner oc-gsc-disconnected">'
      + '<span>⚠️ Could not check GSC status.</span></div>';
  }
}

(function initOptCycle() {
  var runBtn = document.getElementById('oc-run-btn');
  if (runBtn) runBtn.addEventListener('click', ocRun);
})();

// ── OC v2: Report storage, task list, export, history ────────────────────────

function ocParseActions(md) {
  var actions = [];
  var lines   = md.split('\n');
  var i = 0;
  while (i < lines.length) {
    var line = lines[i].trim();
    var m = line.match(/^(🔴|🟡|🟢)\s*(HIGH|MEDIUM|LOW)\s*\|\s*([^|]+?)(?:\s*\|\s*[Ii]mpact:\s*([^|]+?))?(?:\s*\|\s*[Ee]ffort:\s*(.+?))?$/);
    if (m) {
      var action = {
        id:      'act_' + actions.length,
        tier:    m[2].trim(),
        title:   m[3].trim(),
        impact:  (m[4] || '').trim(),
        effort:  (m[5] || '').trim(),
        page: '', section: '', add: '', why: '',
        done: false
      };
      i++;
      while (i < lines.length) {
        var sub = lines[i].trim();
        if (/^(🔴|🟡|🟢|##)/.test(sub)) break;
        if (!sub) { i++; continue; }
        var fm = sub.match(/^[–\-]\s*(Page|Section|Add|Replace|Why):\s*(.*)/i);
        if (fm) {
          var lbl = fm[1].toLowerCase();
          if (lbl === 'replace') lbl = 'add';
          action[lbl] = fm[2].trim();
        } else if (!/^[–\-]/.test(sub) && !/^\d+\./.test(sub) && !sub.startsWith('*')) {
          // non-field line inside an action block — stop parsing sub-fields
          break;
        }
        i++;
      }
      actions.push(action);
    } else {
      i++;
    }
  }
  return actions;
}

function ocSaveReport(siteUrl, dates, rawMd, actions, totals) {
  var id = (siteUrl + '_' + dates.current.start)
    .replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 80);
  var report = {
    id: id, siteUrl: siteUrl, dates: dates,
    generatedAt: Date.now(), rawMd: rawMd,
    actions: actions, totals: totals || {}
  };
  try {
    localStorage.setItem('oc_report_' + id, JSON.stringify(report));
    var idx = ocLoadReportIndex();
    var ei  = idx.findIndex(function(r) { return r.id === id; });
    var meta = { id: id, siteUrl: siteUrl, dates: dates, generatedAt: report.generatedAt };
    if (ei >= 0) idx[ei] = meta; else idx.unshift(meta);
    localStorage.setItem('oc_reports_index', JSON.stringify(idx.slice(0, 20)));
  } catch (e) {}
  return id;
}

function ocLoadReportIndex() {
  try { return JSON.parse(localStorage.getItem('oc_reports_index') || '[]'); }
  catch (e) { return []; }
}

function ocLoadReport(id) {
  try { return JSON.parse(localStorage.getItem('oc_report_' + id) || 'null'); }
  catch (e) { return null; }
}

function ocToggleDone(reportId, actionId, done) {
  var report = ocLoadReport(reportId);
  if (!report) return;
  var a = report.actions.find(function(x) { return x.id === actionId; });
  if (a) {
    a.done = done;
    try { localStorage.setItem('oc_report_' + reportId, JSON.stringify(report)); } catch (e) {}
  }
  var card = document.querySelector('[data-action-id="' + actionId + '"]');
  if (card) card.classList.toggle('oc-task-done', done);
  // Live-update progress bar
  var list = document.getElementById('oc-task-list');
  if (list && report) {
    var total     = report.actions.length;
    var doneCount = report.actions.filter(function(x) { return x.done; }).length;
    var pct       = total ? Math.round((doneCount / total) * 100) : 0;
    var fill = list.querySelector('.oc-progress-fill');
    var info = list.querySelector('.oc-progress-info');
    if (fill) fill.style.width = pct + '%';
    if (info) info.innerHTML = '<span>' + doneCount + ' / ' + total + ' actions completed</span><span class="oc-pct">' + pct + '%</span>';
  }
}

function ocRenderActionCard(action, reportId) {
  var tierCls  = action.tier === 'HIGH' ? 'oc-act-high' : action.tier === 'MEDIUM' ? 'oc-act-med' : 'oc-act-low';
  var tierBadge = action.tier === 'HIGH' ? 'oc-tier-high' : action.tier === 'MEDIUM' ? 'oc-tier-med' : 'oc-tier-low';
  var doneCls  = action.done ? ' oc-task-done' : '';
  var checked  = action.done ? ' checked' : '';
  var rid      = ocEsc(reportId);

  var meta = '';
  if (action.impact) meta += '<span class="oc-meta-badge oc-meta-impact">⚡ ' + ocEsc(action.impact) + '</span>';
  if (action.effort) meta += '<span class="oc-meta-badge oc-meta-effort">🔧 ' + ocEsc(action.effort) + '</span>';

  var fields = '';
  if (action.page)
    fields += '<div class="oc-tf oc-tf-page"><span class="oc-tf-label">Page:</span> <a href="' + ocEsc(action.page) + '" target="_blank">' + ocEsc(action.page) + '</a></div>';
  if (action.section)
    fields += '<div class="oc-tf"><span class="oc-tf-label">Section:</span> ' + ocEsc(action.section) + '</div>';
  if (action.add)
    fields += '<div class="oc-tf oc-tf-add"><span class="oc-tf-label">Add / Replace:</span><div class="oc-add-block">' + ocEsc(action.add) + '</div></div>';
  if (action.why)
    fields += '<div class="oc-tf oc-tf-why"><em>' + ocEsc(action.why) + '</em></div>';

  var fpBtn = '';
  if (action.page && /^https?:\/\//.test(action.page)) {
    fpBtn = '<button class="oc-fp-btn" onclick="ocOpenFixPack(\'' + action.page.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\')" title="Generate Fix Pack for this page">→ Fix Pack</button>';
  }

  return '<div class="oc-task-card ' + tierCls + doneCls + '" data-action-id="' + action.id + '" data-report-id="' + rid + '">'
    + '<div class="oc-tc-header">'
    + '<label class="oc-check-label">'
    + '<input type="checkbox" class="oc-check"' + checked + ' onchange="ocToggleDone(\'' + rid + '\',\'' + action.id + '\',this.checked)">'
    + '<span class="oc-check-box"></span>'
    + '</label>'
    + '<div class="oc-tc-body">'
    + '<div class="oc-tc-top">'
    + '<span class="oc-tier-badge ' + tierBadge + '">' + action.tier + '</span>'
    + '<span class="oc-tc-title">' + ocEsc(action.title) + '</span>'
    + fpBtn
    + '</div>'
    + (meta   ? '<div class="oc-tc-meta">'   + meta   + '</div>' : '')
    + (fields ? '<div class="oc-tc-fields">' + fields + '</div>' : '')
    + '</div>'
    + '</div>'
    + '</div>';
}

function ocRenderTaskList(actions, reportId) {
  if (!actions || !actions.length) {
    return '<div class="oc-no-actions">No structured actions were extracted. See the raw AI output below.</div>';
  }
  var total     = actions.length;
  var doneCount = actions.filter(function(a) { return a.done; }).length;
  var pct       = total ? Math.round((doneCount / total) * 100) : 0;
  var rid       = ocEsc(reportId);

  var high = actions.filter(function(a) { return a.tier === 'HIGH'; });
  var med  = actions.filter(function(a) { return a.tier === 'MEDIUM'; });
  var low  = actions.filter(function(a) { return a.tier === 'LOW'; });

  function grp(items, emoji, label, cls) {
    if (!items.length) return '';
    return '<div class="oc-tier-group">'
      + '<div class="oc-tier-group-hdr ' + cls + '">' + emoji + ' ' + label + ' &mdash; ' + items.length + ' action' + (items.length > 1 ? 's' : '') + '</div>'
      + items.map(function(a) { return ocRenderActionCard(a, reportId); }).join('')
      + '</div>';
  }

  return '<div class="oc-task-list" id="oc-task-list">'
    + '<div class="oc-task-toolbar">'
    + '<div class="oc-progress-wrap">'
    + '<div class="oc-progress-info"><span>' + doneCount + ' / ' + total + ' actions completed</span><span class="oc-pct">' + pct + '%</span></div>'
    + '<div class="oc-progress-bar"><div class="oc-progress-fill" style="width:' + pct + '%"></div></div>'
    + '</div>'
    + '<div class="oc-export-bar">'
    + '<button class="oc-export-btn" onclick="ocExportReport(\'' + rid + '\',\'md\')">⬇ Markdown</button>'
    + '<button class="oc-export-btn" onclick="ocExportReport(\'' + rid + '\',\'html\')">⬇ HTML</button>'
    + '</div>'
    + '</div>'
    + grp(high, '🔴', 'HIGH PRIORITY',   'oc-tgh-high')
    + grp(med,  '🟡', 'MEDIUM PRIORITY', 'oc-tgh-med')
    + grp(low,  '🟢', 'LOW PRIORITY',    'oc-tgh-low')
    + '</div>';
}

function ocOpenFixPack(pageUrl) {
  var bpTab = document.querySelector('.app-tab[data-section="blueprint"]');
  if (bpTab) bpTab.click();
  setTimeout(function() {
    var sel = document.getElementById('rb-page');
    if (!sel) return;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === pageUrl) { sel.selectedIndex = i; break; }
    }
  }, 250);
}

function ocExportReport(reportId, format) {
  var report = ocLoadReport(reportId);
  if (!report) { console.warn('OC export: report not found', reportId); return; }
  var filename, content, mime;
  if (format === 'md') {
    filename = 'seo-cycle-' + report.dates.current.start + '.md';
    content  = ocBuildMarkdown(report);
    mime     = 'text/markdown';
  } else {
    filename = 'seo-cycle-' + report.dates.current.start + '.html';
    content  = ocBuildHTML(report);
    mime     = 'text/html';
  }
  var blob = new Blob([content], { type: mime });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function ocBuildMarkdown(report) {
  var done = report.actions.filter(function(a) { return a.done; }).length;
  var lines = [
    '# SEO Optimization Cycle Report',
    '',
    '**Site:** ' + report.siteUrl,
    '**Period:** ' + report.dates.current.start + ' to ' + report.dates.current.end,
    '**vs Previous:** ' + report.dates.prev.start + ' to ' + report.dates.prev.end,
    '**Generated:** ' + new Date(report.generatedAt).toLocaleString(),
    '**Progress:** ' + done + ' / ' + report.actions.length + ' actions completed',
    ''
  ];
  if (report.totals) {
    lines.push('## Performance Summary', '');
    lines.push('| Metric | Current | Previous |');
    lines.push('|--------|---------|----------|');
    lines.push('| Clicks | ' + (report.totals.currentClicks || 0) + ' | ' + (report.totals.prevClicks || 0) + ' |');
    lines.push('| Impressions | ' + (report.totals.currentImpressions || 0) + ' | ' + (report.totals.prevImpressions || 0) + ' |');
    lines.push('| Avg Position | ' + (report.totals.currentAvgPos || 0).toFixed(1) + ' | ' + (report.totals.prevAvgPos || 0).toFixed(1) + ' |');
    lines.push('');
  }
  lines.push('## Action Plan (' + report.actions.length + ' actions)', '');
  report.actions.forEach(function(a, idx) {
    var status = a.done ? '[x]' : '[ ]';
    lines.push((idx + 1) + '. ' + status + ' **' + a.tier + '** — ' + a.title);
    var meta = [];
    if (a.impact) meta.push('Impact: ' + a.impact);
    if (a.effort) meta.push('Effort: ' + a.effort);
    if (meta.length) lines.push('   > ' + meta.join(' · '));
    if (a.page)    lines.push('   - **Page:** ' + a.page);
    if (a.section) lines.push('   - **Section:** ' + a.section);
    if (a.add)     lines.push('   - **Add/Replace:** `' + a.add + '`');
    if (a.why)     lines.push('   - **Why:** ' + a.why);
    lines.push('');
  });
  lines.push('---', '*Generated by Elitez SEO Audit Tool · AI Optimization Cycle*');
  return lines.join('\n');
}

function ocBuildHTML(report) {
  var done = report.actions.filter(function(a) { return a.done; }).length;
  var pct  = report.actions.length ? Math.round((done / report.actions.length) * 100) : 0;
  var rows = report.actions.map(function(a) {
    var bg  = a.tier === 'HIGH' ? '#fee2e2' : a.tier === 'MEDIUM' ? '#fef3c7' : '#dcfce7';
    var col = a.tier === 'HIGH' ? '#b91c1c' : a.tier === 'MEDIUM' ? '#92400e' : '#15803d';
    var doneStyle = a.done ? ' style="opacity:.5"' : '';
    return '<tr' + doneStyle + '>'
      + '<td><span style="background:' + bg + ';color:' + col + ';border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">' + a.tier + '</span></td>'
      + '<td style="font-weight:600">' + ocEsc(a.title) + '</td>'
      + '<td>' + ocEsc(a.impact || '—') + '</td>'
      + '<td>' + ocEsc(a.effort || '—') + '</td>'
      + '<td>' + (a.page ? '<a href="' + ocEsc(a.page) + '" target="_blank">' + ocEsc(ocShortPath(a.page)) + '</a>' : '—') + '</td>'
      + '<td style="text-align:center">' + (a.done ? '✅' : '⬜') + '</td>'
      + '</tr>';
  }).join('');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<title>SEO Cycle ' + ocEsc(report.dates.current.start) + '</title>'
    + '<style>'
    + 'body{font-family:Inter,system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 24px;color:#1a2b4a;font-size:14px}'
    + 'h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:28px 0 12px;border-bottom:2px solid #e2e8f0;padding-bottom:8px}'
    + '.meta{color:#64748b;font-size:13px;margin:3px 0}'
    + '.prog{background:#e2e8f0;border-radius:6px;height:8px;margin:14px 0 4px;overflow:hidden}'
    + '.prog-fill{background:#6366f1;height:8px;border-radius:6px}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px}'
    + 'th{text-align:left;padding:8px 10px;background:#f8fafc;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}'
    + 'td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}'
    + 'a{color:#6366f1}'
    + 'footer{color:#94a3b8;font-size:12px;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px}'
    + '</style></head><body>'
    + '<h1>SEO Optimization Cycle Report</h1>'
    + '<p class="meta"><strong>Site:</strong> ' + ocEsc(report.siteUrl) + '</p>'
    + '<p class="meta"><strong>Period:</strong> ' + ocEsc(report.dates.current.start) + ' to ' + ocEsc(report.dates.current.end) + ' vs ' + ocEsc(report.dates.prev.start) + ' to ' + ocEsc(report.dates.prev.end) + '</p>'
    + '<p class="meta"><strong>Generated:</strong> ' + new Date(report.generatedAt).toLocaleString() + '</p>'
    + '<p class="meta"><strong>Progress:</strong> ' + done + ' / ' + report.actions.length + ' actions completed (' + pct + '%)</p>'
    + '<div class="prog"><div class="prog-fill" style="width:' + pct + '%"></div></div>'
    + '<h2>Action Plan</h2>'
    + '<table><thead><tr><th>Priority</th><th>Action</th><th>Impact</th><th>Effort</th><th>Page</th><th>Done</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>'
    + '<footer>Generated by Elitez SEO Audit Tool · AI Optimization Cycle</footer>'
    + '</body></html>';
}

function ocRenderHistory(siteUrl) {
  var idx = ocLoadReportIndex().filter(function(r) { return !siteUrl || r.siteUrl === siteUrl; });
  if (!idx.length) return '';
  var opts = idx.map(function(r) {
    var label = r.dates.current.start + ' (' + new Date(r.generatedAt).toLocaleDateString() + ')';
    return '<option value="' + ocEsc(r.id) + '">' + label + '</option>';
  }).join('');
  return '<div class="oc-history-bar">'
    + '<label class="oc-label" for="oc-history-select">Previous Reports</label>'
    + '<select id="oc-history-select" class="oc-select oc-history-select" onchange="ocLoadHistoricReport(this.value)">'
    + '<option value="">— Load a saved report —</option>'
    + opts + '</select></div>';
}

function ocLoadHistoricReport(reportId) {
  if (!reportId) return;
  var report = ocLoadReport(reportId);
  if (!report) { console.warn('OC history: report not found', reportId); return; }
  var outputEl = document.getElementById('oc-output');
  if (!outputEl) return;
  outputEl.style.display = 'block';
  outputEl.innerHTML = '<div class="oc-ai-header">'
    + '<span>📋 Saved Report: ' + ocEsc(report.dates.current.start) + ' → ' + ocEsc(report.dates.current.end) + '</span>'
    + '</div>'
    + '<div class="oc-ai-body">'
    + ocRenderTaskList(report.actions, report.id)
    + '</div>';
  outputEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
