/**
 * _keywords.js — the pure keyword engine behind GET /api/keywords.
 *
 * Kept separate from the route so api/page.js can build meta tags server-side
 * without an HTTP round trip (a self-fetch would double the latency of every
 * programmatic page and burn a serverless invocation for nothing).
 *
 * Deterministic by date: the same day always produces the same rotation, which
 * makes the output cacheable and stops meta tags flickering between requests.
 *
 * Underscore prefix → Vercel does not expose this file as a route.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ── Deterministic rotation ──────────────────────────────────────────────── */

/** xorshift32 PRNG seeded from a string: same seed → same sequence, always. */
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0 || 1;
  return function () {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;  state >>>= 0;
    return state / 4294967296;
  };
}

function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function isoDate(d) {
  const dt = d ? new Date(d) : new Date();
  const t = dt.getTime();
  return (isNaN(t) ? new Date() : dt).toISOString().slice(0, 10);
}

/* ── Data ────────────────────────────────────────────────────────────────── */

function readJson(rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

/** Seasonal window check — inclusive, handles windows that wrap the year end. */
function inSeason(entry, date) {
  if (!entry || !entry.start || !entry.end) return false;
  const mm = isoDate(date).slice(5);              // "MM-DD"
  const s = String(entry.start);
  const e = String(entry.end);
  return s <= e ? (mm >= s && mm <= e) : (mm >= s || mm <= e);
}

/* ── Generation ──────────────────────────────────────────────────────────── */

function buildTerms(catalog, bank, opts) {
  const stores = (catalog.stores || []).map(s => String(s.name || '').trim()).filter(Boolean);
  const cats = (catalog.categories || []).map(c => String(c.name || '').trim()).filter(Boolean);

  const modifiers = (bank.modifiers || []).length
    ? bank.modifiers
    : ['promo code', 'discount code', 'coupon code', 'voucher code', 'coupon', 'voucher', 'deal', 'offer'];
  const qualifiers = (bank.qualifiers || []).length
    ? bank.qualifiers
    : ['free delivery', 'free shipping', 'first order', 'student discount', 'sitewide'];

  /* Only the seasons actually running today. Without this every seasonal term
     scores as evergreen and swamps the branded terms a store page needs. */
  const today = isoDate(opts.date);
  const seasonal = (bank.seasonal || []).filter(s => inSeason(s, today));
  const seasonalNames = seasonal.map(s => s.name).filter(Boolean);

  /* Match on id OR display name — callers pass `amazon` or `Amazon`, `tech`
     or `Tech & Electronics`, and both should work. */
  const wanted = v => String(v || '').trim().toLowerCase();
  const wantStore = wanted(opts.store);
  const wantCat = wanted(opts.category);

  const focusStore = wantStore
    ? (catalog.stores || [])
        .filter(s => wanted(s.id) === wantStore || wanted(s.name) === wantStore)
        .map(s => String(s.name || '').trim()).filter(Boolean)
    : [];
  const focusCat = wantCat
    ? (catalog.categories || [])
        .filter(c => wanted(c.id) === wantCat || wanted(c.name) === wantCat)
        .map(c => String(c.name || '').trim()).filter(Boolean)
    : [];

  const brands = focusStore.length ? focusStore : stores.slice(0, 40);
  const themes = focusCat.length ? focusCat : cats.slice(0, 12);

  const out = [];

  // "<brand> <modifier>" — the highest-intent pattern there is.
  brands.forEach(b => modifiers.forEach(m => out.push({ term: b + ' ' + m, base: 60, kind: 'brand' })));

  // "<brand> <modifier> <qualifier>" — long tail, low competition.
  brands.forEach(b => {
    modifiers.slice(0, 4).forEach(m => {
      qualifiers.forEach(q => out.push({ term: b + ' ' + m + ' ' + q, base: 45, kind: 'brand-longtail' }));
    });
  });

  // "<category> <modifier>" — non-branded discovery.
  themes.forEach(c => modifiers.forEach(m => out.push({ term: c + ' ' + m, base: 30, kind: 'category' })));

  // seasonal, both standalone and branded
  seasonalNames.forEach(n => {
    modifiers.slice(0, 4).forEach(m => {
      out.push({ term: n + ' ' + m, base: 55, kind: 'seasonal' });
      brands.slice(0, 12).forEach(b => {
        out.push({ term: b + ' ' + n + ' ' + m, base: 40, kind: 'seasonal-brand' });
      });
    });
  });

  return { terms: out, seasonalNames };
}

function score(t, ctx) {
  let s = t.base || 0;
  const words = t.term.split(/\s+/).length;
  if (words >= 4) s += 26;                    // genuine long tail
  else if (words >= 3) s += 18;
  if (ctx.brandSet.has(t.term.split(' ')[0].toLowerCase())) s += 12;
  if (t.kind === 'seasonal' || t.kind === 'seasonal-brand') s += 15;
  if (t.term.length > 60) s -= 20;            // unwieldy for a meta tag
  // On a store page the brand IS the query — make sure its terms win.
  if (ctx.store && t.term.toLowerCase().indexOf(ctx.store.toLowerCase()) === 0) s += 60;
  if (t.kind === 'seasonal-brand') s -= 10;
  return s;
}

/* How the final set is composed. Without quotas a single high-scoring family
   (usually seasonal) takes every slot and the meta tag stops looking like the
   page it belongs to. The mix adapts to the page: a store page leads with the
   brand, a category page leads with the category. */
const QUOTAS = {
  default: [
    { kinds: ['brand'],                      share: 0.40 },
    { kinds: ['brand-longtail'],             share: 0.25 },
    { kinds: ['category'],                   share: 0.20 },
    { kinds: ['seasonal', 'seasonal-brand'], share: 0.15 }
  ],
  store: [
    { kinds: ['brand'],                      share: 0.50 },
    { kinds: ['brand-longtail'],             share: 0.30 },
    { kinds: ['seasonal-brand', 'seasonal'], share: 0.15 },
    { kinds: ['category'],                   share: 0.05 }
  ],
  category: [
    { kinds: ['category'],                   share: 0.45 },
    { kinds: ['brand'],                      share: 0.20 },
    { kinds: ['brand-longtail'],             share: 0.20 },
    { kinds: ['seasonal', 'seasonal-brand'], share: 0.15 }
  ]
};

function generate(catalog, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(40, Number(o.limit) || 12));
  const bank = readJson('data/keywords.json', {});
  const { terms, seasonalNames } = buildTerms(catalog, bank, o);

  const brandSet = new Set((catalog.stores || []).map(s => String(s.name || '').toLowerCase()));
  const ctx = { brandSet, store: o.store || '' };

  const seen = new Set();
  const unique = terms.filter(t => {
    const k = t.term.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  unique.forEach(t => { t.score = score(t, ctx); });

  const byKind = {};
  unique.forEach(t => {
    (byKind[t.kind] = byKind[t.kind] || []).push(t);
  });
  Object.keys(byKind).forEach(k => byKind[k].sort((a, b) => b.score - a.score || a.term.localeCompare(b.term)));

  /* Take a pool from each family, rotate it, then fill any shortfall from
     whatever scored highest overall. */
  const rand = seeded(isoDate(o.date) + '|' + (o.store || '') + '|' + (o.category || ''));
  const picked = [];
  const used = new Set();

  const quotas = o.store ? QUOTAS.store : (o.category ? QUOTAS.category : QUOTAS.default);

  quotas.forEach(q => {
    let pool = [];
    q.kinds.forEach(k => { pool = pool.concat(byKind[k] || []); });
    pool = shuffled(pool, rand).slice(0, Math.max(1, Math.ceil(limit * q.share)));
    pool.forEach(t => {
      if (picked.length >= limit * 2) return;
      if (used.has(t.term.toLowerCase())) return;
      used.add(t.term.toLowerCase());
      picked.push(t);
    });
  });

  if (picked.length < limit) {
    const rest = unique.slice().sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
    for (const t of rest) {
      if (picked.length >= limit) break;
      if (used.has(t.term.toLowerCase())) continue;
      used.add(t.term.toLowerCase());
      picked.push(t);
    }
  }

  const keywords = picked.slice(0, limit).map(t => t.term);
  return {
    keywords,
    meta: keywords.join(', '),
    seasonal: seasonalNames,
    total: unique.length
  };
}

module.exports = {
  seeded, shuffled, isoDate, inSeason, buildTerms, score, readJson,
  generate
};
