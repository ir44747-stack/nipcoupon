#!/usr/bin/env node
/**
 * sync-offers.js — the daily provider sync.
 *
 *   node scripts/sync-offers.js                 # fetch → validate → publish
 *   node scripts/sync-offers.js --dry-run       # show what would change
 *   node scripts/sync-offers.js --json          # machine-readable (cron/CI)
 *   node scripts/sync-offers.js --skip-live     # validate syntax/policy only, no probing
 *   node scripts/sync-offers.js --file=offers.json   # read a local payload instead of the API
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * 1. Pulls raw offers from ONE authorised endpoint (OFFERS_API_URL) using an
 *    API key held only in an environment variable (OFFERS_API_KEY).
 * 2. Normalises each record into NipCoupon's coupon shape.
 * 3. Assigns every offer a canonical path on OUR domain: /coupon/<slug>
 *    (and /category/<categoryId> is recorded for grouping). It never publishes
 *    a provider's own URL as the canonical one.
 * 4. Runs every link through link-guard.js — syntax, allowlist, expiry,
 *    verification, live probe. Rejected offers are dropped, not published.
 * 5. Merges survivors into data/coupons.json, backing up first.
 *
 * ── Fallback behaviour ───────────────────────────────────────────────────────
 * A provider outage must never wipe the catalogue. If the fetch fails or
 * returns nothing usable, the script leaves data/coupons.json untouched, keeps
 * serving the last good snapshot from data/provider-snapshot.json, and exits 1
 * so cron can alert. The site degrades to yesterday's deals, never to an empty
 * page.
 *
 * Exit codes: 0 ok · 1 provider unreachable / nothing publishable · 2 misconfigured
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('../api/_secrets.js');
const G = require('./link-guard.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BACKUPS = path.join(ROOT, 'backups');

/* ── CLI ───────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const argOf = (n, d) => {
  const hit = argv.find(a => a.startsWith(n + '='));
  return hit ? hit.slice(n.length + 1) : d;
};
const AS_JSON = has('--json');
const DRY_RUN = has('--dry-run');
const SKIP_LIVE = has('--skip-live');
const FILE = argOf('--file', '');
const TIMEOUT = Number(argOf('--timeout', 20000)) || 20000;
const CONCURRENCY = Number(argOf('--concurrency', 6)) || 6;
const MAX_AGE_DAYS = Number(argOf('--max-age-days', 45)) || 45;

function say(...a) { if (!AS_JSON) console.log(...a); }

/* ── Config (always from env, never from source) ───────────────────────────── */
const API_URL = S.env('OFFERS_API_URL').trim();
const API_KEY = S.env('OFFERS_API_KEY').trim() || S.env('OFFERS_API_TOKEN').trim();
const SITE_URL = (S.env('SITE_URL', 'https://nipcoupon.vercel.app').trim() || 'https://nipcoupon.vercel.app').replace(/\/+$/, '');

/* ── Small utilities ───────────────────────────────────────────────────────── */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'offer';
}

function isoPlusDays(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function backup(file) {
  if (!fs.existsSync(BACKUPS)) fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.basename(file, '.json');
  const dest = path.join(BACKUPS, base + '-' + stamp + '.json');
  if (fs.existsSync(file)) fs.copyFileSync(file, dest);
  return dest;
}

function firstString(raw, keys) {
  for (const k of keys) {
    const v = raw && raw[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
    if (v && typeof v === 'object' && typeof v.url === 'string') return v.url.trim();
  }
  return '';
}

/* ── 1. Fetch ──────────────────────────────────────────────────────────────── */
async function fetchOffers() {
  if (FILE) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(FILE), 'utf8'));
    return { items: extractItems(raw), source: 'file:' + FILE };
  }
  if (!API_URL) {
    say('');
    say('OFFERS_API_URL is not set — nothing to sync.');
    say('');
    say('  Set it in nipcoupon/.env (local) or Vercel → Settings → Environment Variables:');
    say('    OFFERS_API_URL=https://api.your-provider.com/v1/offers');
    say('    OFFERS_API_KEY=…');
    say('');
    process.exit(2);
  }
  if (!API_KEY) {
    say('');
    say('OFFERS_API_KEY is not set. Refusing to call the provider unauthenticated.');
    say('Add it to .env / Vercel Environment Variables and re-run.');
    say('');
    process.exit(2);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(API_URL, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'NipCouponBot/1.0 (+https://nipcoupon.vercel.app)',
        // Bearer is the common case; providers using a header token can set
        // OFFERS_API_HEADER_NAME to override.
        [S.env('OFFERS_API_HEADER_NAME', 'Authorization').trim()]:
          S.env('OFFERS_API_HEADER_STYLE', 'Bearer').trim() === 'raw'
            ? API_KEY
            : 'Bearer ' + API_KEY
      }
    });
    if (!res.ok) {
      return { error: 'provider returned HTTP ' + res.status, status: res.status };
    }
    return { items: extractItems(await res.json()), source: API_URL };
  } catch (err) {
    return { error: err && err.name === 'AbortError' ? 'timeout' : S.redact((err && err.message) || 'network error') };
  } finally {
    clearTimeout(timer);
  }
}

/* Accepts the handful of envelopes providers actually send. */
function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const k of ['offers', 'coupons', 'deals', 'items', 'data', 'results', 'promotions']) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  for (const v of Object.values(payload)) if (Array.isArray(v)) return v;
  return [];
}

/* ── 2. Normalise + 3. canonical mapping ───────────────────────────────────── */
function normalize(raw, i, knownStores, knownCats) {
  const storeName = firstString(raw, ['advertiser', 'storeName', 'store', 'merchant', 'brand', 'advertiserName']);
  const storeId = slugify(storeName || firstString(raw, ['storeId', 'advertiserId', 'merchantId']));
  const title = firstString(raw, ['title', 'name', 'description', 'headline', 'offerName']);
  const link = firstString(raw, ['landingUrl', 'url', 'link', 'trackingUrl', 'clickUrl', 'deeplink', 'affiliateUrl']);
  const code = firstString(raw, ['code', 'couponCode', 'promoCode', 'voucherCode']);
  const expires = firstString(raw, ['expires', 'expiryDate', 'endDate', 'expiresAt', 'validUntil']);
  const categoryId = slugify(firstString(raw, ['category', 'categoryId', 'vertical', 'categoryName'])) || 'tech';

  const slug = slugify((storeId + '-' + (code || title || '')).trim()) || ('offer-' + (i + 1));

  return {
    id: slug,
    canonicalPath: '/coupon/' + slug,
    canonicalUrl: SITE_URL + '/coupon/' + slug,
    categoryPath: '/category/' + categoryId,
    storeId,
    storeName,
    categoryId,
    type: code ? 'code' : 'deal',
    code,
    badge: firstString(raw, ['badge', 'discount', 'offerValue']) || (code ? code : 'DEAL'),
    value: Number(firstString(raw, ['value', 'discountValue', 'amount'])) || 0,
    title: title || (storeName + ' offer'),
    verifiedHoursAgo: 0,
    verified: raw.verified === true || raw.status === 'verified' ? true : (raw.verified === false ? false : undefined),
    expires: expires || isoPlusDays(MAX_AGE_DAYS),
    uses: Number(raw.uses || raw.clicks || 0) || 0,
    rating: Math.min(5, Math.max(0, Number(raw.rating) || 0)),
    addedDaysAgo: 0,
    hot: !!raw.hot || !!raw.featured,
    terms: Array.isArray(raw.terms) ? raw.terms.slice(0, 4) : [],
    landingUrl: link,
    regions: (Array.isArray(raw.regions) && raw.regions.length) ? raw.regions.map(String) : ['GLOBAL'],
    source: 'provider',
    _knownStore: knownStores.has(storeId)
  };
}

/* ── main ──────────────────────────────────────────────────────────────────── */
(async () => {
  say('');
  say('NipCoupon provider sync — ' + new Date().toISOString());
  say('─'.repeat(52));

  const storesDoc = JSON.parse(fs.readFileSync(path.join(DATA, 'stores.json'), 'utf8'));
  const knownStores = new Set((storesDoc.stores || []).map(s => s.id));
  const catsDoc = JSON.parse(fs.readFileSync(path.join(DATA, 'categories.json'), 'utf8'));
  const knownCats = new Set((catsDoc.categories || []).map(c => c.id));

  /* 1 — fetch */
  const fetched = await fetchOffers();
  if (fetched.error) {
    say('  ✗ provider unreachable: ' + fetched.error);
    const snap = path.join(DATA, 'provider-snapshot.json');
    if (fs.existsSync(snap)) {
      const snapAge = Math.round((Date.now() - fs.statSync(snap).mtimeMs) / 3600000);
      say('  → keeping data/coupons.json unchanged; last good snapshot is ' + snapAge + 'h old');
    }
    say('');
    if (AS_JSON) console.log(JSON.stringify({ ok: false, error: fetched.error, fallback: true }, null, 2));
    process.exit(1);
  }

  const rawItems = fetched.items || [];
  say('  fetched ' + rawItems.length + ' raw offers from provider');

  /* 2 — normalise */
  const offers = rawItems.map((r, i) => normalize(r, i, knownStores, knownCats));
  const unknownStore = offers.filter(o => !o._knownStore).length;
  say('  normalised ' + offers.length + ' offers (' + unknownStore + ' from stores not yet in stores.json)');

  /* 4 — validate every link before it can be published */
  const { publishable, rejected } = await G.validateOffers(offers, {
    concurrency: CONCURRENCY,
    timeout: TIMEOUT,
    skipLive: SKIP_LIVE,
    allowUnverified: false
  });

  const byReason = {};
  rejected.forEach(r => { byReason[r.reason] = (byReason[r.reason] || 0) + 1; });
  say('  link-guard: ' + publishable.length + ' publishable / ' + rejected.length + ' rejected');
  for (const [reason, n] of Object.entries(byReason)) {
    say('      ' + String(n).padStart(4) + '  ' + reason);
  }

  if (!publishable.length) {
    say('');
    say('  ✗ nothing passed validation — data/coupons.json left untouched');
    say('');
    if (AS_JSON) console.log(JSON.stringify({ ok: false, reason: 'nothing-publishable', rejected: byReason }, null, 2));
    process.exit(1);
  }

  /* 5 — merge into the catalogue (provider records replace same-id entries) */
  const couponsPath = path.join(DATA, 'coupons.json');
  const doc = JSON.parse(fs.readFileSync(couponsPath, 'utf8'));
  const existing = doc.coupons || [];
  const byId = new Map(existing.map(c => [c.id, c]));
  let added = 0, updated = 0;
  for (const o of publishable) {
    const clean = Object.assign({}, o);
    delete clean._knownStore;
    if (byId.has(clean.id)) { updated++; byId.set(clean.id, Object.assign({}, byId.get(clean.id), clean)); }
    else { added++; byId.set(clean.id, clean); }
  }
  const merged = [...byId.values()];

  say('  merge: ' + added + ' added, ' + updated + ' updated → ' + merged.length + ' total coupons');

  if (!DRY_RUN) {
    const b1 = backup(couponsPath);
    doc.coupons = merged;
    fs.writeFileSync(couponsPath, JSON.stringify(doc, null, 2) + '\n');

    // last good snapshot — what we serve during an outage
    fs.writeFileSync(
      path.join(DATA, 'provider-snapshot.json'),
      JSON.stringify({ savedAt: new Date().toISOString(), source: fetched.source, offers: publishable }, null, 2) + '\n'
    );
    say('  backup: ' + path.relative(ROOT, b1));
    say('  wrote  : data/coupons.json + data/provider-snapshot.json');
  } else {
    say('  (dry run — nothing written)');
  }

  say('');
  say('  Sample canonical URLs:');
  publishable.slice(0, 5).forEach(o => say('    ' + o.canonicalUrl));

  say('');
  if (AS_JSON) {
    console.log(JSON.stringify({
      ok: true, fetched: rawItems.length, publishable: publishable.length,
      rejected: rejected.length, byReason, added, updated, total: merged.length, dryRun: DRY_RUN
    }, null, 2));
  }
  process.exit(0);
})();
