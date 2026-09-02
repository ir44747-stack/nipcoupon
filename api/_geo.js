/**
 * _geo.js — the single source of truth for region resolution and link
 * localisation. Shared by api/geo.js, api/stores.js, api/deals.js and the
 * Vercel Edge middleware.
 *
 * Design rule, non-negotiable: **localisation may never break a link.**
 * Every step is guarded. If a rule is missing, malformed or unresolvable the
 * original URL is returned untouched. A visitor seeing the global storefront is
 * a minor miss; a visitor hitting a 404 or an unmonetised link is a real loss.
 *
 * The subtlety that makes this module worth having: stored URLs are Sovrn
 * wrappers of the form
 *
 *     https://sovrn.co/?key=…&u=https%3A%2F%2Fwww.amazon.com&cuid=nipcoupon
 *
 * Localising `amazon.com` → `amazon.ae` therefore means rewriting the *inner*
 * `u` parameter and re-wrapping, not rewriting the outer host. Naively
 * replacing the hostname would produce `sovrn.ae` — a dead link with the
 * commission stripped. `unwrapSovrn()` / `wrapSovrn()` handle that round trip.
 *
 * Underscore prefix → Vercel does not expose this file as a route.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./_secrets.js');

const ROOT = path.join(__dirname, '..');
const RULES_PATH = path.join(ROOT, 'data', 'geo-rules.json');

const FALLBACK = 'GLOBAL';

/* ── Rules loading (cached per warm instance) ────────────────────────────── */

let cache = null;
let cacheMtime = -1;

function loadRules() {
  let mtime = -1;
  try { mtime = fs.statSync(RULES_PATH).mtimeMs; } catch (e) { /* missing file */ }
  if (cache && mtime === cacheMtime) return cache;

  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (e) {
    parsed = {};
  }

  const rules = {
    defaultRegion: parsed.defaultRegion || FALLBACK,
    fallbackRegion: parsed.fallbackRegion || FALLBACK,
    profiles: parsed.profiles || {},
    domainVariants: parsed.domainVariants || {},
    pathVariants: parsed.pathVariants || {},
    currencyParams: parsed.currencyParams || {},
    priority: parsed.priority || {},
    substitutes: parsed.substitutes || {}
  };

  cache = rules;
  cacheMtime = mtime;
  return rules;
}

/** Test seam: drop the cached rules (used by scripts and by --watch dev). */
function resetCache() { cache = null; cacheMtime = -1; }

/* ── Basic resolution ────────────────────────────────────────────────────── */

function normCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
}

function profileFor(code) {
  const r = loadRules();
  const c = normCode(code);
  return r.profiles[c] || r.profiles[r.fallbackRegion] || {
    label: c || FALLBACK, flag: '🌐', currency: 'USD',
    locale: 'en_US', lang: 'en', dir: 'ltr', tld: '.com', networks: ['sovrn']
  };
}

/** All region codes the engine knows about, rules ∪ catalogue. */
function knownRegions(extra) {
  const r = loadRules();
  const set = new Set(Object.keys(r.profiles));
  (extra || []).forEach(c => set.add(normCode(c)));
  set.add(FALLBACK);
  return Array.from(set).filter(Boolean);
}

/**
 * Map a raw country code onto a supported region.
 * Unsupported countries collapse to GLOBAL — never to a dead end.
 */
function resolveRegion(countryCode, supported) {
  const r = loadRules();
  const raw = normCode(countryCode);
  const list = (supported && supported.length ? supported : knownRegions()).map(normCode);

  if (raw && list.indexOf(raw) !== -1) {
    return { code: raw, profile: profileFor(raw), supported: true, detected: raw, fallback: false };
  }
  const fb = r.fallbackRegion || FALLBACK;
  return {
    code: list.indexOf(fb) !== -1 ? fb : (list[0] || FALLBACK),
    profile: profileFor(fb),
    supported: false,
    detected: raw || null,
    fallback: true
  };
}

/* ── Store ⇄ region fit ──────────────────────────────────────────────────── */

/** True when a store explicitly serves a region (GLOBAL counts for all). */
function serves(store, region) {
  const list = (store && Array.isArray(store.regions) ? store.regions : []).map(normCode);
  if (!list.length) return true;              // no data → assume global
  return list.indexOf(normCode(region)) !== -1 || list.indexOf(FALLBACK) !== -1;
}

/** Sort weight: lower sorts first. Ranked merchants float to the top. */
function rankFor(storeId, region, priority) {
  const r = loadRules();
  const list = (priority || r.priority[normCode(region)] || r.priority[FALLBACK] || []);
  const i = list.indexOf(storeId);
  return i === -1 ? 999 : i;
}

/**
 * Pick a regional stand-in for a store that does not serve `region`.
 * Order of preference: an explicit substitute, then the market's priority list,
 * then any store that does serve the region. Returns null when nothing fits —
 * in which case callers keep the original store rather than dropping it.
 */
function substituteFor(storeId, region, stores) {
  if (!Array.isArray(stores) || !stores.length) return null;
  const r = loadRules();
  const code = normCode(region);
  const byId = {};
  stores.forEach(s => { if (s && s.id) byId[s.id] = s; });

  /* Nothing to fix: the store already ships to this market. Returning null
     here (rather than relying on callers to check) keeps substitution from
     ever firing on a store that does not need it. */
  if (byId[storeId] && serves(byId[storeId], code)) return null;

  const explicit = (r.substitutes[code] || {})[storeId];
  if (explicit && byId[explicit] && serves(byId[explicit], code)) return explicit;

  const ranked = (r.priority[code] || []).find(id => byId[id] && serves(byId[id], code));
  if (ranked) return ranked;

  const any = stores.find(s => s && s.id && s.id !== storeId && serves(s, code));
  return any ? any.id : null;
}

/* ── Sovrn wrapper round-trip ────────────────────────────────────────────── */

function sovrnHosts() {
  const base = S.env('SOVRN_LINK_BASE', 'https://sovrn.co').trim() || 'https://sovrn.co';
  const hosts = ['sovrn.co', 'www.sovrn.co'];
  try { hosts.push(new URL(base).hostname); } catch (e) { /* keep defaults */ }
  return hosts;
}

/**
 * If `url` is a Sovrn wrapper return `{ wrapper, target }`, else null.
 * The key is deliberately NOT returned — callers rebuild from `wrapper`.
 */
function unwrapSovrn(url) {
  try {
    const u = new URL(url);
    if (sovrnHosts().indexOf(u.hostname.toLowerCase()) === -1) return null;
    const target = u.searchParams.get('u');
    if (!target) return null;
    return { wrapper: u, target: target };
  } catch (e) {
    return null;
  }
}

/**
 * Re-apply the Sovrn wrapper to a (possibly rewritten) target.
 * Falls back to the plain target when no key is configured, so the link still
 * works — it just is not monetised until the env var is set.
 */
function wrapSovrn(target, wrapper) {
  const key = S.env('SOVRN_API_KEY').trim();
  if (!key) return target;
  try {
    const u = wrapper ? new URL(wrapper.toString()) : new URL(S.env('SOVRN_LINK_BASE', 'https://sovrn.co') || 'https://sovrn.co');
    u.searchParams.set('key', key);
    u.searchParams.set('u', target);
    const cuid = S.env('SOVRN_CUID', 'nipcoupon').trim();
    if (cuid) u.searchParams.set('cuid', cuid);
    return u.toString();
  } catch (e) {
    return target;
  }
}

/* Hosts belonging to affiliate networks OTHER than Sovrn. A link on one of
   these is already carrying somebody's tracking — normally our own CJ
   publisher ID, written by scripts/fetch-cj.js. Wrapping it in sovrn.co would
   not add a second commission; it would bury the first one behind a redirect
   the originating network cannot attribute, so we would lose the sale we had
   already earned. Leave these strictly alone. */
const FOREIGN_AFFILIATE_HOSTS = [
  /(^|\.)dpbolvw\.net$/i, /(^|\.)anrdoezrs\.net$/i, /(^|\.)kqzyfj\.com$/i,
  /(^|\.)jdoqocy\.com$/i, /(^|\.)tkqlhce\.com$/i, /(^|\.)emjcd\.com$/i,
  /(^|\.)linksynergy\.com$/i, /(^|\.)awin1\.com$/i, /(^|\.)zenaps\.com$/i,
  /(^|\.)impact(-cdn)?\.com$/i, /(^|\.)7eer\.net$/i, /(^|\.)evyy\.net$/i,
  /(^|\.)partnerize\.com$/i, /(^|\.)prf\.hn$/i, /(^|\.)shareasale\.com$/i,
  /(^|\.)rakuten\.com$/i, /(^|\.)cj\.com$/i, /(^|\.)amazon-adsystem\.com$/i
];

/** True when the URL already belongs to a non-Sovrn affiliate network. */
function isForeignAffiliate(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return FOREIGN_AFFILIATE_HOSTS.some(re => re.test(h));
  } catch (e) { return false; }
}

/** Wrap a bare merchant URL for monetisation (server-side only). */
function monetise(url) {
  if (!url) return '';
  const key = S.env('SOVRN_API_KEY').trim();
  if (!key) return url;
  if (unwrapSovrn(url)) return url;                 // already wrapped
  if (isForeignAffiliate(url)) return url;          // another network owns this click
  try {
    const base = new URL(S.env('SOVRN_LINK_BASE', 'https://sovrn.co') || 'https://sovrn.co');
    base.searchParams.set('key', key);
    base.searchParams.set('u', url);
    const cuid = S.env('SOVRN_CUID', 'nipcoupon').trim();
    if (cuid) base.searchParams.set('cuid', cuid);
    return base.toString();
  } catch (e) {
    return url;
  }
}

/* ── URL localisation ────────────────────────────────────────────────────── */

function hostKey(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

/**
 * Rewrite a merchant URL for a region.
 *
 *   1. unwrap Sovrn (if present) → operate on the real target
 *   2. swap host            amazon.com → amazon.ae
 *   3. prefix path          noon.com   → noon.com/saudi-en
 *   4. append currency param booking.com?selected_currency=AED
 *   5. re-wrap Sovrn so the commission survives
 *
 * Returns { url, changed, steps: [] }.
 */
function localizeUrl(url, region) {
  const steps = [];
  const original = String(url || '');
  if (!original) return { url: '', changed: false, steps };

  const r = loadRules();
  const code = normCode(region);
  const profile = profileFor(code);

  const unwrapped = unwrapSovrn(original);
  let target = unwrapped ? unwrapped.target : original;

  let u;
  try {
    u = new URL(target);
  } catch (e) {
    return { url: original, changed: false, steps: ['unparseable-url'] };
  }

  const key = hostKey(u.hostname);

  // 2 — host swap
  const variants = r.domainVariants[key] || r.domainVariants[u.hostname.toLowerCase()] || null;
  if (variants && variants[code]) {
    const next = variants[code];
    if (next && next !== u.hostname) {
      u.hostname = next;
      steps.push('host:' + next);
    }
  }

  // 3 — market path prefix
  const paths = r.pathVariants[key] || r.pathVariants[u.hostname.toLowerCase()] || null;
  if (paths && paths[code]) {
    const prefix = String(paths[code]).replace(/^\/+|\/+$/g, '');
    if (prefix) {
      const existing = u.pathname.replace(/\/+$/, '');
      if (!existing.toLowerCase().split('/').filter(Boolean)[0] ||
          existing.toLowerCase().indexOf('/' + prefix.toLowerCase()) !== 0) {
        u.pathname = '/' + prefix + (existing === '/' ? '' : existing);
        steps.push('path:' + prefix);
      }
    }
  }

  // 4 — currency / locale hint
  const cur = r.currencyParams[key] || r.currencyParams[u.hostname.toLowerCase()] || null;
  if (cur && cur.param && profile.currency) {
    if (!u.searchParams.has(cur.param)) {
      u.searchParams.set(cur.param, profile.currency);
      steps.push(cur.param + ':' + profile.currency);
    }
  }
  if (profile.locale && /booking\.com$|agoda\.com$/.test(key)) {
    if (!u.searchParams.has('lang')) { u.searchParams.set('lang', profile.locale.replace('_', '-').toLowerCase()); steps.push('lang'); }
  }

  let out = u.toString();

  // 5 — restore the wrapper
  if (unwrapped) out = wrapSovrn(out, unwrapped.wrapper);

  return { url: out, changed: out !== original, steps };
}

/**
 * Full store localisation: URL + the metadata the UI needs to explain itself
 * (e.g. "Switched to noon.com/saudi-en for Saudi Arabia").
 * `store.url` may still carry a ${SOVRN_API_KEY} placeholder — expand first.
 */
function localizeStore(store, region, stores) {
  if (!store) return null;
  const code = normCode(region);
  const profile = profileFor(code);

  const expanded = S.resolveUrl(store.url, store.originalUrl || '');
  const base = expanded || store.originalUrl || '';
  const loc = localizeUrl(base, code);

  const out = Object.assign({}, store, {
    url: loc.url || base,
    originalUrl: store.originalUrl || base,
    region: code,
    currency: profile.currency,
    localised: loc.changed,
    localiseSteps: loc.steps,
    serves: serves(store, code)
  });

  if (!serves(store, code)) {
    const sub = substituteFor(store.id, code, stores);
    if (sub && sub !== store.id) {
      out.substituteFor = sub;
      out.substituteReason = store.name + ' does not ship to ' + (profile.label || code);
    }
  }
  return out;
}

/** Sort comparator: regional merchants first, then the catalogue order. */
function storeComparator(region) {
  const code = normCode(region);
  return function (a, b) {
    const ra = rankFor(a.id, code);
    const rb = rankFor(b.id, code);
    if (ra !== rb) return ra - rb;
    const sa = serves(a, code) ? 0 : 1;
    const sb = serves(b, code) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  };
}

/* ── Country sniffing (shared by middleware + API) ───────────────────────── */

/**
 * Best-effort country from request headers, in order:
 *   x-nc-country (set by our own edge middleware) → x-vercel-ip-country →
 *   cf-ipcountry → x-country-override (?country=XX for QA) → ''
 */
function countryFromHeaders(headers, query) {
  const h = headers || {};
  const get = k => {
    const v = h[k] != null ? h[k] : h[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const override = query && (query.country || query.region);
  if (override) return normCode(override);

  return normCode(
    get('x-nc-country') ||
    get('x-vercel-ip-country') ||
    get('cf-ipcountry') ||
    get('x-geo-country') ||
    ''
  );
}

/** Version of the rules, handy for cache-busting and for logs. */
function version() {
  const r = loadRules();
  return { version: 1, regions: Object.keys(r.profiles).length, fallback: r.fallbackRegion };
}

module.exports = {
  FALLBACK,
  loadRules,
  resetCache,
  profileFor,
  knownRegions,
  resolveRegion,
  serves,
  rankFor,
  substituteFor,
  unwrapSovrn,
  wrapSovrn,
  monetise,
  isForeignAffiliate,
  localizeUrl,
  localizeStore,
  storeComparator,
  countryFromHeaders,
  normCode,
  version
};
