/**
 * Shared data layer for the NipCoupon API.
 *
 * Reads the modular JSON files in /data, optionally merges a remote deals
 * feed (env: DEALS_FEED_URL), and exposes filtering / sorting / paging that
 * mirrors the front-end logic so any client can consume the same catalogue.
 *
 * Files beginning with an underscore are not exposed as routes by Vercel.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./_secrets.js');
const G = require('./_geo.js');

// resolve relative to this module so it works regardless of the process cwd
// (Vercel sets cwd to /var/task, local dev servers vary)
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_TTL_MS = 60 * 1000; // 1 minute

let cache = null;
let cacheStamp = 0;
let lastGoodFeed = null;                        // last successful pull, reused during outages
const STALE_FEED_MS = 15 * 60 * 1000;           // keep serving it for 15 minutes

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

/** Normalise one raw coupon record coming from JSON or a remote feed. */
function normalizeCoupon(raw, index) {
  const c = Object.assign({}, raw);
  const type = c.type === 'deal' ? 'deal' : 'code';
  return {
    id: String(c.id || 'c' + (index + 1)),
    storeId: String(c.storeId || ''),
    categoryId: String(c.categoryId || ''),
    type,
    code: type === 'deal' ? '' : String(c.code || '').trim(),
    badge: String(c.badge || '').trim(),
    value: Number(c.value) || 0,
    title: String(c.title || '').trim(),
    verifiedHoursAgo: Number(c.verifiedHoursAgo) || 0,
    expires: String(c.expires || ''),
    uses: Number(c.uses) || 0,
    rating: Math.min(5, Math.max(0, Number(c.rating) || 0)),
    addedDaysAgo: Number(c.addedDaysAgo) || 0,
    hot: !!c.hot,
    terms: Array.isArray(c.terms) ? c.terms : [],
    landingUrl: String(c.landingUrl || ''),
    regions: (Array.isArray(c.regions) && c.regions.length ? c.regions.map(String) : ['GLOBAL']),
    source: c.source || 'local'
  };
}

/* ============================================================
   SECURE URL RESOLUTION
   ============================================================
   Store URLs in /data hold a `${SOVRN_API_KEY}` placeholder, never the key
   itself (see api/_secrets.js). Expanding it here — server-side, per request —
   means:
     • the key lives only in Vercel env vars, so one change rotates all 70 links
     • the key never sits in a committed file or a backup
     • if the env var is missing we fall back to `originalUrl`: a working,
       non-monetised link instead of a 400 from the wrapper
*/
function resolveStore(s) {
  if (!s) return s;
  const url = S.resolveUrl(s.url, s.originalUrl || '');
  if (url === s.url) return s;
  return Object.assign({}, s, { url });
}

function resolveCoupon(c) {
  if (!c || !c.landingUrl) return c;

  if (c.landingUrl.indexOf('${') !== -1) {
    const url = S.resolveUrl(c.landingUrl, '');
    // Unresolved placeholder → drop the link rather than publish a broken one.
    if (!url) return Object.assign({}, c, { landingUrl: '', linkUnresolved: true });
    return Object.assign({}, c, { landingUrl: G.monetise(url) });
  }

  /* No placeholder does NOT mean the link is monetised. Coupons written to
     data/coupons.json by scripts/sync-offers.js and scripts/fetch-cj.js carry
     the provider's raw landing URL, which is a bare merchant link. Those went
     out uncommissioned: page.js renders c.landingUrl in preference to
     store.url, so a single provider offer silently bypassed the wrapper.
     monetise() is idempotent — already-wrapped links (Sovrn deeplinks, or a
     CJ tracking URL we should not touch) are returned unchanged. */
  return Object.assign({}, c, { landingUrl: G.monetise(c.landingUrl) });
}

/* ============================================================
   REMOTE FEED  (env: DEALS_FEED_URL)
   ============================================================ */

/* Feed shapes we understand when DEALS_FEED_URL responds:
     [ … ]                                   raw array
     { coupons:[…] } { deals:[…] } { offers:[…] } { items:[…] } { data:[…] } */
const FEED_ARRAY_KEYS = ['coupons', 'deals', 'offers', 'items', 'data', 'results'];
const FEED_TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS) || 4000;
const FEED_MAX_ITEMS  = Number(process.env.FEED_MAX_ITEMS)  || 300;

async function fetchRemoteFeed() {
  const url = (process.env.DEALS_FEED_URL || '').trim();
  if (!url) return { items: null, status: 'disabled' };

  const started = Date.now();
  const headers = { accept: 'application/json' };
  const token = (process.env.FEED_TOKEN || '').trim();
  if (token) headers.authorization = 'Bearer ' + token;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timer);

    if (!res.ok) return { items: null, status: 'error: HTTP ' + res.status, durationMs: Date.now() - started };

    const body = await res.json();
    let items = Array.isArray(body) ? body : null;
    if (!items && body && typeof body === 'object') {
      const key = FEED_ARRAY_KEYS.find(k => Array.isArray(body[k]));
      if (key) items = body[key];
    }
    if (!Array.isArray(items)) return { items: null, status: 'error: unsupported payload shape', durationMs: Date.now() - started };

    const capped = items.slice(0, FEED_MAX_ITEMS);
    return {
      items: capped,
      status: 'ok',
      durationMs: Date.now() - started,
      fetched: items.length,
      truncated: items.length > capped.length
    };
  } catch (err) {
    const name = (err && err.name) || '';
    return {
      items: null,
      status: name === 'AbortError' ? 'error: timeout after ' + FEED_TIMEOUT_MS + 'ms' : 'error: ' + (err && err.message),
      durationMs: Date.now() - started
    };
  }
}

/* ---------- field aliases: every network names these differently ---------- */
function firstString(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object' && (v.name || v.title)) return String(v.name || v.title).trim();
  }
  return '';
}
function slugify(value) {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'store';
}
function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

/* ---------- seamless categorisation ---------- */
const CATEGORY_KEYWORDS = {
  tech:     ['laptop','phone','mobile','tablet','ipad','iphone','android','gadget','electronic','tv','television','camera','headphone','earbud','airpod','smartwatch','monitor','charger','router','ssd','hard drive','processor','graphics card','macbook','smart home','appliance','drone'],
  fashion:  ['fashion','clothing','clothes','dress','shirt','sneaker','shoe','apparel','bag','handbag','jewellery','jewelry','watch','perfume','fragrance','beauty','makeup','skincare','abaya','hijab','outfit','denim','boot','sunglass'],
  travel:   ['travel','flight','airline','hotel','booking','airbnb','car rental','holiday','vacation','resort','cruise','luggage','tour','visa','trip','stay'],
  gaming:   ['game','gaming','xbox','playstation','ps5','ps4','nintendo','steam','epic games','console','controller','razer','esports','battle pass','xbox game pass','gpu','graphics card'],
  software: ['software','vpn','subscription','saas','hosting','domain','antivirus','office 365','adobe','cloud','license','productivity','course','app','tool','membership']
};

/* Networks classify by merchant vertical as often as by copy — these brand
   hints decide the lane when the wording itself carries no keyword. */
const MERCHANT_HINTS = {
  gaming:   ['ubisoft','steam','ea ','electronic arts','activision','blizzard','riot','epic games','playstation','xbox','nintendo','gog','humble','razer','logitech g','gamepass','g2a','kinguin','discord'],
  software: ['nordvpn','expressvpn','surfshark','cyberghost','adobe','microsoft','notion','figma','canva','hostinger','namecheap','godaddy','bluehost','siteground','avast','kaspersky','mcafee','norton','grammarly','skillshare','udemy','coursera','masterclass','dropbox','lastpass','dashlane','shopify','hubspot','zoom','slack'],
  travel:   ['booking','expedia','airbnb','agoda','trip.com','trivago','emirates','qatar airways','etihad','ryanair','lufthansa','turkish airlines','flydubai','hilton','marriott','accor','ibis','hotels.com','kayak','skyscanner','cleartrip','almosafer','wego','rentalcars','avis','hertz','careem','uber'],
  fashion:  ['zara','h&m','asos','farfetch','ounass','namshi','shein','noon fashion','adidas','nike','puma','reebok','vans','converse','levi','gap','uniqlo','mango','bershka','pull&bear','massimo dutti','foot locker','sun & sand sports','debenhams','marks & spencer','hermes','gucci','prada','dior','chanel','cartier','swarovski','sephora','ulta','nyx','mac cosmetics','the body shop','bath & body works','oysho','lululemon','under armour','new balance','skechers','clarks','aldo','nine west','charles & keith','max fashion','splash','centrepoint','home centre','crate & barrel','pottery barn','west elm','ikea'],
  tech:     ['amazon','aliexpress','noon','best buy','mediamarkt','currys','apple','dell','samsung','hp ','lenovo','asus','acer','lg ','sony','bose','jbl','anker','belkin','logitech','tp-link','netgear','western digital','seagate','crucial','intel','amd','nvidia','xiaomi','realme','oneplus','oppo','vivo','honor','huawei','jarir','extra','sharaf dg','virgin megastore','carrefour','lulu','danube','talabat','instashop']
};

/* Score the text against each vertical; fall back to the brand's own lane. */
function merchantHint(text, categories) {
  const hay = String(text || '').toLowerCase();
  const ids = categories.map(c => c.id);
  for (let i = 0; i < ids.length; i++) {
    const brands = MERCHANT_HINTS[ids[i]];
    if (!brands) continue;
    for (let b = 0; b < brands.length; b++) {
      if (hay.indexOf(brands[b]) !== -1) return { id: ids[i], score: 1, how: 'merchant' };
    }
  }
  return null;
}
function inferCategory(text, categories, storeHints) {
  const hay = String(text || '').toLowerCase();
  const ids = categories.map(c => c.id);
  let best = null, bestScore = 0;
  ids.forEach(id => {
    const words = CATEGORY_KEYWORDS[id];
    if (!words) return;
    let score = 0;
    words.forEach(w => { if (hay.indexOf(w) !== -1) score += w.split(' ').length; });
    if (score > bestScore) { bestScore = score; best = id; }
  });
  if (best) return { id: best, score: bestScore, how: 'keyword' };
  const hint = merchantHint(text, categories);
  if (hint) return hint;
  if (storeHints && storeHints.id && ids.indexOf(storeHints.id) !== -1) return { id: storeHints.id, score: 0, how: 'store' };
  return { id: ids[0] || 'tech', score: 0, how: 'default' };
}

/* Deterministic brand colour so feed-only stores still look intentional. */
function hashColor(seed) {
  let h = 0;
  const str = String(seed || 'nipcoupon');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return hslToHex(h, 62, 45);
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
  const to = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}

/* ---------- map one raw feed record onto our coupon shape ---------- */
function mapFeedItem(raw, index, ctx) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' };

  const storeName = firstString(raw, [
    'storeName', 'store', 'store_name', 'merchant', 'merchantName', 'merchant_name',
    'brand', 'brandName', 'brand_name', 'advertiser', 'advertiserName', 'advertiser_name',
    'program', 'programName', 'retailer', 'seller', 'shop', 'vendor'
  ]);
  const storeIdIn = firstString(raw, ['storeId', 'store_id', 'merchantId', 'merchant_id', 'advertiserId', 'brandId', 'programId']);
  const link      = firstString(raw, ['landingUrl', 'url', 'link', 'deeplink', 'trackingUrl', 'clickUrl', 'affiliateUrl']);
  const title     = firstString(raw, ['title', 'name', 'headline', 'description', 'offer', 'offerName', 'label', 'text']);
  const code      = firstString(raw, ['code', 'couponCode', 'promoCode', 'voucherCode', 'promocode']);
  const categoryIn= firstString(raw, ['category', 'categoryName', 'vertical', 'cat', 'department']);
  const badge     = firstString(raw, ['badge', 'discount', 'offerText', 'value']);
  const rawValue  = raw.discountValue !== undefined ? raw.discountValue : (raw.percent !== undefined ? raw.percent : raw.value);

  const storeId = storeIdIn ? slugify(storeIdIn) : (storeName ? slugify(storeName) : '');
  if (!storeId) return { ok: false, reason: 'no-store' };
  if (!title && !code) return { ok: false, reason: 'no-title' };

  // resolve (or register) the brand
  let store = ctx.storeById[storeId] || (storeName ? ctx.storeByName[storeName.toLowerCase()] : null);
  let storeAdded = false;
  if (!store) {
    store = {
      id: storeId,
      name: storeName || storeId,
      abbr: (storeName || storeId).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'NP',
      color: hashColor(storeId),
      fg: '#ffffff',
      url: link || '',
      affiliateTag: firstString(raw, ['affiliateTag', 'subid', 'sid', 'affiliate_tag']) || '',
      regions: ['GLOBAL'],
      fromFeed: true
    };
    ctx.storeById[storeId] = store;
    ctx.storeByName[store.name.toLowerCase()] = store;
    ctx.stores.push(store);            // ← so it appears in the store grid too
    ctx.storesAdded.push(store.id);
    storeAdded = true;
  }

  // categorise: explicit id → explicit name → keyword inference → brand's lane
  let categoryId = '';
  let categoryHow = 'explicit';
  const catIds = ctx.categories.map(c => c.id);
  const byId = catIds.indexOf(slugify(categoryIn));
  if (categoryIn && byId !== -1) categoryId = catIds[byId];
  else {
    const byName = ctx.categories.filter(c => c.name.toLowerCase() === String(categoryIn).toLowerCase())[0];
    if (byName) categoryId = byName.id;
    else {
      const hint = ctx.categoryByStore[store.id];
      const inf = inferCategory([title, categoryIn, store.name, badge].join(' '), ctx.categories, hint);
      categoryId = inf.id; categoryHow = inf.how;
      if (inf.how === 'keyword') ctx.categorised++;
    }
  }

  const expires = firstString(raw, ['expires', 'expiresAt', 'endDate', 'validUntil', 'expiry', 'expiryDate']).slice(0, 10);
  if (expires && !Number.isNaN(Date.parse(expires)) && Date.parse(expires + 'T23:59:59') < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  let value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    const m = String(badge || title).match(/(\d{1,3})\s*%/);
    value = m ? Number(m[1]) : 0;
  }

  let regions = Array.isArray(raw.regions) && raw.regions.length
    ? raw.regions.map(r => String(r).toUpperCase())
    : (firstString(raw, ['country', 'countries', 'region', 'geo']) || 'GLOBAL')
        .split(/[,|\/]/).map(x => x.trim().toUpperCase()).filter(Boolean);
  const known = ctx.regionCodes;
  regions = regions.filter(r => !known.length || known.indexOf(r) !== -1);
  if (!regions.length) regions = ['GLOBAL'];

  const coupon = normalizeCoupon({
    id: String(firstString(raw, ['id', 'couponId', 'offerId', 'uid']) || ('feed-' + (index + 1))),
    storeId: store.id,
    categoryId,
    type: (raw.type && String(raw.type).toLowerCase().indexOf('deal') !== -1) || (!code && !truthy(raw.isCode)) ? 'deal' : 'code',
    code,
    badge: badge || (value ? value + '% OFF' : 'DEAL'),
    value,
    title: title || code + ' at ' + store.name,
    verifiedHoursAgo: Number(raw.verifiedHoursAgo || 0) || 0,
    expires,
    uses: Number(raw.uses || raw.clicks || 0) || 0,
    rating: Number(raw.rating || 0) || 0,
    addedDaysAgo: Number(raw.addedDaysAgo || 0) || 0,
    hot: truthy(raw.hot) || truthy(raw.featured),
    terms: Array.isArray(raw.terms) ? raw.terms.map(String) : (raw.terms ? [String(raw.terms)] : []),
    /* Feed links arrive as bare merchant URLs. Wrapping them here is the only
       thing standing between a remote deal and an uncommissioned click:
       store.url is already wrapped, but `link` comes straight from the feed.
       monetise() is a no-op on an already-wrapped URL, so double-wrapping
       cannot happen, and it returns the input unchanged when no key is set. */
    landingUrl: link ? G.monetise(link) : (store.url || ''),
    regions,
    source: 'feed'
  }, index);

  if (!coupon.landingUrl && !store.url) return { ok: false, reason: 'no-link' };

  return { ok: true, coupon, storeAdded, categoryHow };
}

/* Build the lookup context the mapper needs (brands by id/name, region codes…). */
function makeFeedContext(baseStores, categories, regions, localCoupons) {
  const ctx = {
    stores: baseStores.slice(),
    storeById: {}, storeByName: {}, categoryByStore: {},
    categories,
    regionCodes: (regions || []).map(r => String(r.code || '').toUpperCase()),
    storesAdded: [], categorised: 0
  };
  baseStores.forEach(s => {
    ctx.storeById[s.id] = s;
    ctx.storeByName[String(s.name).toLowerCase()] = s;
  });
  // which vertical does each brand already live in? used as a categorisation hint
  (localCoupons || []).forEach(c => {
    if (!ctx.categoryByStore[c.storeId]) ctx.categoryByStore[c.storeId] = { id: c.categoryId };
  });
  return ctx;
}

/* ---------- merge: dedupe by id, then by store+code ---------- */
function mergeFeed(localCoupons, feedItems, ctx) {
  const stats = { fetched: feedItems.length, merged: 0, skipped: {}, storesAdded: 0, categorised: 0 };
  const skip = reason => { stats.skipped[reason] = (stats.skipped[reason] || 0) + 1; };

  const seenIds = new Set(localCoupons.map(c => c.id));
  const seenPairs = new Set(localCoupons.map(c => c.storeId + '::' + (c.code || '').toLowerCase()));
  const out = [];

  feedItems.forEach((raw, i) => {
    const res = mapFeedItem(raw, i, ctx);
    if (!res.ok) return skip(res.reason);
    const c = res.coupon;
    const pair = c.storeId + '::' + (c.code || '').toLowerCase();
    if (seenIds.has(c.id)) return skip('duplicate-id');
    if (c.code && seenPairs.has(pair)) return skip('duplicate-code');
    seenIds.add(c.id); seenPairs.add(pair);
    out.push(c);
  });

  stats.merged = out.length;
  stats.storesAdded = ctx.storesAdded.length;
  stats.categorised = ctx.categorised;
  return { coupons: localCoupons.concat(out), stats };
}

async function loadCatalog(force) {
  const now = Date.now();
  if (!force && cache && now - cacheStamp < CACHE_TTL_MS) return cache;

  const config = readJSON('config.json');
  const baseStores = readJSON('stores.json').stores || [];
  const categories = readJSON('categories.json').categories || [];
  const regions = readJSON('regions.json').regions || [];
  const localCoupons = (readJSON('coupons.json').coupons || []).map(normalizeCoupon);

  const feed = await fetchRemoteFeed();
  let coupons = localCoupons;
  let stores = baseStores;
  let feedStats = { fetched: 0, merged: 0, skipped: {}, storesAdded: 0, categorised: 0 };
  let feedNote = '';

  if (feed.items && feed.items.length) {
    const ctx = makeFeedContext(baseStores, categories, regions, localCoupons);
    const merged = mergeFeed(localCoupons, feed.items, ctx);
    coupons = merged.coupons;
    stores = ctx.stores;
    feedStats = merged.stats;
    lastGoodFeed = { items: feed.items, at: now };
  } else if ((feed.status || '').indexOf('error') === 0 && lastGoodFeed && now - lastGoodFeed.at < STALE_FEED_MS) {
    // transient feed outage: keep serving the last good pull instead of vanishing
    const ctx = makeFeedContext(baseStores, categories, regions, localCoupons);
    const merged = mergeFeed(localCoupons, lastGoodFeed.items, ctx);
    coupons = merged.coupons;
    stores = ctx.stores;
    feedStats = merged.stats;
    feedNote = 'serving feed snapshot from ' + Math.round((now - lastGoodFeed.at) / 1000) + 's ago';
  }

  const storeCounts = {};
  const categoryCounts = {};
  coupons.forEach(c => {
    storeCounts[c.storeId] = (storeCounts[c.storeId] || 0) + 1;
    categoryCounts[c.categoryId] = (categoryCounts[c.categoryId] || 0) + 1;
  });

  cache = {
    config,
    regions,
    stores: stores.map(resolveStore).map(s => Object.assign({}, s, { dealCount: storeCounts[s.id] || 0 })),
    categories: categories.map(c => Object.assign({}, c, { dealCount: categoryCounts[c.id] || 0 })),
    coupons: coupons.map(resolveCoupon),
    meta: {
      generatedAt: new Date().toISOString(),
      totals: { stores: stores.length, categories: categories.length, coupons: coupons.length },
      feed: {
        status: feed.status,
        note: feedNote || undefined,
        durationMs: feed.durationMs,
        fetched: feedStats.fetched,
        merged: feedStats.merged,
        skipped: feedStats.skipped,
        storesAdded: feedStats.storesAdded,
        autoCategorised: feedStats.categorised,
        truncated: !!feed.truncated
      }
    }
  };
  cacheStamp = now;
  return cache;
}

const SORTERS = {
  popular: (a, b) => b.uses - a.uses,
  discount: (a, b) => b.value - a.value,
  expiring: (a, b) => new Date(a.expires) - new Date(b.expires),
  newest: (a, b) => a.addedDaysAgo - b.addedDaysAgo,
  rating: (a, b) => b.rating - a.rating || b.uses - a.uses
};

/**
 * Geo-targeting: a deal is visible when its `regions` array contains either the
 * shopper's selected region or "GLOBAL".
 *
 *   region=QA      → deals tagged QA **or** GLOBAL
 *   region=GLOBAL  → worldwide deals only
 *   region=ALL|*   (or omitted) → no region filtering at all
 *
 * The storefront asks for "ALL" and filters client-side, so switching country
 * re-renders instantly without another round-trip.
 */
function inRegion(item, region) {
  const r = item.regions || [];
  if (!region || region === 'ALL' || region === '*') return true;
  if (region === 'GLOBAL') return r.indexOf('GLOBAL') !== -1;
  return r.indexOf(region) !== -1 || r.indexOf('GLOBAL') !== -1;
}

function matches(coupon, query, storeNameById) {
  if (!query) return true;
  const hay = [
    coupon.title, coupon.code, coupon.badge, coupon.categoryId,
    storeNameById[coupon.storeId] || coupon.storeId
  ].join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => hay.indexOf(word) !== -1);
}

/** Filter + sort + page the catalogue (same semantics as the front-end). */
function queryDeals(catalog, options) {
  const opts = options || {};
  const storeNameById = {};
  catalog.stores.forEach(s => { storeNameById[s.id] = s.name; });

  let list = catalog.coupons.filter(c => {
    if (!inRegion(c, opts.region)) return false;
    if (opts.category && opts.category !== 'all' && c.categoryId !== opts.category) return false;
    if (opts.store && c.storeId !== opts.store) return false;
    if (opts.type && opts.type !== 'all' && c.type !== opts.type) return false;
    if (opts.hot && !c.hot) return false;
    return matches(c, opts.q, storeNameById);
  });

  list.sort(SORTERS[opts.sort] || SORTERS.popular);

  const limit = Math.min(100, Math.max(1, Number(opts.limit) || catalog.coupons.length));
  const page = Math.max(1, Number(opts.page) || 1);
  const total = list.length;
  const items = list.slice((page - 1) * limit, page * limit);

  return { items, page, limit, total, returned: items.length, hasMore: page * limit < total };
}

function storesForRegion(catalog, region) {
  const counts = {};
  catalog.coupons
    .filter(c => inRegion(c, region))
    .forEach(c => { counts[c.storeId] = (counts[c.storeId] || 0) + 1; });

  return catalog.stores
    .filter(s => inRegion(s, region))
    .map(s => Object.assign({}, s, { dealCount: counts[s.id] || 0 }))
    .filter(s => s.dealCount > 0)
    .sort((a, b) => b.dealCount - a.dealCount || a.name.localeCompare(b.name));
}

/* How many deals a shopper in each region actually sees (regional + GLOBAL). */
function regionCounts(catalog) {
  const out = {};
  (catalog.regions || []).forEach(r => { out[r.code] = 0; });
  catalog.coupons.forEach(c => {
    Object.keys(out).forEach(code => { if (inRegion(c, code)) out[code] += 1; });
  });
  return out;
}

module.exports = {
  loadCatalog, queryDeals, storesForRegion, regionCounts, inRegion, SORTERS, DATA_DIR,
  // exported mainly for tests / tooling
  fetchRemoteFeed, mergeFeed, mapFeedItem, makeFeedContext, inferCategory, slugify, normalizeCoupon
};
