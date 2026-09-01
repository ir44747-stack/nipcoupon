#!/usr/bin/env node
/**
 * Pre-deploy verification.
 *
 *   node scripts/predeploy.js
 *
 * 1. Affiliate integrity — rebuilds every outbound URL exactly like the app
 *    does and asserts the CPS/CPC parameters survive (utm_source, utm_medium,
 *    utm_campaign, utm_content + each store's own network tag).
 * 2. Build integrity   — required files, no CDN, no secrets, no build step,
 *    serverless function count and payload size against Vercel's free tier.
 *
 * Exits 1 if anything blocks a zero-cost deploy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const AS_JSON = process.argv.includes('--json');
const lines = [];
const say = l => { lines.push(l); if (!AS_JSON) console.log(l); };

const problems = [];
const notes = [];
const fail = m => problems.push(m);
const note = m => notes.push(m);

const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

/* ═════════════ 1. affiliate integrity ═════════════ */
say('Affiliate integrity');
say('─────────────────────────────────────────────');

const config = read('data/config.json');
const stores = read('data/stores.json').stores;
const coupons = read('data/coupons.json').coupons;
const attribution = config.attribution || {};

const storeById = {};
stores.forEach(s => { storeById[s.id] = s; });

/* Mirrors buildStoreUrl() in index.html — deliberately duplicated so a
   regression in the app cannot silently rewrite the tracking parameters. */
function buildStoreUrl(c) {
  const store = storeById[c.storeId] || {};
  const base = c.landingUrl || store.url || '';
  if (!base) return '';
  try {
    const u = new URL(base);
    Object.keys(attribution).forEach(k => u.searchParams.set(k, attribution[k]));
    u.searchParams.set('utm_campaign', String(c.code || 'deal').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    u.searchParams.set('utm_content', String(c.id));
    const tag = String(store.affiliateTag || '').trim();
    if (tag) {
      tag.split('&').filter(Boolean).forEach(pair => {
        const bits = pair.split('=');
        const k = (bits[0] || '').trim();
        if (k) u.searchParams.set(decodeURIComponent(k), decodeURIComponent((bits[1] || '').trim()));
      });
    }
    return u.toString();
  } catch (e) { return ''; }
}

const required = Object.keys(attribution);
if (!required.length) fail('data/config.json has no attribution parameters — outbound links would carry no tracking');

/* A network tag must ADD its own params; silently overwriting our attribution
   would break reporting without anyone noticing. */
Object.keys(storeById).forEach(id => {
  const tag = String(storeById[id].affiliateTag || '').trim();
  if (!tag) return;
  tag.split('&').filter(Boolean).forEach(pair => {
    const k = decodeURIComponent((pair.split('=')[0] || '').trim());
    if (required.indexOf(k) !== -1) {
      fail('store "' + id + '" affiliateTag overrides attribution key "' + k + '" — rename it (e.g. aff_' + k + ')');
    }
  });
});

let checked = 0, tagged = 0, missing = 0;
const brokenSamples = [];

coupons.forEach(c => {
  const url = buildStoreUrl(c);
  if (!url) { missing++; fail('coupon ' + c.id + ' has no outbound URL (store ' + c.storeId + ' has no url and no landingUrl)'); return; }
  checked++;
  const u = new URL(url);
  required.forEach(k => {
    if (u.searchParams.get(k) !== attribution[k]) {
      missing++;
      fail('coupon ' + c.id + ' is missing ' + k + '=' + attribution[k]);
    }
  });
  if (u.searchParams.get('utm_content') !== String(c.id)) { missing++; fail('coupon ' + c.id + ' utm_content mismatch'); }
  const expectCampaign = String(c.code || 'deal').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (u.searchParams.get('utm_campaign') !== expectCampaign) { missing++; fail('coupon ' + c.id + ' utm_campaign mismatch'); }

  const store = storeById[c.storeId] || {};
  const tag = String(store.affiliateTag || '').trim();
  if (tag) {
    tagged++;
    tag.split('&').filter(Boolean).forEach(pair => {
      const [k, v] = pair.split('=');
      if (u.searchParams.get(decodeURIComponent(k)) !== decodeURIComponent((v || '').trim())) {
        missing++;
        fail('coupon ' + c.id + ' lost the network tag ' + k);
      }
    });
  }
  if (!/^https:\/\//.test(url)) { fail('coupon ' + c.id + ' outbound URL is not https'); }
  if (brokenSamples.length < 3) brokenSamples.push(url);
});

const storesWithTags = stores.filter(s => String(s.affiliateTag || '').trim()).length;

say('attribution  : ' + JSON.stringify(attribution));
say('links built  : ' + checked + ' / ' + coupons.length + ' coupons');
say('utm params   : ' + (missing === 0 ? 'intact on every link' : missing + ' PROBLEM(S)'));
say('network tags : ' + storesWithTags + '/' + stores.length + ' stores carry a CPS/CPC tag · ' + tagged + ' links enriched');
say('sample       : ' + (brokenSamples[0] || '—'));
if (storesWithTags === 0) {
  note('No store has an affiliateTag yet — paste your network IDs (Awin/Rakuten/Impact/CJ) into data/stores.json to earn.');
} else if (storesWithTags < stores.length) {
  note((stores.length - storesWithTags) + ' stores rely on UTM-only attribution (no network tag).');
}

/* ═════════════ 2. build integrity ═════════════ */
say('');
say('Build integrity');
say('─────────────────────────────────────────────');

const requiredFiles = [
  'index.html', 'vercel.json', 'robots.txt', 'sitemap.xml', 'og.png',
  'data/stores.json', 'data/categories.json', 'data/coupons.json', 'data/regions.json', 'data/config.json',
  'locales/en.json', 'locales/ar.json',
  'api/catalog.js', 'api/deals.js', 'api/stores.js', 'api/categories.js',
  'api/regions.js', 'api/geo.js', 'api/i18n.js', 'api/_data.js', 'api/_http.js', 'api/deals/[id].js'
];
const missingFiles = requiredFiles.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (missingFiles.length) missingFiles.forEach(f => fail('missing required file: ' + f));
say('files        : ' + requiredFiles.length + ' required · ' + (missingFiles.length ? missingFiles.length + ' MISSING' : 'all present'));

// no third-party requests (the no-CDN rule)
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const external = [...new Set((html.match(/https?:\/\/[^"'\s)]+/g) || [])
  .map(u => u.replace(/^https?:\/\//, '').split('/')[0]))]
  .filter(h => h !== 'nipcoupon.vercel.app' && h !== 'www.w3.org');
if (external.length) fail('index.html references external host(s): ' + external.join(', '));
say('no CDN       : ' + (external.length ? external.join(', ') : 'no third-party hosts referenced'));

// no build step
let vercel = {};
try { vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')); }
catch (e) { fail('vercel.json is not valid JSON'); }
if (vercel.buildCommand) fail('vercel.json defines a buildCommand — the project must stay build-free');
if (vercel.framework && vercel.framework !== null) note('vercel.json pins framework "' + vercel.framework + '" (Other is fine).');
say('build step   : ' + (vercel.buildCommand ? 'DEFINED (should be none)' : 'none — static + serverless functions only'));

// serverless functions (Vercel Hobby allows 12 per deployment)
const apiFiles = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach(name => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) return walk(full);
    if (name.startsWith('_')) return;                 // helpers are not routes
    if (name.endsWith('.js')) apiFiles.push(path.relative(ROOT, full));
  });
})(path.join(ROOT, 'api'));
const HOBBY_FUNCTION_LIMIT = 12;
if (apiFiles.length > HOBBY_FUNCTION_LIMIT) fail(apiFiles.length + ' serverless functions exceeds the Hobby limit of ' + HOBBY_FUNCTION_LIMIT);
say('functions    : ' + apiFiles.length + '/' + HOBBY_FUNCTION_LIMIT + ' (Hobby) — ' + apiFiles.sort().map(f => f.replace('api/', '').replace('.js', '')).join(', '));

// payload size
const sizeOf = f => { try { return fs.statSync(path.join(ROOT, f)).size; } catch (e) { return 0; } };
const counted = [...requiredFiles, ...apiFiles];
const bytes = counted.reduce((t, f) => t + sizeOf(f), 0);
say('payload      : ' + counted.length + ' files · ' + (bytes / 1024).toFixed(0) + ' KB (' + (bytes / 1048576).toFixed(2) + ' MB)');
const bigFiles = counted.filter(f => sizeOf(f) > 4 * 1024 * 1024);
if (bigFiles.length) bigFiles.forEach(f => fail('file over 4 MB: ' + f));

// secrets must never be packaged
const secretFiles = fs.readdirSync(ROOT)
  .filter(f => /^\.env/.test(f) && f !== '.env.example');      // .env, .env.local, .env.production…

// A .env is fine locally — as long as the ignore files keep it out of the upload.
// It is a hard failure only when nothing protects it (e.g. inside the deploy package).
const ignoreText = ['.gitignore', '.vercelignore']
  .filter(f => fs.existsSync(path.join(ROOT, f)))
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const envIsIgnored = /^\.env(?=\s|$|\.)/m.test(ignoreText) || /^\.env\.\*$/m.test(ignoreText);

secretFiles.forEach(f => {
  if (envIsIgnored) note('secret file ' + f + ' present locally — kept out of the upload by .gitignore/.vercelignore');
  else fail('secret file present: ' + f + ' — nothing ignores it, it would be deployed');
});

// look for real credentials, not prose that merely mentions ".env"
const SECRET_PATTERNS = [
  [/BEGIN (RSA|OPENSSH|EC|DSA|PRIVATE) ?(PRIVATE )?KEY/, 'a private key'],
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/ghp_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_\-]{24,})/gi, 'what looks like a hard-coded credential']
];
// help text and fixtures legitimately show fake values — only real ones are a problem
const PLACEHOLDER = /^(your|placeholder|example|sample|changeme|x{3,}|y{3,}|\*+|todo|tbd|redacted|dummy|test|fake|mock|insert|replace|change|some|my)/i;
const SCAN_EXT = new Set(['.js', '.json', '.html', '.md', '.yml', '.yaml', '.sh', '.txt', '.xml', '.example', '']);
let scannedFiles = 0;
(function scanDir(dir) {
  fs.readdirSync(dir).forEach(name => {
    if (name === 'node_modules' || name === '.git' || name === 'backups') return;
    if (envIsIgnored && /^\.env/.test(name)) return;   // that is where secrets belong
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) return scanDir(full);
    if (st.size > 2 * 1024 * 1024) return;                        // skip binaries (og.png…)
    if (!SCAN_EXT.has(path.extname(name).toLowerCase())) return;
    let body = '';
    scannedFiles++;
    try { body = fs.readFileSync(full, 'utf8'); } catch (e) { return; }
    SECRET_PATTERNS.forEach(([re, what]) => {
      if (!re.global) {                                   // simple pattern: presence is enough
        if (re.test(body)) fail(path.relative(ROOT, full) + ' contains ' + what);
        return;
      }
      let m; re.lastIndex = 0;
      while ((m = re.exec(body))) {
        if (PLACEHOLDER.test(m[1] || '')) continue;        // "your-personal-access-token" etc.
        fail(path.relative(ROOT, full) + ' contains ' + what + ' ("' + String(m[1]).slice(0, 8) + '…")');
        break;
      }
    });
  });
})(ROOT);
say('secrets      : ' + (problems.some(p => /secret|private key|credential|AWS|Slack|GitHub/i.test(p))
  ? 'FOUND — remove before deploying' : 'none detected (' + scannedFiles + ' files scanned)'));

// Sovrn's site API key ships inside its wrapper URLs and in its own JS tag, so it
// is a public identifier — but say it out loud rather than pretend it isn't there.
try {
  const stores = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stores.json'), 'utf8')).stores;
  const sovrn = stores.filter(s => /sovrn\.co|viglink\.com/i.test(String(s.url || '')));
  if (sovrn.length) {
    note(sovrn.length + '/' + stores.length + ' store links are Sovrn wrapper URLs carrying the public site API key ' +
      '(expected — it is exposed in Sovrn\'s own JS tag). The Secret Key must never appear here.');
  }
} catch (e) { /* no stores.json — nothing to report */ }

// runtime env is optional
say('env vars     : none required · DEALS_FEED_URL / FEED_TOKEN optional (feed), FEED_TIMEOUT_MS, FEED_MAX_ITEMS');

/* ═════════════ 3. verdict ═════════════ */
say('');
say('─────────────────────────────────────────────');
notes.forEach(n => say('  · ' + n));
if (problems.length) {
  problems.slice(0, 20).forEach(p => say('  x ' + p));
  say('');
  say('NOT READY — ' + problems.length + ' problem(s)');
  if (AS_JSON) console.log(JSON.stringify({ ok: false, problems, notes, urls: brokenSamples }, null, 2));
  process.exit(1);
}
say('READY FOR DEPLOY — zero-cost Vercel Hobby compatible');
say('  vercel.com/new → drag the folder → Project name "nipcoupon" → Framework: Other → Deploy');
if (AS_JSON) console.log(JSON.stringify({ ok: true, notes, checked, tagged, storesWithTags, functions: apiFiles.length, bytes }, null, 2));
