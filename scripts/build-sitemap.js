#!/usr/bin/env node
/**
 * build-sitemap.js — regenerate sitemap.xml from the live catalogue.
 *
 *   node scripts/build-sitemap.js            # write sitemap.xml
 *   node scripts/build-sitemap.js --dry-run  # print, change nothing
 *   node scripts/build-sitemap.js --json     # machine-readable summary
 *
 * Why this exists
 * ---------------
 * sitemap.xml used to be a hand-maintained file containing a single URL — even
 * though the site now serves real pages at /coupon/:id, /store/:id and
 * /category/:id. Hand-maintained SEO files always drift; this derives the
 * sitemap from data/*.json so it cannot.
 *
 * Indexing policy
 * ---------------
 * Only pages with real content are listed. A store with zero coupons renders an
 * empty page, which is thin content, so it is excluded here AND marked
 * <meta name="robots" content="noindex,follow"> by api/page.js. Both halves are
 * needed: the sitemap keeps crawlers out, the meta tag keeps out those that
 * arrive by another route.
 *
 * Expired coupons are excluded — linking to a dead offer is worse than not
 * linking at all.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('../api/_secrets.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const AS_JSON = has('--json');
const DRY_RUN = has('--dry-run');

const SITE = (S.env('SITE_URL', 'https://nipcoupon.vercel.app').trim() || 'https://nipcoupon.vercel.app').replace(/\/+$/, '');

function read(f) {
  return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Today, YYYY-MM-DD — used as lastmod for pages without a meaningful date. */
function today() { return new Date().toISOString().slice(0, 10); }

/* ── lastmod state ───────────────────────────────────────────────────────────
 * A sitemap that stamps every URL with today's date on every build is telling
 * crawlers "everything changed" daily. Google learns to distrust that and the
 * signal stops working.
 *
 * So: hash the fields that actually affect the rendered page, and only advance
 * lastmod when the hash moves. State lives in data/.sitemap-state.json —
 * committed, because a CI runner starts from a fresh checkout and would
 * otherwise reset every date on every run. */
const crypto = require('crypto');
const STATE_FILE = path.join(DATA, '.sitemap-state.json');

const prevState = (function () {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { entries: {} }; }
})();
const nextState = { updated: new Date().toISOString(), entries: {} };

function hashOf(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/**
 * lastmod for a URL, advanced only when its content hash changes.
 *
 *   unchanged since last build → keep the recorded date
 *   changed since last build   → today (it just changed)
 *   never seen before          → `firstSeen`, or today
 *
 * The three cases are distinct: a modified entry must read today, not the date
 * the offer was originally added, or an edit would look older than it is.
 */
function trackedLastmod(key, fingerprint, firstSeen) {
  const h = hashOf(fingerprint);
  const prev = prevState.entries && prevState.entries[key];
  let date;
  if (prev && prev.lastmod) date = prev.hash === h ? prev.lastmod : today();
  else date = firstSeen || today();
  if (date > today()) date = today();   // never emit a future lastmod
  nextState.entries[key] = { hash: h, lastmod: date };
  return date;
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2) + '\n');
}

/* First-seen date for an offer, from addedDaysAgo. Used only the first time a
   coupon appears — after that trackedLastmod preserves the recorded date. Never
   returns a future date. */
function addedLastmod(c) {
  const n = Number(c.addedDaysAgo);
  if (!Number.isFinite(n) || n < 0) return today();
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

/** lastmod must be a valid date; fall back to today rather than emit junk. */
function lastmod(value) {
  if (!value) return today();
  const t = Date.parse(value);
  return Number.isNaN(t) ? today() : new Date(t).toISOString().slice(0, 10);
}

const stores = read('stores.json').stores || [];
const coupons = read('coupons.json').coupons || [];
const categories = read('categories.json').categories || [];

const now = Date.now();
const live = coupons.filter(c => !(c.active === false));
const fresh = live.filter(c => {
  if (!c.expires) return true;
  const t = Date.parse(c.expires);
  return Number.isNaN(t) || t >= now;
});

/* How many live coupons each store / category actually has. */
const perStore = {};
const perCat = {};
fresh.forEach(c => {
  perStore[c.storeId] = (perStore[c.storeId] || 0) + 1;
  perCat[c.categoryId] = (perCat[c.categoryId] || 0) + 1;
});

const urls = [];

/* Home — the highest-value page. Its fingerprint is the whole live catalogue,
   so lastmod moves whenever any offer appears, changes or expires. */
urls.push({
  kind: 'home',
  loc: SITE + '/',
  lastmod: trackedLastmod('home', fresh.map(c => c.id + ':' + (c.code || '') + ':' + (c.expires || ''))),
  changefreq: 'daily',
  priority: '1.0'
});

/* Categories that have deals. */
categories.filter(c => (perCat[c.id] || 0) > 0).forEach(c => {
  const members = fresh.filter(x => x.categoryId === c.id)
    .map(x => x.id + ':' + (x.code || '') + ':' + (x.expires || ''));
  urls.push({
    kind: 'category',
    loc: SITE + '/category/' + encodeURIComponent(c.id),
    lastmod: trackedLastmod('category:' + c.id, { name: c.name, members }),
    changefreq: 'daily',
    priority: '0.8'
  });
});

/* Stores that have deals — the 30 empty ones stay out by design.
 *
 * Priority scales with inventory depth. A store page carrying 5 live offers is
 * a materially better landing page than one carrying a single offer, and
 * store pages are the highest-intent long-tail surface on the site
 * ("<brand> discount codes"), so they outrank category pages when deep. */
stores.filter(s => (perStore[s.id] || 0) > 0).forEach(s => {
  const n = perStore[s.id] || 0;
  const members = fresh.filter(x => x.storeId === s.id)
    .map(x => x.id + ':' + (x.code || '') + ':' + (x.expires || ''));
  urls.push({
    kind: 'store',
    loc: SITE + '/store/' + encodeURIComponent(s.id),
    lastmod: trackedLastmod('store:' + s.id, { name: s.name, url: s.url, members }),
    changefreq: 'daily',
    priority: n >= 5 ? '0.9' : n >= 3 ? '0.8' : '0.7'
  });
});

/* Individual offers. Fingerprint covers everything the rendered page shows, so
   a re-verified-but-unchanged offer keeps its existing lastmod. */
fresh.forEach(c => {
  urls.push({
    kind: 'coupon',
    loc: SITE + '/coupon/' + encodeURIComponent(c.id),
    /* Fallback is today, NOT c.expires. lastmod means "last modified"; an
       expiry date is in the future, and a future lastmod is invalid per the
       sitemap spec — Google ignores the whole element when it sees one. */
    lastmod: trackedLastmod('coupon:' + c.id, {
      title: c.title, code: c.code || '', expires: c.expires || '',
      value: c.value, type: c.type, terms: c.terms || [], storeId: c.storeId
    }, addedLastmod(c)),
    changefreq: 'weekly',
    priority: c.hot ? '0.6' : '0.5'
  });
});

/* ── hreflang ────────────────────────────────────────────────────────────────
 * Every URL is published in two languages, so every entry declares both plus
 * an x-default. Without this Google can only guess which language to rank for
 * which market, and Arabic pages end up competing with their English twins.
 *
 * Locales come from locales/*.json, the same source api/i18n.js serves, so
 * dropping in fr.json adds French here on the next build with no edit. */
const LOCALES_DIR = path.join(ROOT, 'locales');
const LOCALES = (function () {
  try {
    return fs.readdirSync(LOCALES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort();
  } catch (e) {
    return ['en'];
  }
})();
const DEFAULT_LOCALE = LOCALES.indexOf('en') !== -1 ? 'en' : LOCALES[0];

function alternates(loc) {
  const join = loc.indexOf('?') === -1 ? '?' : '&';
  return LOCALES.map(l =>
    '    <xhtml:link rel="alternate" hreflang="' + l + '" href="' + esc(loc + join + 'lang=' + l) + '"/>'
  ).concat([
    '    <xhtml:link rel="alternate" hreflang="x-default" href="' + esc(loc) + '"/>'
  ]).join('\n');
}

const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!-- Generated by scripts/build-sitemap.js — do not edit by hand. -->\n' +
  '<!-- ' + urls.length + ' URLs · ' + LOCALES.length + ' locales · ' + new Date().toISOString() + ' -->\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
  '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
  urls.map(u =>
    '  <url>\n' +
    '    <loc>' + esc(u.loc) + '</loc>\n' +
    alternates(u.loc) + '\n' +
    '    <lastmod>' + u.lastmod + '</lastmod>\n' +
    '    <changefreq>' + u.changefreq + '</changefreq>\n' +
    '    <priority>' + u.priority + '</priority>\n' +
    '  </url>'
  ).join('\n') +
  '\n</urlset>\n';

/* ── Split sitemaps ──────────────────────────────────────────────────────────
 * One file per content type, behind a sitemap index:
 *
 *   sitemap.xml            index → the three below
 *   sitemap-pages.xml      home + categories
 *   sitemap-stores.xml     /store/:id
 *   sitemap-coupons.xml    /coupon/:id
 *
 * Why split. Search Console reports coverage per submitted sitemap, so a split
 * turns "86 URLs, 3 problems" into "coupons: 3 problems, stores: clean" — you
 * can see which content type is failing without inspecting URLs one by one.
 * Coupons also churn far faster than stores; separating them means a crawler
 * revisiting the coupon file is not re-reading 45 store entries that have not
 * moved.
 *
 * sitemap.xml stays the index, so the reference in robots.txt and anything
 * already submitted to Search Console keeps working.
 *
 * LASTMOD
 * -------
 * Per-section lastmod is the max of the entry lastmods in that section, not
 * "now". Stamping every file with today's date on every build teaches crawlers
 * the signal is noise. Entry-level lastmod for a coupon comes from a content
 * hash recorded in data/.sitemap-state.json: if the offer's indexable fields
 * are unchanged since the last build, the previous date is preserved. */
function urlsetFor(list) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!-- Generated by scripts/build-sitemap.js — do not edit by hand. -->\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    list.map(u =>
      '  <url>\n' +
      '    <loc>' + esc(u.loc) + '</loc>\n' +
      alternates(u.loc) + '\n' +
      '    <lastmod>' + u.lastmod + '</lastmod>\n' +
      '    <changefreq>' + u.changefreq + '</changefreq>\n' +
      '    <priority>' + u.priority + '</priority>\n' +
      '  </url>'
    ).join('\n') +
    '\n</urlset>\n';
}

const sections = [
  { file: 'sitemap-pages.xml', list: urls.filter(u => u.kind === 'home' || u.kind === 'category') },
  { file: 'sitemap-stores.xml', list: urls.filter(u => u.kind === 'store') },
  { file: 'sitemap-coupons.xml', list: urls.filter(u => u.kind === 'coupon') }
].filter(s => s.list.length);

function maxLastmod(list) {
  return list.reduce((a, u) => (u.lastmod > a ? u.lastmod : a), list[0].lastmod);
}

const indexXml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!-- Generated by scripts/build-sitemap.js — do not edit by hand. -->\n' +
  '<!-- index of ' + sections.length + ' sitemaps · ' + urls.length + ' URLs · ' + new Date().toISOString() + ' -->\n' +
  '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  sections.map(s =>
    '  <sitemap>\n' +
    '    <loc>' + esc(SITE + '/' + s.file) + '</loc>\n' +
    '    <lastmod>' + maxLastmod(s.list) + '</lastmod>\n' +
    '  </sitemap>'
  ).join('\n') +
  '\n</sitemapindex>\n';

if (!DRY_RUN) {
  sections.forEach(s => fs.writeFileSync(path.join(ROOT, s.file), urlsetFor(s.list)));
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), indexXml);
  /* Flat copy of every URL. Not referenced by the index — kept so anything
     still pointing at a single full urlset (old Search Console submissions,
     third-party crawlers) does not 404. */
  fs.writeFileSync(path.join(ROOT, 'sitemap-all.xml'), xml);
  saveState();
}

const summary = {
  written: !DRY_RUN,
  total: urls.length,
  home: 1,
  categories: categories.filter(c => (perCat[c.id] || 0) > 0).length,
  storesListed: stores.filter(s => (perStore[s.id] || 0) > 0).length,
  storesExcludedEmpty: stores.filter(s => (perStore[s.id] || 0) === 0).length,
  couponsListed: fresh.length,
  couponsExcludedExpired: live.length - fresh.length,
  locales: LOCALES,
  hreflangEntries: urls.length * (LOCALES.length + 1),
  file: 'sitemap.xml'
};

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('');
  console.log('Sitemap — ' + (DRY_RUN ? 'dry run' : 'written to sitemap.xml'));
  console.log('─'.repeat(52));
  console.log('  home                : ' + summary.home);
  console.log('  categories          : ' + summary.categories + ' of ' + categories.length);
  console.log('  stores (with deals) : ' + summary.storesListed);
  console.log('  stores (empty, skip): ' + summary.storesExcludedEmpty);
  console.log('  coupons             : ' + summary.couponsListed);
  console.log('  coupons (expired)   : ' + summary.couponsExcludedExpired);
  console.log('  ── total URLs       : ' + summary.total);
  console.log('  locales             : ' + LOCALES.join(', '));
  console.log('  hreflang entries    : ' + summary.hreflangEntries);
  console.log('');
}
