#!/usr/bin/env node
/**
 * NipCoupon — JOB 1 · Daily keyword & content sync.
 *
 *   1. Builds seed terms from data/stores.json + data/keywords.json
 *   2. Expands them into long-tail queries via Google Autocomplete
 *   3. Scores and ranks them (long-tail, store-bearing, seasonal)
 *   4. Rotates a fresh set into the page <meta> tags, deterministically
 *      seeded by today's date so the same day always yields the same set
 *
 * Runs offline-safe: if the network is unavailable it falls back to locally
 * generated combinations, so the rotation never silently stops.
 *
 * Usage:  node scripts/keyword-sync.js [--dry-run] [--json] [--no-patch]
 *                                      [--samples=12] [--rotate=12] [--offline]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const D = require('./_daily');

const args = D.parseArgs(process.argv);
const DRY     = D.bool(args.flags['dry-run']);
const AS_JSON = D.bool(args.flags.json);
const NO_PATCH = D.bool(args.flags['no-patch']) || D.bool(D.env('KEYWORD_NO_PATCH', false));
const SAMPLES = D.num(args.flags.samples, D.env('KEYWORD_SAMPLES', 12));
const ROTATE_N = D.num(args.flags.rotate, D.env('KEYWORD_ROTATE', 12));
const OFFLINE = D.bool(args.flags.offline) || D.bool(D.env('KEYWORD_OFFLINE', false));

D.setLogMode({ json: AS_JSON });

const SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';
const INDEX_HTML = path.join(D.ROOT, 'index.html');

/* ========================================================== seasonal === */

function mmdd(date) {
  const d = date || new Date();
  return String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/** Handles ranges that wrap the year boundary (e.g. 12-26 → 01-07). */
function inSeason(today, start, end) {
  return start <= end ? (today >= start && today <= end) : (today >= start || today <= end);
}

function activeSeasonal(kw) {
  const today = mmdd();
  return (kw.seasonal || []).filter(ev => inSeason(today, ev.start, ev.end));
}

/* ============================================================== seeds === */

function buildSeeds(kw, stores) {
  const names = stores.map(s => s.name).filter(Boolean);
  const seeds = [];

  // Brand + modifier — the highest-intent coupon queries.
  //
  // The two original modifiers are the head terms: high volume, but every
  // competitor targets them. The extras below are transactional long-tail —
  // lower volume each, far lower difficulty, and they convert better because
  // the searcher is already at checkout looking for a code that works.
  //
  // Kept to the top 12 brands × 6 extras so the candidate pool stays inside
  // the autocomplete fetch budget; the full 30 still get the two head terms.
  names.slice(0, 30).forEach(n => {
    seeds.push(n + ' promo code');
    seeds.push(n + ' discount code');
  });

  const INTENT = [
    'voucher code',
    'active promo code',
    'valid voucher',
    'working discount code',
    'free shipping code',
    'first order discount'
  ];
  names.slice(0, 12).forEach(n => {
    INTENT.forEach(m => seeds.push(n + ' ' + m));
  });

  // Month-stamped variants — "<brand> promo code september 2026" is a real,
  // recurring query pattern and signals freshness in the SERP.
  const now = new Date();
  const MONTH = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'][now.getUTCMonth()];
  const stamp = MONTH + ' ' + now.getUTCFullYear();
  names.slice(0, 10).forEach(n => seeds.push(n + ' promo code ' + stamp));

  (kw.categories || []).forEach(c => seeds.push(c));

  // Category × qualifier
  (kw.categories || []).slice(0, 4).forEach(c => {
    (kw.qualifiers || []).slice(0, 3).forEach(q => seeds.push(q + ' ' + c));
  });

  // Seasonal events get priority
  activeSeasonal(kw).forEach(ev => (ev.terms || []).forEach(t => seeds.push(t)));

  return D.unique(seeds);
}

/* ============================================================ suggest === */

async function suggest(term) {
  const url = SUGGEST_URL + '?client=firefox&hl=en&q=' + encodeURIComponent(term);
  const r = await D.request(url, { timeout: 8000 });
  if (!r.ok || !r.body) return [];
  try {
    const parsed = JSON.parse(r.body);
    return Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1] : [];
  } catch (e) { return []; }
}

/* ============================================================= scoring === */

function makeContext(kw, stores) {
  const storeLower = stores.map(s => String(s.name || '').toLowerCase()).filter(Boolean);
  return {
    storeLower,
    modifiers: (kw.modifiers || []).map(String),
    qualifiers: (kw.qualifiers || []).map(String),
    seasonalTerms: activeSeasonal(kw).reduce((acc, ev) => acc.concat(ev.terms || []), []).map(String)
  };
}

function scoreTerm(term, ctx) {
  const words = term.split(/\s+/).filter(Boolean);
  const lower = term.toLowerCase();
  let s = 0;

  // Long-tail sweet spot: specific enough to rank, short enough to be real.
  if (words.length >= 3 && words.length <= 6) s += 3;
  else if (words.length === 2) s += 1;
  else if (words.length > 6) s -= 1;

  if (ctx.storeLower.some(n => n && lower.includes(n))) s += 3;
  if (ctx.modifiers.some(m => lower.includes(m))) s += 2;
  if (ctx.qualifiers.some(q => lower.includes(q))) s += 2;
  if (ctx.seasonalTerms.some(t => lower.includes(t))) s += 3;
  if (/\b20[2-9]\d\b/.test(lower)) s += 1;
  if (/\b(free|save|cheap|best|off)\b/.test(lower)) s += 1;

  return s;
}

/* ====================================================== offline fallback === */

function localCombinations(kw, stores, ctx) {
  const out = [];
  const names = stores.map(s => s.name).filter(Boolean).slice(0, 24);
  names.forEach(n => {
    (kw.modifiers || []).slice(0, 4).forEach(m => out.push(n + ' ' + m));
  });
  (kw.qualifiers || []).forEach(q => {
    (kw.categories || []).slice(0, 3).forEach(c => out.push(q + ' ' + c));
  });
  ctx.seasonalTerms.forEach(t => out.push(t));
  return D.unique(out);
}

/* ============================================================ meta tags === */

function buildDescription(keywords, seasonalNames, storeCount, couponCount) {
  const lead = seasonalNames.length
    ? seasonalNames[0] + ' savings, plus '
    : '';
  const tail = keywords.slice(0, 4).join(', ');
  const base = 'NipCoupon — ' + lead + 'verified promo codes and deals from '
    + storeCount + ' global brands. ' + couponCount + ' live offers updated daily. ' + tail + '.';
  return (base.length > 320 ? base.slice(0, 317) + '...' : base);
}

function patchIndexHtml(description, keywordsCsv) {
  const original = D.readText(INDEX_HTML);
  if (!original) { D.warn('index.html not found — skipping meta patch'); return false; }

  let html = original;
  const escDesc = D.escapeXml(description);
  const escKeys = D.escapeXml(keywordsCsv);

  const descTag = '<meta name="description" content="' + escDesc + '" />';
  const keyTag  = '<meta name="keywords" content="' + escKeys + '" />';

  const descRe = /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i;
  const keyRe  = /<meta\s+name="keywords"\s+content="[^"]*"\s*\/?>/i;

  if (descRe.test(html)) html = html.replace(descRe, descTag);
  else D.warn('no <meta name="description"> found in index.html');
  if (keyRe.test(html)) html = html.replace(keyRe, keyTag);
  else D.warn('no <meta name="keywords"> found in index.html');

  if (html === original) return false;

  // Keep a timestamped copy — this rewrites a file in the repo root.
  try {
    D.ensureDir(D.BACKUP_DIR);
    fs.copyFileSync(INDEX_HTML, path.join(D.BACKUP_DIR, 'index-' + D.stamp() + '.html'));
  } catch (e) { D.warn('index.html backup skipped — ' + e.message); }

  return D.writeText(INDEX_HTML, html);
}

/* ================================================================= main === */

async function main() {
  const started = Date.now();
  const today = D.todayISO();

  const kw      = D.readData('keywords.json', null);
  const stores  = D.readData('stores.json', { stores: [] }).stores || [];
  const coupons = D.readData('coupons.json', { coupons: [] }).coupons || [];

  if (!kw) { D.fail('data/keywords.json is missing'); process.exit(1); }

  D.step('NipCoupon — keyword & content sync · ' + today);

  const ctx = makeContext(kw, stores);
  const seasonal = activeSeasonal(kw);
  const seasonalNames = seasonal.map(e => e.name);

  D.info('stores: ' + stores.length + ' · coupons: ' + coupons.length);
  D.info('seasonal window: ' + (seasonalNames.length ? seasonalNames.join(', ') : 'none'));

  /* --- 1. expand seeds into long-tail candidates ---------------------- */
  const seeds = buildSeeds(kw, stores);
  const sample = D.seededShuffle(seeds, today).slice(0, Math.max(1, SAMPLES));

  let collected = [];
  let source = 'google-autocomplete';

  if (OFFLINE) {
    source = 'offline-local';
    collected = localCombinations(kw, stores, ctx);
    D.info('offline mode — using locally generated combinations');
  } else {
    const results = await D.pool(sample, 4, async term => {
      const s = await suggest(term);
      await D.sleep(120);              // be polite to the suggest endpoint
      return s;
    });
    const flat = results.reduce((acc, r) => acc.concat(Array.isArray(r) ? r : []), []);
    collected = D.unique(flat);

    if (collected.length < 10) {
      D.warn('autocomplete returned ' + collected.length + ' terms — falling back to local combinations');
      source = 'offline-local';
      collected = D.unique(collected.concat(localCombinations(kw, stores, ctx)));
    }
  }

  /* --- 2. score + rank ------------------------------------------------ */
  const scored = collected
    .map(t => String(t).trim())
    .filter(t => t.length > 6 && t.length < 90)
    .map(t => ({ term: t, score: scoreTerm(t, ctx) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.term.length - b.term.length);

  const poolTerms = D.unique(scored.map(x => x.term));
  D.info('candidates: ' + poolTerms.length + ' (source: ' + source + ')');

  /* --- 3. deterministic daily rotation -------------------------------- */
  const rotated = D.seededShuffle(poolTerms, 'rotate-' + today).slice(0, Math.max(1, ROTATE_N));
  const keywordsCsv = rotated.slice(0, 15).join(', ');
  const description = buildDescription(rotated, seasonalNames, stores.length, coupons.length);

  D.info('rotated in: ' + rotated.slice(0, 5).join(' · '));

  /* --- 4. persist ----------------------------------------------------- */
  const next = Object.assign({}, kw, {
    updatedAt: new Date().toISOString(),
    longTail: poolTerms.slice(0, 200),
    history: [{ date: today, keywords: rotated, seasonal: seasonalNames, source: source }]
      .concat(kw.history || []).slice(0, 60)
  });

  const state = {
    date: today,
    updatedAt: next.updatedAt,
    source,
    seasonal: seasonalNames,
    keywords: rotated,
    description,
    candidates: poolTerms.length
  };

  const report = {
    job: 'keywords',
    date: today,
    source,
    candidates: poolTerms.length,
    rotated: rotated.length,
    keywords: rotated,
    description,
    seasonal: seasonalNames,
    durationMs: Date.now() - started,
    wrote: []
  };

  if (DRY) {
    D.ok('dry run — no files written');
    if (AS_JSON) { report.dryRun = true; console.log(JSON.stringify(report, null, 2)); }
    return report;
  }

  D.backup('keywords', kw);
  if (D.writeData('keywords.json', next)) report.wrote.push('data/keywords.json');
  if (D.writeData('seo-state.json', state)) report.wrote.push('data/seo-state.json');

  if (!NO_PATCH) {
    if (patchIndexHtml(description, keywordsCsv)) report.wrote.push('index.html (meta)');
  } else {
    D.info('--no-patch: index.html left untouched');
  }

  D.ok('wrote: ' + report.wrote.join(', '));
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  return report;
}

main().catch(e => {
  D.fail('keyword sync crashed — ' + ((e && e.message) || e));
  process.exit(1);
});
