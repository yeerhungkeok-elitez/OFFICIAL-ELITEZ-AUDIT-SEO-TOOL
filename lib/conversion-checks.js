// conversion-checks.js
// Checks the page for conversion signals and messaging clarity.
// Each check returns: { check, status, message }

const cheerio = require('cheerio');

function runConversionChecks(pageData) {
  const { html } = pageData;
  const $ = cheerio.load(html);
  const results = [];

  // We'll use the full lowercase body text for keyword searches
  const bodyClone = $('body').clone();
  bodyClone.find('script, style').remove();
  const bodyText = bodyClone.text().toLowerCase();

  // ── Clear Call-to-Action ──────────────────────────────────────────────────
  const ctaKeywords = [
    'get started', 'book a call', 'book a demo', 'contact us', 'get a quote',
    'start now', 'sign up', 'schedule', 'free consultation', 'learn more',
    'request a demo', 'buy now', 'shop now', 'apply now', 'try free',
    'let\'s talk', "let's work", 'hire us', 'get in touch', 'send a message',
  ];
  const ctaButtons = $('a, button').filter((_, el) => {
    const text = $(el).text().toLowerCase();
    return ctaKeywords.some(kw => text.includes(kw));
  });
  if (ctaButtons.length === 0) {
    results.push({ check: 'Clear CTA', status: 'fail',
      message: 'No clear call-to-action button or link found. Every homepage needs an obvious next step.' });
  } else {
    const firstCTA = ctaButtons.first().text().trim();
    results.push({ check: 'Clear CTA', status: 'pass',
      message: `${ctaButtons.length} CTA(s) found. First one: "${firstCTA}"` });
  }

  // ── Form Present ──────────────────────────────────────────────────────────
  const forms = $('form');
  if (forms.length === 0) {
    results.push({ check: 'Form Present', status: 'warn',
      message: 'No forms found on the page. A contact or lead capture form helps convert visitors.' });
  } else {
    results.push({ check: 'Form Present', status: 'pass',
      message: `${forms.length} form(s) found on the page.` });
  }

  // ── Contact Info Visible ──────────────────────────────────────────────────
  const hasPhone = /(\+?1?\s?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|tel:|phone)/i.test(bodyText);
  const hasEmail = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i.test(bodyText);
  const hasAddress = /(address|street|avenue|suite|\bst\b|\bave\b|location|city|state|zip)/i.test(bodyText);

  if (!hasPhone && !hasEmail) {
    results.push({ check: 'Contact Info', status: 'fail',
      message: 'No phone number or email address found. Make it easy for visitors to reach you.' });
  } else {
    const found = [hasPhone && 'phone', hasEmail && 'email', hasAddress && 'address'].filter(Boolean);
    results.push({ check: 'Contact Info', status: 'pass',
      message: `Contact details found: ${found.join(', ')}.` });
  }

  // ── Trust Signals ─────────────────────────────────────────────────────────
  const trustKeywords = [
    'testimonial', 'review', 'case study', 'trusted by', 'our clients',
    'partner', 'award', 'certified', 'guarantee', 'featured in', 'as seen in',
    'accredited', 'verified', '5-star', '5 star', 'years of experience',
  ];
  const trustFound = trustKeywords.filter(kw => bodyText.includes(kw));
  if (trustFound.length === 0) {
    results.push({ check: 'Trust Signals', status: 'warn',
      message: 'No trust signals detected (testimonials, reviews, certifications, client logos, etc.).' });
  } else {
    results.push({ check: 'Trust Signals', status: 'pass',
      message: `Trust signals found: ${trustFound.slice(0, 4).join(', ')}${trustFound.length > 4 ? '...' : ''}.` });
  }

  // ── Value Proposition Clarity: What do they do? ───────────────────────────
  // Look in the hero / header area first, fall back to full body
  let heroText = '';
  const heroSelectors = ['header', '.hero', '#hero', '[class*="hero"]', 'section:first-of-type', '.banner', '[class*="banner"]'];
  for (const sel of heroSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 20) {
      heroText = el.text().toLowerCase();
      break;
    }
  }
  const searchText = heroText || bodyText;

  const clarityKeywords = [
    'we help', 'we build', 'we create', 'we design', 'we offer',
    'we provide', 'we make', 'we grow', 'we deliver', 'we specialize',
    'agency', 'services', 'solutions', 'experts', 'specialists',
  ];
  const hasClarity = clarityKeywords.some(kw => searchText.includes(kw));
  results.push({
    check: 'Value Proposition',
    status: hasClarity ? 'pass' : 'warn',
    message: hasClarity
      ? 'The page appears to communicate what the business does.'
      : 'It\'s not immediately clear what this business does. Add a clear headline stating your offer.',
  });

  // ── Target Audience: Who do they help? ───────────────────────────────────
  const audienceKeywords = [
    'for businesses', 'for startups', 'for agencies', 'for brands', 'for founders',
    'for entrepreneurs', 'for companies', 'for clients', 'small business',
    'enterprise', 'b2b', 'ecommerce', 'e-commerce', 'coaches', 'consultants',
    'restaurants', 'law firms', 'dentists', 'contractors', 'retailers',
  ];
  const hasAudience = audienceKeywords.some(kw => bodyText.includes(kw));
  results.push({
    check: 'Target Audience Clear',
    status: hasAudience ? 'pass' : 'warn',
    message: hasAudience
      ? 'The site mentions its target audience.'
      : 'It\'s not clear who this business serves. Add language like "We help [type of business] achieve [result]."',
  });

  // ── Clear Next Step / Direction ───────────────────────────────────────────
  const nextStepKeywords = [
    'get started', 'next step', 'how it works', 'what to expect', 'our process',
    'step 1', 'schedule', 'apply', 'contact', 'book',
  ];
  const hasNextStep = nextStepKeywords.some(kw => bodyText.includes(kw));
  results.push({
    check: 'Clear Next Step',
    status: hasNextStep ? 'pass' : 'warn',
    message: hasNextStep
      ? 'The page guides visitors toward a next step.'
      : 'No clear "next step" found. Tell visitors exactly what to do (e.g., "Book a free call", "Fill out this form").',
  });

  return results;
}

module.exports = { runConversionChecks };
