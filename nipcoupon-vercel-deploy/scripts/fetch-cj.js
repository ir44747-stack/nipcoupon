#!/usr/bin/env node
/**
 * fetch-cj.js — pull coupon/deal links from CJ Affiliate into NipCoupon.
 *
 *   node scripts/fetch-cj.js                # fetch + merge into data/coupons.json
 *   node scripts/fetch-cj.js --dry-run      # fetch and report, write nothing
 *   node scripts/fetch-cj.js --source=rest  # force the Link Search API
 *   node scripts/fetch-cj.js --replace      # replace instead of merging
 *   node scripts/fetch-cj.js --json         # machine-readable summary (cron/CI)
 *
 * Credentials come from the environment or a local .env — NEVER from git:
 *   CJ_ACCESS_TOKEN   Personal Access Token      (required)
 *   CJ_PUBLISHER_ID   Publisher CID              (default 8058000)
 *   CJ_PROPERTY_ID    Promotional property / PID (default 101873115)
 *
 * What it writes
 *   data/cj-links.json  clean array: id, store, title, description, code,
 *                       affiliateUrl, startDate, endDate   ← the raw CJ shape
 *   data/cj-feed.json   the same rows in NipCoupon's feed shape, so you can
 *                       point DEALS_FEED_URL at it and merge live, per request
 *   data/coupons.json   merged into the app's own schema (backup first)
 *
 * Exit codes: 0 ok · 1 configuration/network failure · 2 connected but no links
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BACKUPS = path.join(ROOT, 'backups');

/* ─────────────────────────── CLI + env ─────────────────────────── */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const argOf = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : dflt;
};
const AS_JSON = has('--json');
const VERBOSE = has('--verbose') || has('-v');
const DRY_RUN = has('--dry-run');
const REPLACE = has('--replace');
const NO_MERGE = has('--no-merge');
const REGISTER_STORES = !has('--no-register-stores');

/* Tiny .env reader — zero dependencies, and the file stays out of git. */
(function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m) return;
    const key = m[1];
    const val = m[2].replace(/^['"]|['"]$/g, '').trim();
    if (val && process.env[key] === undefined) process.env[key] = val;
  });
})();

const TOKEN = (process.env.CJ_ACCESS_TOKEN || '').trim();
const PUBLISHER_ID = (process.env.CJ_PUBLISHER_ID || '8058000').trim();
const PROPERTY_ID = (process.env.CJ_PROPERTY_ID || '101873115').trim();
const GRAPHQL_URL = (process.env.CJ_GRAPHQL_URL || 'https://ads.api.cj.com/query').trim();
const REST_URL = (process.env.CJ_LINK_SEARCH_URL || 'https://link-search.api.cj.com/v2/link-search').trim();
const SOURCE = (argOf('--source', process.env.CJ_SOURCE || 'auto')).toLowerCase();
const MAX_PAGES = Number(argOf('--max-pages', process.env.CJ_MAX_PAGES || 10)) || 10;
const PAGE_SIZE = Math.min(Number(argOf('--page-size', process.env.CJ_PAGE_SIZE || 100)) || 100, 100);
const TIMEOUT_MS = Number(argOf('--timeout', process.env.CJ_TIMEOUT_MS || 20000)) || 20000;
const DEFAULT_REGIONS = String(argOf('--regions', process.env.CJ_DEFAULT_REGIONS || 'GLOBAL'))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
/* CJ offers with no end date are open-ended, but the app's schema requires a
   date — so they get a rolling expiry, refreshed on every run. */
const DEFAULT_DAYS = Number(argOf('--default-days', process.env.CJ_DEFAULT_DAYS || 30)) || 30;
const plusDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const out = [];                       // buffered so --json prints nothing else
const say = l => { if (!AS_JSON) console.log(l); else out.push(String(l).replace(/\u001b\[\d+m/g, '')); };
const redact = s => String(s || '').replace(TOKEN, '***token***');

function die(code, msg) {
  if (AS_JSON) console.log(JSON.stringify({ ok: false, error: redact(msg), fetched: 0, merged: 0 }, null, 2));
  else console.error('\n' + msg);
  process.exit(code);
}

if (!TOKEN) die(1, 'CJ_ACCESS_TOKEN is not set.\n' +
  '  Put it in nipcoupon/.env as:  CJ_ACCESS_TOKEN=your-personal-access-token\n' +
  '  (.env is git-ignored and excluded from the Vercel upload.)');

say('NipCoupon · CJ Affiliate fetch');
say('──────────────────────────────────────────────');
say('publisher  : ' + PUBLISHER_ID + '   property : ' + PROPERTY_ID);
say('source     : ' + SOURCE + (DRY_RUN ? '   (dry run — nothing will be written)' : ''));

/* ─────────────────────────── HTTP helper ─────────────────────────── */
async function request(url, options, tries) {
  tries = tries || 3;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({ signal: controller.signal }, options));
      const body = await res.text();
      clearTimeout(timer);
      // retry only on transient conditions
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        const wait = 800 * Math.pow(2, attempt - 1);
        if (VERBOSE) say('  … ' + res.status + ', retrying in ' + wait + 'ms');
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return { status: res.status, ok: res.ok, body };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < tries) {
        const wait = 800 * Math.pow(2, attempt - 1);
        if (VERBOSE) say('  … ' + (e.name === 'AbortError' ? 'timeout' : e.message) + ', retrying in ' + wait + 'ms');
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr || new Error('request failed');
}

const authHeaders = () => ({
  'Authorization': 'Bearer ' + TOKEN,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'NipCoupon/1.0 (+https://nipcoupon.vercel.app)'
});

/* ─────────────── 1. GraphQL (ads.api.cj.com/query) ───────────────
   The requested path. CJ's ads endpoint currently exposes product/feed
   queries only, so each candidate is tried and errors are reported rather
   than swallowed — the moment CJ publishes a links query this just works. */
const GRAPHQL_CANDIDATES = [
  {
    name: 'links(propertyId)',
    query: `query ($propertyId: ID!, $limit: Int, $offset: Int) {
      links(propertyId: $propertyId, limit: $limit, offset: $offset) {
        totalCount
        resultList {
          id advertiserName name description couponCode clickUrl
          startDate endDate
        }
      }
    }`
  },
  {
    name: 'links(publisherId, propertyId)',
    query: `query ($publisherId: ID!, $propertyId: ID!, $limit: Int, $offset: Int) {
      links(publisherId: $publisherId, propertyId: $propertyId, limit: $limit, offset: $offset) {
        totalCount
        resultList {
          id advertiserName name description couponCode clickUrl
          startDate endDate
        }
      }
    }`
  },
  {
    name: 'links(companyId, propertyId)',
    query: `query ($companyId: ID!, $propertyId: ID!, $limit: Int, $offset: Int) {
      links(companyId: $companyId, propertyId: $propertyId, limit: $limit, offset: $offset) {
        count
        records {
          id advertiserName name description couponCode clickUrl
          startDate endDate
        }
      }
    }`
  }
];

async function fetchGraphQL() {
  const notes = [];
  for (const candidate of GRAPHQL_CANDIDATES) {
    let offset = 0;
    const rows = [];
    let shapeOk = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const variables = {
        propertyId: PROPERTY_ID, publisherId: PUBLISHER_ID, companyId: PUBLISHER_ID,
        limit: PAGE_SIZE, offset
      };
      let res;
      try {
        res = await request(GRAPHQL_URL, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ query: candidate.query, variables })
        });
      } catch (e) {
        notes.push(candidate.name + ': network/' + (e.name === 'AbortError' ? 'timeout' : e.message));
        break;
      }

      let payload;
      try { payload = JSON.parse(res.body); }
      catch (e) { notes.push(candidate.name + ': non-JSON response (HTTP ' + res.status + ') ' + res.body.slice(0, 120)); break; }

      if (payload.errors && payload.errors.length) {
        notes.push(candidate.name + ': ' + payload.errors.map(e => e.message).join('; ').slice(0, 200));
        break;                                  // this shape is not supported
      }
      const data = (payload.data && payload.data.links) || null;
      if (!data) { notes.push(candidate.name + ': query returned no "links" field'); break; }

      const list = data.resultList || data.records || data.links || [];
      if (!list.length) break;
      shapeOk = true;
      rows.push(...list);
      const total = data.totalCount || data.count || 0;
      offset += list.length;
      if (rows.length >= total || list.length < PAGE_SIZE) break;
    }

    if (shapeOk && rows.length) return { rows, notes, via: 'graphql:' + candidate.name };
  }
  return { rows: [], notes, via: null };
}

/* ─────────────── 2. REST Link Search (fallback) ───────────────
   The only CJ API that actually returns coupon codes and click URLs.
   Same Bearer token; website-id is the promotional property (PID). */
const xmlTag = (block, tag) => {
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(block);
  if (!m) return '';
  return m[1]
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
};

async function fetchRest() {
  const notes = [];
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = REST_URL +
      '?website-id=' + encodeURIComponent(PROPERTY_ID) +
      '&advertiser-ids=joined' +
      '&records-per-page=' + PAGE_SIZE +
      '&page-number=' + page;
    let res;
    try {
      res = await request(url, { method: 'GET', headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/xml',
        'User-Agent': 'NipCoupon/1.0 (+https://nipcoupon.vercel.app)'
      } });
    } catch (e) {
      notes.push('rest: network/' + (e.name === 'AbortError' ? 'timeout' : e.message));
      break;
    }
    const body = res.body || '';
    const err = xmlTag(body, 'error-message');
    if (err) { notes.push('rest: ' + err); break; }
    if (!res.ok) { notes.push('rest: HTTP ' + res.status); break; }

    const blocks = body.match(/<link>[\s\S]*?<\/link>/g) || [];
    if (!blocks.length) break;
    for (const b of blocks) {
      rows.push({
        id: xmlTag(b, 'link-id'),
        advertiserName: xmlTag(b, 'advertiser-name'),
        name: xmlTag(b, 'link-name'),
        description: xmlTag(b, 'description'),
        couponCode: xmlTag(b, 'coupon-code'),
        clickUrl: xmlTag(b, 'clickUrl'),
        startDate: xmlTag(b, 'promotion-start-date') || xmlTag(b, 'start-date'),
        endDate: xmlTag(b, 'promotion-end-date') || xmlTag(b, 'end-date')
      });
    }
    const total = Number(xmlTag(body, 'total-matched') || xmlTag(body, 'records-returned') || 0);
    if (rows.length >= total || blocks.length < PAGE_SIZE) break;
  }
  return { rows, notes, via: rows.length ? 'rest:link-search' : null };
}

(async function main() {
/* ─────────────────────────── run the fetch ─────────────────────────── */
let result = { rows: [], notes: [], via: null };
try {
  if (SOURCE === 'rest') {
    result = await fetchRest();
  } else {
    result = await fetchGraphQL();
    if (!result.rows.length && SOURCE === 'auto') {
      const rest = await fetchRest();
      result = { rows: rest.rows, notes: result.notes.concat(rest.notes), via: rest.via };
    }
  }
} catch (e) {
  die(1, 'CJ request failed: ' + redact(e.message));
}

const rows = result.rows.filter(r => r && (r.clickUrl || r.name));
const notes = result.notes;

say('endpoint   : ' + (result.via || 'no source returned data'));
if (notes.length) { say('diagnostics:'); notes.slice(0, 6).forEach(n => say('  · ' + redact(n))); }

if (!rows.length) {
  say('');
  say('0 links returned — nothing was written.');
  say('  CJ\'s ads GraphQL API has no "links" query today (products/feeds only), and');
  say('  the REST Link Search API that does carry coupon codes needs the legacy API');
  say('  key or REST to be enabled for this token. Both paths were attempted.');
  if (AS_JSON) console.log(JSON.stringify({ ok: false, reason: 'no-links', notes, fetched: 0, merged: 0 }, null, 2));
  process.exit(2);
}

/* ─────────────────────── the clean array you asked for ─────────────────────── */
/* Some CJ responses hand back HTML-escaped copy; decode the common entities
   so titles never render as "Nike &amp; friends". */
const decodeEntities = s => String(s == null ? '' : s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

const links = rows.map(r => ({
  id: String(r.id || '').trim(),
  store: decodeEntities((r.advertiserName || '').trim()),
  title: decodeEntities((r.name || r.title || '').trim()),
  description: decodeEntities((r.description || '').trim()),
  code: decodeEntities((r.couponCode || r.code || '').trim()),
  affiliateUrl: (r.clickUrl || r.url || '').trim(),
  startDate: (r.startDate || '').trim(),
  endDate: (r.endDate || '').trim()
})).filter(l => l.affiliateUrl && l.title);

say('fetched    : ' + rows.length + ' row(s) → ' + links.length + ' usable link(s)');
if (links.length) say('sample     : ' + links[0].store + ' · ' + links[0].title.slice(0, 48) +
  ' · ' + (links[0].code || 'no code'));

/* ─────────────── normalise into the app's own schema ───────────────
   Reuses api/_data.js — the same normaliser the live feed engine uses, so
   CJ deals get categorised, slugified and region-tagged exactly like any
   other source. */
const appData = require(path.join(ROOT, 'api', '_data.js'));
const storesFile = JSON.parse(fs.readFileSync(path.join(DATA, 'stores.json'), 'utf8'));
const categories = JSON.parse(fs.readFileSync(path.join(DATA, 'categories.json'), 'utf8')).categories;
const regions = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8')).regions;
const couponsFile = JSON.parse(fs.readFileSync(path.join(DATA, 'coupons.json'), 'utf8'));

const ctx = appData.makeFeedContext(storesFile.stores, categories, regions, couponsFile.coupons);
const mapped = [];
const skipped = {};
links.forEach((l, i) => {
  const res = appData.mapFeedItem({
    id: 'cj-' + l.id,
    storeName: l.store,
    title: l.title,
    description: l.description,
    code: l.code,
    url: l.affiliateUrl,
    endDate: l.endDate,
    startDate: l.startDate
  }, i, ctx);
  if (res && res.ok && res.coupon) {
    const c = res.coupon;
    c.source = 'cj';
    c.affiliateUrl = l.affiliateUrl;
    if (!c.regions || !c.regions.length) c.regions = DEFAULT_REGIONS.slice();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.expires || ''))) c.expires = plusDays(DEFAULT_DAYS);
    mapped.push(c);
  } else {
    const why = (res && res.reason) || 'unknown';
    skipped[why] = (skipped[why] || 0) + 1;
  }
});
say('normalised : ' + mapped.length + ' coupon(s)' +
  (Object.keys(skipped).length ? ' · skipped ' + JSON.stringify(skipped) : ''));
say('categorised: ' + ctx.categorised + ' auto · new brands: ' +
  (ctx.storesAdded.length ? ctx.storesAdded.join(', ') : 'none'));

/* ─────────────────────────── write files ─────────────────────────── */
const backup = file => {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(BACKUPS, path.basename(file).replace(/\.json$/, '') + '-' + stamp + '.json');
  fs.copyFileSync(file, dest);
  return dest;
};
const writeJson = (file, data) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);                       // atomic: never a half-written file
};

const written = [];
if (!DRY_RUN) {
  writeJson(path.join(DATA, 'cj-links.json'), links);
  written.push('data/cj-links.json (' + links.length + ' links)');

  // feed-engine shape, so DEALS_FEED_URL can merge CJ deals live per request
  writeJson(path.join(DATA, 'cj-feed.json'), links.map(l => ({
    id: 'cj-' + l.id, storeName: l.store, title: l.title,
    description: l.description, code: l.code, url: l.affiliateUrl,
    endDate: l.endDate, startDate: l.startDate, source: 'cj'
  })));
  written.push('data/cj-feed.json');

  if (REGISTER_STORES && ctx.storesAdded.length) {
    backup(path.join(DATA, 'stores.json'));
    storesFile.stores = ctx.stores;      // ctx.stores is the list new brands were added to
    writeJson(path.join(DATA, 'stores.json'), storesFile);
    written.push('data/stores.json (+' + ctx.storesAdded.length + ' brands)');
  }

  if (!NO_MERGE && mapped.length) {
    const couponsPath = path.join(DATA, 'coupons.json');
    const bak = backup(couponsPath);
    const byId = {};
    (REPLACE ? [] : couponsFile.coupons).forEach(c => { byId[c.id] = c; });
    mapped.forEach(c => { byId[c.id] = c; });            // CJ rows upsert by id
    couponsFile.coupons = Object.keys(byId).sort((a, b) =>
      String(a).localeCompare(String(b), 'en', { numeric: true })).map(k => byId[k]);
    writeJson(couponsPath, couponsFile);
    written.push('data/coupons.json (' + couponsFile.coupons.length + ' deals' +
      (bak ? ', backup → ' + path.relative(ROOT, bak) : '') + ')');
  }
}

say('');
say(DRY_RUN ? 'dry run — would have written:' : 'written:');
written.forEach(w => say('  ✓ ' + w));
if (DRY_RUN) {
  say('  · data/cj-links.json (' + links.length + ' links)');
  say('  · data/cj-feed.json');
  say('  · data/coupons.json (' + (REPLACE ? mapped.length : couponsFile.coupons.length) + ' deals)');
}

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: true, via: result.via, fetched: links.length, merged: mapped.length,
    storesAdded: ctx.storesAdded, skipped, files: written, notes
  }, null, 2));
} else {
  say('');
  say('Next: npm run validate && npm run predeploy   (then rebuild the deploy zip)');
}
})();
