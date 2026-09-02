#!/usr/bin/env node
/**
 * Validate the deal data files before you ship them.
 *
 *   node scripts/validate.js
 *
 * Catches: broken JSON, duplicate ids, coupons pointing at a store/category
 * that does not exist, missing codes on "code" coupons, bad dates, ratings
 * out of range, unknown category icons, stores without a link, region codes,
 * translation drift between locales/*.json and the UI, expired deals and
 * unreachable affiliate links.
 *
 *   node scripts/validate.js                 report only (default)
 *   node scripts/validate.js --prune         delete expired deals (backs up first)
 *   node scripts/validate.js --links         verify every affiliate URL over HTTP
 *   node scripts/validate.js --prune --links also delete deals with broken links
 *   node scripts/validate.js --strict        warnings fail the run
 *   node scripts/validate.js --json          machine-readable output for CI
 *
 * Exits with code 1 if there are errors — wire it into CI or a pre-commit hook.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ARGS    = new Set(process.argv.slice(2));
const PRUNE   = ARGS.has('--prune');    // rewrite coupons.json without expired/broken rows
const LINKS   = ARGS.has('--links');    // verify affiliate links over the network
const STRICT  = ARGS.has('--strict');   // warnings become errors
const AS_JSON = ARGS.has('--json');
const LINK_TIMEOUT = Number(process.env.LINK_TIMEOUT_MS) || 8000;
const LINK_CONCURRENCY = 6;

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const errors = [];
const warnings = [];
const pruneLog = [];
let pruneNote = '';

const err = (file, msg) => errors.push(file + ': ' + msg);
const warn = (file, msg) => warnings.push(file + ': ' + msg);

function read(file) {
  const full = path.join(DATA, file);
  if (!fs.existsSync(full)) { err(file, 'file is missing'); return null; }
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch (e) { err(file, 'invalid JSON — ' + e.message); return null; }
}

const isHex = v => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v || ''));   // #fff and #ffffff both fine
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v).getTime());

/* ---------- regions ---------- */
const regionsFile = read('regions.json');
const regions = (regionsFile && regionsFile.regions) || [];
const regionCodes = new Set();
const defaultRegions = regions.filter(r => r.default);
if (!regions.length) err('regions.json', 'at least one region is required');
if (defaultRegions.length !== 1) err('regions.json', 'exactly one region must be flagged default:true');
regions.forEach((r, i) => {
  const at = 'regions.json[' + i + '] ' + (r.code || '?');
  if (!r.code) err(at, 'code is required');
  else if (!/^[A-Z]{2,}$/.test(r.code)) err(at, 'code should be upper-case, e.g. "QA" or "GLOBAL"');
  else if (regionCodes.has(r.code)) err(at, 'duplicate region code "' + r.code + '"');
  else regionCodes.add(r.code);
  if (!r.name) err(at, 'name is required');
});
if (regionCodes.size && !regionCodes.has('GLOBAL')) warn('regions.json', 'no "GLOBAL" region — worldwide deals would never match');

/* ---------- locales (i18n) ---------- */
const LOCALES_DIR = path.join(ROOT, 'locales');
function readLocale(code) {
  const file = path.join(LOCALES_DIR, code + '.json');
  if (!fs.existsSync(file)) { err('locales/' + code + '.json', 'missing — Task 2 needs ar.json and en.json'); return null; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { err('locales/' + code + '.json', 'invalid JSON — ' + e.message); return null; }
}
const localeFiles = fs.existsSync(LOCALES_DIR)
  ? fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
  : [];
const localeBundles = {};
localeFiles.forEach(c => { const b = readLocale(c); if (b) localeBundles[c] = b; });

if (!localeBundles.en) err('locales/en.json', 'the English bundle is the fallback for every missing key');
else {
  const base = Object.keys(localeBundles.en).sort();
  Object.keys(localeBundles).forEach(code => {
    if (code === 'en') return;
    const keys = Object.keys(localeBundles[code]).sort();
    const missing = base.filter(k => keys.indexOf(k) === -1);
    const extra = keys.filter(k => base.indexOf(k) === -1);
    if (missing.length) err('locales/' + code + '.json', missing.length + ' keys missing: ' + missing.slice(0, 6).join(', ') + (missing.length > 6 ? '…' : ''));
    if (extra.length) warn('locales/' + code + '.json', extra.length + ' keys not in en.json: ' + extra.slice(0, 6).join(', '));
    const unchanged = base.filter(k => localeBundles[code][k] === localeBundles.en[k]
      && /[A-Za-z]{4}/.test(String(localeBundles.en[k]))
      && !/^\{|@|https?:|\u00ac|Ctrl/.test(String(localeBundles.en[k]))
      && !k.startsWith('lang.'));   // native language names stay in their own language
    if (unchanged.length) warn('locales/' + code + '.json', unchanged.length + ' keys still in English: ' + unchanged.slice(0, 6).join(', '));
  });

  // every key the UI asks for must exist in the English bundle
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const used = new Set();
  const attr = /data-i18n(?:-html|-ph|-aria|-title)?="([^"]+)"/g;
  let m;
  while ((m = attr.exec(html))) used.add(m[1]);
  const call = /\bt\(\s*'([a-z]+\.[A-Za-z0-9_]+)'(?=\s*[,)])/g;   // skip t('ticker.msg' + i)
  while ((m = call.exec(html))) used.add(m[1]);
  for (let i = 1; i <= 6; i++) used.add('ticker.msg' + i);            // built dynamically
  const unknown = [...used].filter(k => localeBundles.en[k] === undefined);
  if (unknown.length) err('locales/en.json', unknown.length + ' keys used by index.html are missing: ' + unknown.slice(0, 8).join(', '));
  if (!AS_JSON) console.log('i18n keys    : ' + base.length + ' in en.json · ' + used.size + ' referenced by the UI');
}

/* ---------- config ---------- */
const config = read('config.json');
if (config) {
  if (!config.attribution || typeof config.attribution !== 'object') err('config.json', 'attribution object is required');
  else if (!Object.keys(config.attribution).length) warn('config.json', 'attribution is empty — outbound links will carry no tracking');
  if (config.pageSize !== undefined && !(Number(config.pageSize) > 0)) err('config.json', 'pageSize must be a positive number');
}

/* ---------- stores ---------- */
const storesFile = read('stores.json');
const storeIds = new Set();
const storeNames = new Set();
const stores = (storesFile && storesFile.stores) || [];
stores.forEach((s, i) => {
  const at = 'stores.json[' + i + '] ' + (s.name || s.id || '?');
  if (!s.id) err(at, 'id is required'); else if (storeIds.has(s.id)) err(at, 'duplicate store id "' + s.id + '"'); else storeIds.add(s.id);
  if (!s.name) err(at, 'name is required'); else if (storeNames.has(s.name)) err(at, 'duplicate store name "' + s.name + '"'); else storeNames.add(s.name);
  if (!s.abbr && !s.glyph) err(at, 'abbr is required (1-4 chars for the logo tile) unless a glyph is provided');
  if (!isHex(s.color)) err(at, 'color must be a 6-digit hex, got "' + s.color + '"');
  if (!isHex(s.fg)) err(at, 'fg (text colour) must be a hex colour, got "' + s.fg + '"');
  if (!s.url) warn(at, 'no url — the Get Code button will have nowhere to go');
  else if (!/^https?:\/\//.test(s.url)) err(at, 'url must start with http(s)://');
  if (!Array.isArray(s.regions) || !s.regions.length) err(at, 'regions array is required, e.g. ["GLOBAL"] or ["QA","AE"]');
  else s.regions.forEach(code => { if (!regionCodes.has(code)) err(at, 'unknown region "' + code + '" (see data/regions.json)'); });
});

/* ---------- categories ---------- */
const catsFile = read('categories.json');
const catIds = new Set();
const cats = (catsFile && catsFile.categories) || [];
cats.forEach((c, i) => {
  const at = 'categories.json[' + i + '] ' + (c.name || c.id || '?');
  if (!c.id) err(at, 'id is required'); else if (catIds.has(c.id)) err(at, 'duplicate category id "' + c.id + '"'); else catIds.add(c.id);
  if (!c.name) err(at, 'name is required');
  if (!c.icon) err(at, 'icon is required');
});
// cross-check icon keys against those defined in the front-end
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const iconsBlock = (html.match(/const ICONS = \{([\s\S]*?)\n  \};/) || [])[1] || '';
const iconKeys = new Set([...iconsBlock.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map(m => m[1]));
cats.forEach(c => { if (c.icon && iconKeys.size && !iconKeys.has(c.icon)) warn('categories.json', '"' + c.id + '" uses unknown icon "' + c.icon + '" (known: ' + [...iconKeys].join(', ') + ')'); });

/* ---------- Arabic data fields (i18n) ---------- */
if (localeBundles.ar) {
  cats.forEach(c => {
    if (!c.name_ar) warn('categories.json ' + c.id, 'no name_ar — the category chip stays English in Arabic');
    if (!c.blurb_ar) warn('categories.json ' + c.id, 'no blurb_ar — the description stays English in Arabic');
  });
  regions.forEach(r => {
    if (!r.name_ar) warn('regions.json ' + r.code, 'no name_ar — the region stays English in Arabic');
  });
}

/* ---------- coupons ---------- */
const couponsFile = read('coupons.json');
const couponIds = new Set();
const coupons = (couponsFile && couponsFile.coupons) || [];
const perStore = {};
const perCat = {};
coupons.forEach((c, i) => {
  const at = 'coupons.json[' + i + '] ' + (c.id || c.title || '?');
  if (!c.id) err(at, 'id is required'); else if (couponIds.has(c.id)) err(at, 'duplicate coupon id "' + c.id + '"'); else couponIds.add(c.id);
  if (!c.storeId) err(at, 'storeId is required');
  else if (!storeIds.has(c.storeId)) err(at, 'storeId "' + c.storeId + '" does not match any store in stores.json');
  if (!c.categoryId) err(at, 'categoryId is required');
  else if (!catIds.has(c.categoryId)) err(at, 'categoryId "' + c.categoryId + '" does not match any category in categories.json');
  if (c.type !== 'code' && c.type !== 'deal') err(at, 'type must be "code" or "deal", got "' + c.type + '"');
  if (c.type === 'code' && !String(c.code || '').trim()) err(at, 'type "code" requires a code field');
  if (c.type === 'deal' && c.code) warn(at, 'type "deal" should not carry a code (it will be ignored)');
  if (!c.badge) err(at, 'badge is required, e.g. "30% OFF"');
  if (c.value === undefined || isNaN(Number(c.value))) err(at, 'value is required (number used for sorting by discount)');
  if (!c.title) err(at, 'title is required');
  if (!isDate(c.expires)) err(at, 'expires must be YYYY-MM-DD, got "' + c.expires + '"');
  else if (new Date(c.expires) < new Date(Date.now() - 86400000)) warn(at, 'expired on ' + c.expires);
  if (c.rating !== undefined && (Number(c.rating) < 0 || Number(c.rating) > 5)) err(at, 'rating must be between 0 and 5');
  if (c.uses !== undefined && Number(c.uses) < 0) err(at, 'uses cannot be negative');
  if (c.terms !== undefined && (!Array.isArray(c.terms) || c.terms.some(t => typeof t !== 'string'))) err(at, 'terms must be an array of strings');
  if (!Array.isArray(c.regions) || !c.regions.length) err(at, 'regions array is required, e.g. ["GLOBAL"] or ["QA","AE"]');
  else {
    c.regions.forEach(code => { if (!regionCodes.has(code)) err(at, 'unknown region "' + code + '" (see data/regions.json)'); });
    const store = stores.filter(x => x.id === c.storeId)[0];
    if (!String(c.landingUrl || '').trim() && !(store && String(store.url || '').trim())) {
      err(at, 'no outbound link — the coupon needs a landingUrl or its store needs a url');
    } else if (c.landingUrl && !/^https?:\/\//i.test(c.landingUrl)) {
      err(at, 'landingUrl must start with http(s)://');
    }
    if (store && Array.isArray(store.regions)) {
      const stray = c.regions.filter(code => store.regions.indexOf(code) === -1);
      if (stray.length) warn(at, 'regions ' + stray.join('/') + ' are not listed on store "' + c.storeId + '" (' + store.regions.join('/') + ')');
    }
  }
  perStore[c.storeId] = (perStore[c.storeId] || 0) + 1;
  perCat[c.categoryId] = (perCat[c.categoryId] || 0) + 1;
});

/* ---------- expiry + affiliate link health ---------- */
const today = new Date(); today.setHours(0, 0, 0, 0);
const yesterday = new Date(today.getTime() - 86400000);
const expiryMs = c => { const d = new Date(String(c.expires || '') + 'T23:59:59'); return Number.isNaN(d.getTime()) ? null : d.getTime(); };
const expiredCoupons = coupons.filter(c => { const ms = expiryMs(c); return ms !== null && ms < yesterday.getTime(); });
const expiringSoon = coupons.filter(c => {
  const ms = expiryMs(c);
  return ms !== null && ms >= yesterday.getTime() && ms < today.getTime() + 7 * 86400000;
});

/* Outbound URL builder — mirrors index.html buildStoreUrl() exactly. */
const attribution = (config && config.attribution) ||
  { utm_source: 'nipcoupon', utm_medium: 'affiliate' };
const storeById = {};
stores.forEach(s => { storeById[s.id] = s; });
function outboundUrl(c) {
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
const urlCoupons = new Map();
coupons.forEach(c => { const u = outboundUrl(c); if (u) urlCoupons.set(u, (urlCoupons.get(u) || []).concat(c.id)); });

/* ---------- affiliate monetisation compliance ----------
   Every outbound link must route through the Sovrn wrapper carrying BOTH the
   publisher key and the cuid. A link that silently loses either one still
   works for the visitor, which is exactly why it goes unnoticed — it just
   stops earning. Structural checks only: the key is a ${SOVRN_API_KEY}
   placeholder in the repo by design, so we assert the placeholder is present
   and correctly shaped, never the literal secret. */
const SOVRN_HOSTS = new Set(['sovrn.co', 'www.sovrn.co']);
let unmonetised = 0;

stores.forEach(s => {
  const raw = String(s.url || '');
  if (!raw) { err('stores.json', s.id + ': no url — store can never be monetised'); unmonetised++; return; }
  let u;
  try { u = new URL(raw); } catch (e) { err('stores.json', s.id + ': unparseable url'); unmonetised++; return; }
  if (!SOVRN_HOSTS.has(u.hostname.toLowerCase())) {
    err('stores.json', s.id + ': outbound url bypasses the Sovrn wrapper (host ' + u.hostname + ') — clicks are uncommissioned');
    unmonetised++; return;
  }
  const key = u.searchParams.get('key') || '';
  const inner = u.searchParams.get('u') || '';
  const cuid = u.searchParams.get('cuid') || '';
  if (key !== '${SOVRN_API_KEY}') {
    // A hard-coded key here would also be a secret leak, not just a rotation problem.
    err('stores.json', s.id + ': key must be the ${SOVRN_API_KEY} placeholder, found ' +
      (key ? (/^\$\{/.test(key) ? key : 'a literal value') : '(empty)'));
    unmonetised++;
  }
  if (!inner) { err('stores.json', s.id + ': wrapper has no ?u= destination'); unmonetised++; }
  else if (!/^https?%3A|^https?:/i.test(inner)) {
    err('stores.json', s.id + ': ?u= must be an absolute, url-encoded destination');
  }
  if (!cuid) warn('stores.json', s.id + ': no cuid — sub-ID reporting will be blank for this store');
  if (!s.originalUrl) warn('stores.json', s.id + ': no originalUrl fallback if the key is unset');
});

/* Coupon landingUrl overrides store.url in page.js, so a raw merchant link
   written here by sync-offers.js / fetch-cj.js silently bypasses the wrapper.
   api/_data.js now monetises these at request time; flag them anyway so the
   data on disk stays honest about what it is. Links belonging to another
   affiliate network are legitimate and deliberately left unwrapped. */
const FOREIGN_AFFILIATE = /(^|\.)(dpbolvw\.net|anrdoezrs\.net|kqzyfj\.com|jdoqocy\.com|tkqlhce\.com|emjcd\.com|linksynergy\.com|awin1\.com|zenaps\.com|impact\.com|7eer\.net|evyy\.net|partnerize\.com|prf\.hn|shareasale\.com|rakuten\.com|cj\.com|amazon-adsystem\.com)$/i;
let rawLanding = 0, foreignLanding = 0;
coupons.forEach(c => {
  const raw = String(c.landingUrl || '');
  if (!raw || raw.indexOf('${') !== -1) return;
  let host;
  try { host = new URL(raw).hostname.toLowerCase(); }
  catch (e) { err('coupons.json', c.id + ': unparseable landingUrl'); return; }
  if (SOVRN_HOSTS.has(host)) return;
  if (FOREIGN_AFFILIATE.test(host)) { foreignLanding++; return; }
  rawLanding++;
  warn('coupons.json', c.id + ': landingUrl is a bare merchant URL (' + host +
    ') — monetised at request time, but store it wrapped to be safe');
});

/* A non-2xx is NOT proof of a dead link: most retailers block bots (403/503 on
   HEAD, 200 on GET). Only a confirmed 404/410 or a dead hostname counts as
   "dead", and even then it is re-checked before anything is deleted. */
const BOT_WALL = new Set([401, 403, 405, 429, 451]);
const DEAD_STATUS = new Set([404, 410]);
const DEAD_DNS = /ENOTFOUND|EAI_AGAIN|NXDOMAIN|ERR_NAME_NOT_RESOLVED/;

/* Deliberately NOT a Chrome UA: several retail CDNs (Adobe, Namshi, Noon,
   Asos, Qatar Airways) stall Chrome-shaped requests from datacenter IPs and
   would read as timeouts. An honest bot UA + an HTML accept header gets a
   straight answer from every network we have tested. */
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; NipCouponLinkCheck/1.0; +https://nipcoupon.vercel.app)',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9'
};

/* Node's fetch caps response headers at 16 KB; a few retailers blow past that
   and throw before we ever see a status. Fall back to the core http client,
   which lets us raise the cap. */
function rawProbe(url, depth) {
  depth = depth || 0;
  if (depth > 5) return Promise.resolve({ error: 'too many redirects' });
  return new Promise(resolve => {
    const lib = url.startsWith('https:') ? require('https') : require('http');
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = lib.request(url, { method: 'GET', maxHeaderSize: 262144, headers: HEADERS, timeout: LINK_TIMEOUT }, res => {
        const code = res.statusCode || 0;
        const loc = res.headers && res.headers.location;
        res.resume();                                   // drain and discard the body
        if (code >= 300 && code < 400 && loc) {
          let next;
          try { next = new URL(loc, url).toString(); } catch (e) { return finish({ status: code }); }
          return rawProbe(next, depth + 1).then(finish);
        }
        finish({ status: code });
      });
    } catch (e) { return finish({ error: (e && e.code) || (e && e.message) || 'request failed' }); }
    req.on('timeout', () => { req.destroy(); finish({ error: 'timeout' }); });
    req.on('error', e => finish({ error: (e && e.code) || (e && e.message) || 'network' }));
    req.end();
  });
}

async function probe(url) {
  const attempt = async method => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT);
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: controller.signal, headers: HEADERS });
      return { status: res.status };
    } catch (e) {
      if (e && e.name === 'AbortError') return { error: 'timeout' };
      const code = (e && e.cause && e.cause.code) || '';
      return { error: (code || (e && e.message) || 'network').toString() };
    } finally { clearTimeout(timer); }
  };

  const head = await attempt('HEAD');
  let final = head;
  // HEAD is unreliable — confirm anything that is not a clean 2xx/3xx with GET
  if (head.error || head.status >= 400) {
    const get = await attempt('GET');
    if (!get.error || head.error) final = get;
  }
  if (final.error && !/timeout/i.test(String(final.error))) {
    const raw = await rawProbe(url);
    if (!raw.error || DEAD_DNS.test(String(raw.error).toUpperCase())) final = raw;
  }
  return final;
}

async function checkUrl(url) {
  const final = await probe(url);

  if (final.error) {
    return DEAD_DNS.test(String(final.error).toUpperCase())
      ? { verdict: 'dead', detail: String(final.error) }
      : { verdict: 'unknown', detail: String(final.error) };
  }
  if (DEAD_STATUS.has(final.status)) {
    const again = await probe(url);                     // never delete revenue on one sample
    if (again.status === final.status) return { verdict: 'dead', detail: 'HTTP ' + final.status };
    if (again.error) return { verdict: 'unknown', detail: 'flaky — ' + again.error };
    return { verdict: 'ok', detail: 'flaky, retried → HTTP ' + again.status };
  }
  if (final.status >= 400 && !BOT_WALL.has(final.status)) {
    return { verdict: final.status >= 500 ? 'unknown' : 'suspect', detail: 'HTTP ' + final.status };
  }
  return { verdict: 'ok', detail: 'HTTP ' + final.status };
}

(async function main() {
let linkReport = { checked: 0, ok: 0, dead: 0, suspect: 0, unknown: 0, details: [] };
if (LINKS) {
  const urls = [...urlCoupons.keys()].concat(
    [...new Set(stores.map(s => s.url).filter(u => !!u))].filter(u => !urlCoupons.has(u))
  );
  const queue = urls.slice();
  const workers = new Array(Math.min(LINK_CONCURRENCY, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      const url = queue.shift();
      const r = await checkUrl(url);
      linkReport.checked++;
      linkReport[r.verdict]++;
      if (r.verdict !== 'ok') linkReport.details.push(url + ' → ' + r.verdict + ' (' + r.detail + ')');
      if (r.verdict === 'dead') (linkReport.deadUrls = linkReport.deadUrls || new Set()).add(url);
    }
  });
  await Promise.all(workers);
  linkReport.details.sort();
  linkReport.brokenUrls = new Set(linkReport.details.filter(d => d.indexOf('→ broken') !== -1).map(d => d.split(' → ')[0]));
}

/* ---------- prune ---------- */
const removedIds = new Set();
if (PRUNE) {
  expiredCoupons.forEach(c => {
    removedIds.add(c.id);
    pruneLog.push('expired ' + c.id + ' (' + c.storeId + ', expired ' + c.expires + ')');
  });
  if (LINKS) {
    coupons.forEach(c => {
      if (removedIds.has(c.id)) return;
      const u = outboundUrl(c);
      const store = storeById[c.storeId] || {};
      const deadUrls = linkReport.deadUrls || new Set();
      const linkDead = u && deadUrls.has(u);
      const storeDead = store.url && deadUrls.has(store.url);
      if (linkDead && (storeDead || !store.url)) {
        removedIds.add(c.id);
        pruneLog.push('broken link ' + c.id + ' (' + c.storeId + ') → ' + u);
      }
    });
  }
}

/* ---------- write ---------- */
if (PRUNE && removedIds.size) {
  const backupDir = path.join(ROOT, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(backupDir, 'coupons-' + stamp + '.json');
  fs.writeFileSync(backup, fs.readFileSync(path.join(DATA, 'coupons.json')));
  const kept = coupons.filter(c => !removedIds.has(c.id));
  fs.writeFileSync(path.join(DATA, 'coupons.json'), JSON.stringify({ coupons: kept }, null, 2) + '\n');
  pruneNote = 'removed ' + removedIds.size + ' of ' + coupons.length + ' deals · backup → ' + path.relative(ROOT, backup);
}

/* ---------- report ---------- */
const lines = [];
const say = l => { lines.push(l); if (!AS_JSON) console.log(l); };
say('NipCoupon data validation');
say('─────────────────────────────────────────────');
say('stores      : ' + stores.length);
say('categories  : ' + cats.length);
say('coupons     : ' + coupons.length);
const perRegion = {};
coupons.forEach(c => (c.regions || []).forEach(r => { perRegion[r] = (perRegion[r] || 0) + 1; }));
say('by region   : ' + Object.entries(perRegion).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join(', ') + '   (GLOBAL is shown in every region)');
say('by category : ' + Object.entries(perCat).map(([k, v]) => k + '=' + v).join(', '));
say('top stores  : ' + Object.entries(perStore).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + '=' + v).join(', '));
say('affiliate   : ' + urlCoupons.size + ' unique tracked links · attribution ' + JSON.stringify(attribution));
say('expiry      : ' + expiredCoupons.length + ' expired · ' + expiringSoon.length + ' expiring within 7 days');
say('monetisation: ' + (stores.length - unmonetised) + '/' + stores.length +
    ' stores route through the Sovrn wrapper with a key placeholder + cuid' +
    ' · coupon landingUrl: ' + rawLanding + ' bare, ' + foreignLanding + ' other-network');
if (LINKS) {
  say('links       : ' + linkReport.checked + ' checked · ' + linkReport.ok + ' ok · ' +
      linkReport.dead + ' dead · ' + linkReport.suspect + ' suspect · ' + linkReport.unknown + ' unverifiable');
  linkReport.details.slice(0, 12).forEach(d => say('              - ' + d));
} else {
  say('links       : skipped (run with --links to verify affiliate URLs)');
}
if (pruneNote) {
  say('pruned      : ' + pruneNote);
  pruneLog.slice(0, 20).forEach(l => say('              - ' + l));
} else if (PRUNE) {
  say('pruned      : nothing to remove');
}

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: errors.length === 0,
    stores: stores.length, categories: cats.length, coupons: coupons.length,
    byRegion: perRegion, byCategory: perCat,
    links: LINKS ? linkReport : null,
    expired: expiredCoupons.map(c => c.id),
    pruned: pruneNote ? pruneLog : [],
    warnings, errors
  }, null, 2));
}

if (warnings.length) {
  if (!AS_JSON) {
    console.log('\nwarnings (' + warnings.length + '):');
    warnings.slice(0, 25).forEach(w => console.log('  ! ' + w));
  }
}
if (STRICT && warnings.length && errors.length === 0) {
  errors.push('strict mode: ' + warnings.length + ' warning(s) treated as errors');
}
if (errors.length) {
  if (!AS_JSON) {
    console.log('\nerrors (' + errors.length + '):');
    errors.slice(0, 40).forEach(e => console.log('  x ' + e));
    console.log('\nFAILED');
  }
  process.exit(1);
}
if (!AS_JSON) console.log('\nOK — data is valid');
})();
