// Load environment variables from .env file
require('dotenv').config();

const { fetchPage }          = require('./lib/fetcher');
const { runSEOChecks }       = require('./lib/seo-checks');
const { runConversionChecks }= require('./lib/conversion-checks');
const { generateReport }     = require('./lib/reporter');
const fs   = require('fs');
const path = require('path');

// ─── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const url = process.argv[2];

  if (!url) {
    console.log('\nUsage:   node audit.js <url>');
    console.log('Example: node audit.js https://example.com\n');
    process.exit(1);
  }

  // Validate it looks like a URL
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.error('\nError: URL must start with http:// or https://\n');
    process.exit(1);
  }

  console.log(`\nStarting audit for: ${url}`);
  console.log('─'.repeat(55));

  try {
    // Step 1 – Download the page (+ robots.txt and sitemap.xml)
    console.log('  Fetching page...');
    const pageData = await fetchPage(url);

    // Step 2 – Run SEO checks
    console.log('  Running SEO checks...');
    const seoResults = runSEOChecks(pageData);

    // Step 3 – Run conversion / messaging checks
    console.log('  Running conversion checks...');
    const conversionResults = runConversionChecks(pageData);

    // Step 4 – Ask Claude to write the final report
    console.log('  Generating report with Claude (this takes ~15 seconds)...');
    const report = await generateReport(url, seoResults, conversionResults);

    // Step 5 – Save the report to /reports
    const reportsDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const domain    = new URL(url).hostname.replace(/\./g, '_');
    const filename  = `${domain}_${timestamp}.md`;
    const filepath  = path.join(reportsDir, filename);

    fs.writeFileSync(filepath, report, 'utf8');

    console.log('\n Audit complete!');
    console.log(`Report saved to: reports/${filename}`);
    console.log('─'.repeat(55));
    console.log('\n' + report);

  } catch (err) {
    console.error('\nError:', err.message);
    if (err.response) {
      // Axios HTTP error — show the URL that failed
      console.error('Failed URL:', err.config?.url);
      console.error('Status:', err.response.status);
    }
    process.exit(1);
  }
}

main();
