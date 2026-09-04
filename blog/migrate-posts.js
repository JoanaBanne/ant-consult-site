#!/usr/bin/env node
/*
  Webflow -> static HTML blog migration.

  Reads webflow-blog.csv (in this folder), and for every row generates
  blog/<slug>.html by cloning ../blog-template.html and substituting its
  {{ webflow.* }} / [[ WEBFLOW CMS: ... ]] placeholder slots with that
  row's real content. Re-run any time the CSV export is refreshed.

  Usage: node blog/migrate-posts.js
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(__dirname, 'webflow-blog.csv');
const TEMPLATE_PATH = path.join(ROOT, 'blog-template.html');

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

function humanizeAuthor(slug) {
  if (!slug || !slug.trim()) return 'Ant Consult Team';
  return slug.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function initials(name) {
  const parts = name.split(' ').filter(Boolean);
  return parts.slice(0, 2).map(p => p[0].toUpperCase()).join('') || 'AC';
}

function formatDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function estimateReadTime(bodyHtml) {
  const text = String(bodyHtml || '').replace(/<[^>]+>/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function replaceAll(str, token, value) {
  return str.split(token).join(value);
}

// -- Load + prepare the base template once --
let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

// Path-fix every root-relative link/asset for the one-level-deep /blog/ subfolder.
// (The root-absolute "/assets/ant-consult-paia-manual.pdf" link needs no change.)
const ROOT_PAGES = [
  'index.html','about.html','aim.html','solutions.html','projects.html','insights.html',
  'contact.html','feasibility-studies.html','masterplans.html','commercial-irrigation-design.html',
  'irrigation-upgrades.html','bulk-water-supply.html','system-assessments.html'
];
for (const page of ROOT_PAGES) {
  template = replaceAll(template, `href="${page}"`, `href="../${page}"`);
}
template = replaceAll(template, 'src="assets/logo.png"', 'src="../assets/logo.png"');
template = replaceAll(template, 'href="assets/favicon.png"', 'href="../assets/favicon.png"');

// Strip the template-only CMS legend comment and placeholder-only CSS — these
// generated pages carry real content, not a framework demo.
template = template.replace(/\n<!--\n\s*={10,}[\s\S]*?={10,}\n-->\n/, '\n');
template = template.replace(/\s*\.cms-slot \{[^}]*\}\n/, '\n');
template = template.replace(/\s*\.cms-tag \{[^}]*\}\n/, '\n');

const POST_BODY_CSS = `
  .post-body h1,.post-body h2,.post-body h3,.post-body h4 { font-family:'Ubuntu',sans-serif; font-weight:500; color:#12312F; line-height:1.24; letter-spacing:-0.01em; }
  .post-body h1 { font-size:32px; margin:36px 0 16px; }
  .post-body h2 { font-size:28px; margin:36px 0 16px; }
  .post-body h3 { font-size:22px; margin:28px 0 14px; }
  .post-body h4 { font-size:18px; margin:24px 0 12px; }
  .post-body p { font-size:17px; line-height:1.75; color:#2A3A38; margin:0 0 20px; }
  .post-body ul,.post-body ol { font-size:17px; line-height:1.75; color:#2A3A38; margin:0 0 20px; padding-left:22px; }
  .post-body li { margin-bottom:8px; }
  .post-body a { color:#05515B; text-decoration:underline; }
  .post-body a:hover { color:#B96A22; }
  .post-body strong { font-weight:600; color:#12312F; }
  .post-body img { max-width:100%; height:auto; border-radius:12px; margin:8px 0 24px; display:block; }
  .post-body figure { margin:0 0 24px; }
  .post-body figcaption { font-size:13px; color:#5E6E6A; margin-top:8px; }
</style>`;
template = template.replace('</style>', POST_BODY_CSS);

const FEATURED_IMAGE_BLOCK = `  <!-- FEATURED IMAGE (Webflow CMS field: Featured Image) -->
  <div class="cms-slot" style="height:440px; margin:0 72px; display:flex; align-items:center; justify-content:center; text-align:center;">
    <div>
      <div class="cms-tag">Webflow CMS field</div>
      <div style="font-family:'Ubuntu',sans-serif; font-size:20px; font-weight:500; color:#05515B; margin-top:14px;">[[ WEBFLOW CMS: FEATURED IMAGE ]]</div>
      <div style="font-size:13px; color:#5E6E6A; margin-top:6px;">Bind this block's background-image to the post's Featured Image field</div>
    </div>
  </div>`;

const POST_BODY_BLOCK = `      <!-- POST BODY (Webflow CMS field: Post Body — Rich Text) -->
      <div class="cms-slot" style="padding:36px;">
        <div class="cms-tag" style="margin-bottom:20px;">[[ WEBFLOW CMS: POST BODY — Rich Text field ]]</div>
        <h2 style="font-family:'Ubuntu',sans-serif; font-size:28px; line-height:1.24; font-weight:500; color:#12312F; margin:0 0 16px;">Example heading rendered from the rich text field</h2>
        <p style="font-size:17px; line-height:1.75; color:#2A3A38; margin:0 0 20px;">Example body paragraph. Everything inside this dashed box is placeholder copy showing how the Webflow rich-text editor's output (headings, paragraphs, lists, links, images) should inherit this page's typography once the real Post Body field is bound here.</p>
        <p style="font-size:17px; line-height:1.75; color:#2A3A38; margin:0 0 20px;">A second placeholder paragraph, so line-height and paragraph spacing can be checked against real multi-paragraph content.</p>
        <ul style="font-size:17px; line-height:1.75; color:#2A3A38; margin:0 0 20px; padding-left:22px;">
          <li>Example list item one</li>
          <li>Example list item two</li>
        </ul>
      </div>`;

const AUTHOR_PHOTO_BLOCK = `<div class="cms-slot" style="width:56px; height:56px; border-radius:50%; flex:none; display:flex; align-items:center; justify-content:center; font-size:9px; color:#5E6E6A; text-align:center; line-height:1.3;">[[ AUTHOR<br>PHOTO ]]</div>`;

if (!template.includes(FEATURED_IMAGE_BLOCK)) throw new Error('Featured image placeholder block not found in template — has blog-template.html changed?');
if (!template.includes(POST_BODY_BLOCK)) throw new Error('Post body placeholder block not found in template — has blog-template.html changed?');
if (!template.includes(AUTHOR_PHOTO_BLOCK)) throw new Error('Author photo placeholder block not found in template — has blog-template.html changed?');

// -- Load + parse the CSV --
const csvRaw = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parseCSV(csvRaw);
const header = rows[0];
const records = rows.slice(1).filter(r => r.length > 1 && r.some(v => v.trim() !== ''));

const report = [];

for (const r of records) {
  const rec = {};
  header.forEach((h, idx) => { rec[h] = r[idx] || ''; });

  const title = rec['Name'].trim();
  const slug = rec['Slug'].trim();
  if (!slug) { report.push({ title, slug: '(missing)', status: 'SKIPPED — no slug' }); continue; }
  if (!/^[a-z0-9-]+$/.test(slug)) { report.push({ title, slug, status: 'SKIPPED — slug has unexpected characters' }); continue; }

  const isDraft = rec['Draft'].trim().toLowerCase() === 'true';
  const isArchived = rec['Archived'].trim().toLowerCase() === 'true';
  const authorName = humanizeAuthor(rec['Author'].trim());
  const authorTitle = 'Ant Consult Team';
  const dateStr = formatDate(rec['Published On']) || formatDate(rec['Created On']) || 'Undated';
  const readTime = estimateReadTime(rec['Blog Post Text']);
  const summary = rec['Blog Post Summary'].trim();
  const imageUrl = rec['Blog Post Image'].trim();
  const bodyHtml = rec['Blog Post Text'];

  let page = template;

  page = replaceAll(page, '{{ webflow.meta_title }}', escapeHtml(title));
  page = replaceAll(page, '{{ webflow.meta_description }}', escapeAttr(summary));
  page = replaceAll(page, '{{ webflow.category }}', 'Insights');
  page = replaceAll(page, '{{ webflow.post_title }}', escapeHtml(title));
  page = replaceAll(page, '{{ webflow.author_name }}', escapeHtml(authorName));
  page = replaceAll(page, '{{ webflow.author_title }}', escapeHtml(authorTitle));
  page = replaceAll(page, '{{ webflow.publish_date }}', escapeHtml(dateStr));
  page = replaceAll(page, '{{ webflow.read_time }}', String(readTime));

  const featuredImageReplacement = imageUrl
    ? `  <!-- FEATURED IMAGE -->\n  <div role="img" aria-label="${escapeAttr(title)}" style="height:440px; margin:0 72px; border-radius:18px; background:#E3EFEC url('${escapeAttr(imageUrl)}') center/cover no-repeat;"></div>`
    : `  <!-- FEATURED IMAGE (none provided in CMS export) -->\n  <div style="height:440px; margin:0 72px; border-radius:18px; background:#E3EFEC;"></div>`;
  page = page.replace(FEATURED_IMAGE_BLOCK, featuredImageReplacement);

  const postBodyReplacement = `      <!-- POST BODY -->\n      <div class="post-body">${bodyHtml}</div>`;
  page = page.replace(POST_BODY_BLOCK, postBodyReplacement);

  const authorPhotoReplacement = `<div style="width:56px; height:56px; border-radius:50%; flex:none; display:flex; align-items:center; justify-content:center; background:#05515B; color:#fff; font-family:'Ubuntu',sans-serif; font-size:16px; font-weight:500;">${escapeHtml(initials(authorName))}</div>`;
  page = page.replace(AUTHOR_PHOTO_BLOCK, authorPhotoReplacement);

  if (isDraft) {
    page = page.replace('<meta name="description"', '<meta name="robots" content="noindex">\n<meta name="description"');
  }

  const outPath = path.join(__dirname, `${slug}.html`);
  fs.writeFileSync(outPath, page, 'utf8');

  report.push({
    title, slug, status: isArchived ? 'ARCHIVED (generated anyway)' : (isDraft ? 'DRAFT (noindex added)' : 'Published'),
    date: dateStr, author: authorName, hasImage: !!imageUrl, readTime
  });
}

console.log(`\nGenerated ${report.filter(r => r.status !== undefined && !String(r.status).startsWith('SKIPPED')).length} of ${records.length} rows into blog/\n`);
for (const r of report) {
  console.log(`- ${r.slug}.html  [${r.status}]  "${r.title}"${r.date ? `  ${r.date}` : ''}${r.hasImage === false ? '  (no featured image in CSV)' : ''}`);
}
