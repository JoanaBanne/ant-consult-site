#!/usr/bin/env node
/*
  Webflow -> static HTML case study migration.

  Reads webflow-casestudy.csv (in this folder) and for every row generates
  projects/<slug>.html by cloning ../case-study-template.html and substituting
  its {{ case.* }} / [[ CASE STUDY: ... ]] placeholder slots with that row's
  real content. Re-run any time the CSV export is refreshed.

  IMPORTANT: the source CSV has no dedicated "Summary Metrics" or "client
  testimonial" columns, and no such data appears anywhere in the rich-text
  body either. Rather than fabricate numbers or quotes, this script removes
  the Summary Metrics grid and the testimonial block entirely from generated
  pages. Add that content by hand (or add proper columns and extend this
  script) when it becomes available.

  The body content also isn't authored under a strict Challenge/Strategy/
  Execution/Results schema -- each case study uses its own freeform section
  headings. This script classifies each heading (h1/h2/h3, whichever level
  Webflow's export happened to use for that row) into the closest matching
  bucket via keyword rules, inheriting the previous bucket for headings that
  don't match a keyword. Review the output -- for freeform source content
  this is a best-effort sort, not a guaranteed-correct one.

  Usage: node projects/migrate-case-studies.js
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(__dirname, 'webflow-casestudy.csv');
const TEMPLATE_PATH = path.join(ROOT, 'case-study-template.html');

// -- CSV parsing (RFC4180-ish: handles quoted fields, embedded commas/newlines, "" escapes) --
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}
function stripTags(str) {
  return String(str || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
}
function replaceAll(str, token, value) {
  return str.split(token).join(value);
}

function formatDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Splits "TITLE / CLIENT" into {client, title}. Splits on the first colon
// when present (matches most rows); otherwise there's no reliable way to
// separate a client name from the title, so both fall back to the same text
// and the caller should flag it for manual review.
function splitTitleClient(raw) {
  const text = (raw || '').trim();
  const idx = text.indexOf(':');
  if (idx > -1) {
    return { client: text.slice(0, idx).trim(), title: text.slice(idx + 1).trim(), inferred: false };
  }
  return { client: text, title: text, inferred: true };
}

// -- Body classification into Challenge / Strategy / Execution / Results --
const EXCLUDE_HEADINGS = [/^client$/i, /^about (ant consult|us)$/i];
const RESULTS_KEYWORDS = /result|outcome|benefit|recommend|deliverable|next step|value deliver/i;
const STRATEGY_KEYWORDS = /brief|role|approach|strategy|solution overview|method|plan/i;
const CHALLENGE_KEYWORDS = /challenge|background|context|objective|executive summary/i;
const EXECUTION_KEYWORDS = /what we did|execution|delivery|implement|construction|site work|key insight/i;

function classifyHeading(text) {
  if (RESULTS_KEYWORDS.test(text)) return 'results';
  if (STRATEGY_KEYWORDS.test(text)) return 'strategy';
  if (CHALLENGE_KEYWORDS.test(text)) return 'challenge';
  if (EXECUTION_KEYWORDS.test(text)) return 'execution';
  return null; // no match -> caller inherits the current bucket
}

function splitBody(bodyHtml) {
  const buckets = { challenge: '', strategy: '', execution: '' , results: '' };
  const headingRe = /<(h1|h2|h3)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  const matches = [...bodyHtml.matchAll(headingRe)];

  if (matches.length === 0) {
    // No headings at all -- keep the whole thing rather than lose it.
    buckets.challenge = bodyHtml;
    return buckets;
  }

  let currentBucket = 'challenge'; // sensible default for any content before the first heading
  if (matches[0].index > 0) {
    buckets[currentBucket] += bodyHtml.slice(0, matches[0].index);
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const headingText = stripTags(m[2]);
    const segStart = m.index + m[0].length;
    const segEnd = i + 1 < matches.length ? matches[i + 1].index : bodyHtml.length;
    const segmentBody = bodyHtml.slice(segStart, segEnd);

    if (!headingText || /^[\s‍]*$/.test(headingText)) continue; // empty/zero-width-joiner artifact
    if (EXCLUDE_HEADINGS.some(re => re.test(headingText))) continue; // redundant metadata (Client / About Ant Consult)

    const isFirstHeadingOverall = i === 0;
    const matched = classifyHeading(headingText);
    if (isFirstHeadingOverall && !matched) continue; // treat as a restated project title, not real content

    if (matched) currentBucket = matched;
    buckets[currentBucket] += `<h3>${escapeHtml(headingText)}</h3>${segmentBody}`;
  }

  return buckets;
}

function estimateReadTime(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// -- Load + prepare the base template once --
let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

const ROOT_PAGES = [
  'index.html','about.html','aim.html','solutions.html','projects.html','insights.html',
  'contact.html','feasibility-studies.html','masterplans.html','commercial-irrigation-design.html',
  'irrigation-upgrades.html','bulk-water-supply.html','system-assessments.html'
];
for (const page of ROOT_PAGES) {
  template = replaceAll(template, `href="${page}"`, `href="../${page}"`);
}
template = replaceAll(template, 'href="insights.html#blog"', 'href="../insights.html#blog"');
template = replaceAll(template, 'src="assets/logo.png"', 'src="../assets/logo.png"');
template = replaceAll(template, 'href="assets/favicon.png"', 'href="../assets/favicon.png"');

// Strip the template-only field-map legend comment and placeholder-only CSS.
template = template.replace(/\n<!--\n\s*={10,}[\s\S]*?={10,}\n-->\n/, '\n');
template = template.replace(/\s*\.field-slot \{[^}]*\}\n/, '\n');
template = template.replace(/\s*\.field-tag \{[^}]*\}\n/, '\n');

const CASE_BODY_CSS = `
  .case-body h3 { font-family:'Ubuntu',sans-serif; font-size:22px; font-weight:500; color:#12312F; line-height:1.24; letter-spacing:-0.01em; margin:28px 0 14px; }
  .case-body h3:first-child { margin-top:0; }
  .case-body h4 { font-family:'Ubuntu',sans-serif; font-size:18px; font-weight:500; color:#12312F; margin:20px 0 10px; }
  .case-body p { font-size:17px; line-height:1.75; color:#2A3A38; margin:0 0 18px; }
  .case-body ul,.case-body ol { font-size:17px; line-height:1.75; color:#2A3A38; margin:0 0 18px; padding-left:22px; }
  .case-body li { margin-bottom:6px; }
  .case-body a { color:#05515B; text-decoration:underline; }
  .case-body a:hover { color:#B96A22; }
  .case-body strong { font-weight:600; color:#12312F; }
</style>`;
template = template.replace('</style>', CASE_BODY_CSS);

const META_ROW_BLOCK = `    <div style="display:flex; align-items:center; gap:32px; font-size:14px; color:#5E6E6A; flex-wrap:wrap;">
      <div><span style="text-transform:uppercase; letter-spacing:0.1em; font-size:11px; color:#B96A22; font-weight:600; display:block; margin-bottom:4px;">Client</span>{{ case.client_name }}</div>
      <div><span style="text-transform:uppercase; letter-spacing:0.1em; font-size:11px; color:#B96A22; font-weight:600; display:block; margin-bottom:4px;">Location</span>{{ case.location }}</div>
      <div><span style="text-transform:uppercase; letter-spacing:0.1em; font-size:11px; color:#B96A22; font-weight:600; display:block; margin-bottom:4px;">Completed</span>{{ case.completion_date }}</div>
    </div>`;

const HERO_IMAGE_BLOCK = `  <!-- HERO IMAGE (field: Hero Image) -->
  <div class="field-slot" style="height:460px; margin:0 72px; display:flex; align-items:center; justify-content:center; text-align:center;">
    <div>
      <div class="field-tag">Case study field</div>
      <div style="font-family:'Ubuntu',sans-serif; font-size:20px; font-weight:500; color:#05515B; margin-top:14px;">[[ CASE STUDY: HERO IMAGE ]]</div>
      <div style="font-size:13px; color:#5E6E6A; margin-top:6px;">Bind this block's background-image to the project's hero photo</div>
    </div>
  </div>`;

const SUMMARY_METRICS_BLOCK_RE = /\n  <!-- SUMMARY METRICS -->[\s\S]*?\n  <\/div>\n\n(?=  <!-- THE CHALLENGE -->)/;

const CHALLENGE_BLOCK = `  <!-- THE CHALLENGE -->
  <div style="display:flex; justify-content:center; padding:64px 72px 0;">
    <div style="max-width:760px; width:100%;">
      <h2 style="font-family:'Ubuntu',sans-serif; font-size:34px; line-height:1.16; font-weight:500; letter-spacing:-0.015em; color:#12312F; margin:0 0 24px;">The Challenge</h2>
      <div class="field-slot" style="padding:32px;">
        <div class="field-tag" style="margin-bottom:18px;">[[ CASE STUDY: THE CHALLENGE — rich text field ]]</div>
        <p style="font-size:17px; line-height:1.75; color:#2A3A38; margin:0;">Placeholder copy. Describe the problem the client came to Ant Consult with: what was failing, what it was costing them, and what constraints (budget, timeline, site conditions) shaped the brief.</p>
      </div>
    </div>
  </div>`;

const STRATEGY_BLOCK = `  <!-- THE STRATEGY -->
  <div style="display:flex; justify-content:center; padding:56px 72px 0;">
    <div style="max-width:760px; width:100%;">
      <h2 style="font-family:'Ubuntu',sans-serif; font-size:34px; line-height:1.16; font-weight:500; letter-spacing:-0.015em; color:#12312F; margin:0 0 24px;">The Strategy</h2>
      <div class="field-slot" style="padding:32px;">
        <div class="field-tag" style="margin-bottom:18px;">[[ CASE STUDY: THE STRATEGY — rich text field ]]</div>
        <p style="font-size:17px; line-height:1.75; color:#2A3A38; margin:0;">Placeholder copy. Explain the approach Ant Consult proposed and why: the design principles applied, the trade-offs weighed, and how this option beat the alternatives on lifecycle cost.</p>
      </div>
    </div>
  </div>`;

const EXECUTION_BLOCK = `  <!-- THE EXECUTION -->
  <div style="display:flex; justify-content:center; padding:56px 72px 0;">
    <div style="max-width:760px; width:100%;">
      <h2 style="font-family:'Ubuntu',sans-serif; font-size:34px; line-height:1.16; font-weight:500; letter-spacing:-0.015em; color:#12312F; margin:0 0 24px;">The Execution</h2>
      <div class="field-slot" style="height:320px; margin-bottom:24px; display:flex; align-items:center; justify-content:center; text-align:center;">
        <div>
          <div class="field-tag">Case study field</div>
          <div style="font-family:'Ubuntu',sans-serif; font-size:18px; font-weight:500; color:#05515B; margin-top:12px;">[[ CASE STUDY: EXECUTION IMAGE ]]</div>
        </div>
      </div>
      <div class="field-slot" style="padding:32px;">
        <div class="field-tag" style="margin-bottom:18px;">[[ CASE STUDY: THE EXECUTION — rich text field ]]</div>
        <p style="font-size:17px; line-height:1.75; color:#2A3A38; margin:0;">Placeholder copy. Walk through how the project was delivered: phasing, site visits, who was involved, and how issues that came up during construction were handled.</p>
      </div>
    </div>
  </div>`;

const RESULTS_AND_QUOTE_BLOCK = `  <!-- RESULTS -->
  <div style="display:flex; justify-content:center; padding:56px 72px 64px;">
    <div style="max-width:760px; width:100%;">
      <h2 style="font-family:'Ubuntu',sans-serif; font-size:34px; line-height:1.16; font-weight:500; letter-spacing:-0.015em; color:#12312F; margin:0 0 24px;">Results</h2>
      <div class="field-slot" style="padding:32px; margin-bottom:24px;">
        <div class="field-tag" style="margin-bottom:18px;">[[ CASE STUDY: RESULTS — rich text field ]]</div>
        <p style="font-size:17px; line-height:1.75; color:#2A3A38; margin:0;">Placeholder copy. Tie the outcome back to the summary metrics above: what changed for the client, and what it means for them going forward.</p>
      </div>
      <div style="background:#05515B; border-radius:18px; padding:40px; color:#fff;">
        <p style="font-family:'Ubuntu',sans-serif; font-size:22px; line-height:1.5; margin:0 0 20px;">"{{ case.quote_text }}"</p>
        <div style="font-size:15px; font-weight:600;">{{ case.quote_name }}</div>
        <div style="font-size:13px; color:#F8C08C; margin-top:3px;">{{ case.quote_title }}</div>
      </div>
    </div>
  </div>`;

for (const [name, block] of [
  ['META_ROW_BLOCK', META_ROW_BLOCK], ['HERO_IMAGE_BLOCK', HERO_IMAGE_BLOCK],
  ['CHALLENGE_BLOCK', CHALLENGE_BLOCK], ['STRATEGY_BLOCK', STRATEGY_BLOCK],
  ['EXECUTION_BLOCK', EXECUTION_BLOCK], ['RESULTS_AND_QUOTE_BLOCK', RESULTS_AND_QUOTE_BLOCK],
]) {
  if (!template.includes(block)) throw new Error(`${name} not found in template — has case-study-template.html changed?`);
}
if (!SUMMARY_METRICS_BLOCK_RE.test(template)) throw new Error('Summary metrics block not found — has case-study-template.html changed?');

function sectionOrFallback(heading, html, fallbackNote) {
  if (!html || !html.trim()) return '';
  return `  <!-- ${heading.toUpperCase()} -->
  <div style="display:flex; justify-content:center; padding:56px 72px 0;">
    <div style="max-width:760px; width:100%;">
      <h2 style="font-family:'Ubuntu',sans-serif; font-size:34px; line-height:1.16; font-weight:500; letter-spacing:-0.015em; color:#12312F; margin:0 0 24px;">${heading}</h2>
      <div class="case-body">${html}</div>
    </div>
  </div>`;
}

// -- Load + parse the CSV --
const csvRaw = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parseCSV(csvRaw);
const header = rows[0];
const records = rows.slice(1).filter(r => r.length > 1 && r.some(v => v.trim() !== ''));

const report = [];

for (const r of records) {
  const rec = {};
  header.forEach((h, idx) => { rec[h] = r[idx] || ''; });

  const slug = rec['Slug'].trim();
  if (!slug) { report.push({ title: rec['TITLE / CLIENT'], slug: '(missing)', status: 'SKIPPED — no slug' }); continue; }
  if (!/^[a-z0-9-]+$/.test(slug)) { report.push({ title: rec['TITLE / CLIENT'], slug, status: 'SKIPPED — slug has unexpected characters' }); continue; }

  const isDraft = rec['Draft'].trim().toLowerCase() === 'true';
  const isArchived = rec['Archived'].trim().toLowerCase() === 'true';
  const { client, title, inferred: clientInferred } = splitTitleClient(rec['TITLE / CLIENT']);
  const sector = rec['Project Type'].trim() || 'Case Study';
  const dateStr = formatDate(rec['Published On']) || formatDate(rec['Created On']) || 'Undated';
  const summary = rec['Case Study Summary'].trim();
  const imageUrl = rec['Image'].trim();
  const buckets = splitBody(rec['Case Study Body']);

  let page = template;

  page = replaceAll(page, '{{ case.meta_title }}', escapeHtml(title));
  page = replaceAll(page, '{{ case.meta_description }}', escapeAttr(summary));
  page = replaceAll(page, '{{ case.sector }}', escapeHtml(sector));
  page = replaceAll(page, '{{ case.project_title }}', escapeHtml(title));

  const metaRowReplacement = `    <div style="display:flex; align-items:center; gap:32px; font-size:14px; color:#5E6E6A; flex-wrap:wrap;">
      <div><span style="text-transform:uppercase; letter-spacing:0.1em; font-size:11px; color:#B96A22; font-weight:600; display:block; margin-bottom:4px;">Client</span>${escapeHtml(client)}</div>
      <div><span style="text-transform:uppercase; letter-spacing:0.1em; font-size:11px; color:#B96A22; font-weight:600; display:block; margin-bottom:4px;">Completed</span>${escapeHtml(dateStr)}</div>
    </div>`;
  page = page.replace(META_ROW_BLOCK, metaRowReplacement);

  const heroImageReplacement = imageUrl
    ? `  <!-- HERO IMAGE -->\n  <div role="img" aria-label="${escapeAttr(title)}" style="height:460px; margin:0 72px; border-radius:18px; background:#E3EFEC url('${escapeAttr(imageUrl)}') center/cover no-repeat;"></div>`
    : `  <!-- HERO IMAGE (none provided in source data) -->\n  <div style="height:460px; margin:0 72px; border-radius:18px; background:#E3EFEC;"></div>`;
  page = page.replace(HERO_IMAGE_BLOCK, heroImageReplacement);

  // No structured metrics data exists in the source -- drop the section rather than show empty/fake stats.
  page = page.replace(SUMMARY_METRICS_BLOCK_RE, '\n');

  page = page.replace(CHALLENGE_BLOCK, sectionOrFallback('The Challenge', buckets.challenge));
  page = page.replace(STRATEGY_BLOCK, sectionOrFallback('The Strategy', buckets.strategy));
  page = page.replace(EXECUTION_BLOCK, sectionOrFallback('The Execution', buckets.execution));
  // No testimonial data exists in the source -- drop the quote block, keep Results if there's content.
  page = page.replace(RESULTS_AND_QUOTE_BLOCK, sectionOrFallback('Results', buckets.results));

  if (isDraft) {
    page = page.replace('<meta name="description"', '<meta name="robots" content="noindex">\n<meta name="description"');
  }

  const outPath = path.join(__dirname, `${slug}.html`);
  fs.writeFileSync(outPath, page, 'utf8');

  const emptyBuckets = ['challenge', 'strategy', 'execution', 'results'].filter(k => !buckets[k].trim());
  report.push({
    title, slug, client, clientInferred, sector, date: dateStr,
    status: isArchived ? 'ARCHIVED (generated anyway)' : (isDraft ? 'DRAFT (noindex added)' : 'Published'),
    hasImage: !!imageUrl, emptyBuckets, readTime: estimateReadTime(rec['Case Study Body']),
  });
}

console.log(`\nGenerated ${report.filter(r => !String(r.status || '').startsWith('SKIPPED')).length} of ${records.length} rows into projects/\n`);
for (const r of report) {
  console.log(`- ${r.slug}.html  [${r.status}]  "${r.title}"`);
  if (r.client) console.log(`    client: "${r.client}"${r.clientInferred ? '  (no ":" separator in source — client name could not be reliably separated from the title; verify by hand)' : ''}`);
  if (r.sector) console.log(`    sector: ${r.sector}   date: ${r.date}   image: ${r.hasImage ? 'yes' : 'NO (fallback color band used)'}`);
  if (r.emptyBuckets && r.emptyBuckets.length) console.log(`    no content classified into: ${r.emptyBuckets.join(', ')} (section omitted from page)`);
}
console.log('\nNote: no Summary Metrics or client testimonial data exists anywhere in the source CSV — both sections were omitted from every generated page. Add real numbers/quotes by hand, or extend the CSV and re-run this script.');
