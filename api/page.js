/**
 * GET /api/page — server-rendered landing pages for programmatic SEO.
 *
 * Served publicly via vercel.json rewrites:
 *   /coupon/:id      → /api/page?type=coupon&id=:id
 *   /store/:id       → /api/page?type=store&id=:id
 *   /category/:id    → /api/page?type=category&id=:id
 *
 *   GET /api/page?type=coupon&id=amazon-save20
 *   GET /api/page?type=store&id=amazon
 *   GET /api/page?type=category&id=tech
 *
 * Why server-rendered and not just another client route:
 *   The canonical URLs we hand to Google (/coupon/<id>) must return real HTML —
 *   title, meta description, keywords, canonical, Open Graph, hreflang, JSON-LD
 *   — without executing JavaScript. A crawler that hits a JS-only shell indexes
 *   an empty page.
 *
 * What this file adds on top of a plain template:
 *   • dynamic keywords  — the rotated long-tail set from api/_keywords.js,
 *     written server-side so the crawler sees them
 *   • hreflang          — en / ar / x-default alternates for every URL
 *   • geo-localisation  — the "Get this deal" button points at the visitor's
 *     own storefront (amazon.ae in the Gulf, amazon.com in the US), resolved
 *     from the edge header with the original URL as the fallback
 *   • Sovrn Commerce    — the tracking loader is injected before </body> so a
 *     crawler-rendered page is monetised too, not just the SPA
 *
 * Security: this endpoint only ever emits data that is already public. Store
 * URLs are resolved through api/_secrets.js, so a ${…} placeholder is expanded
 * here (server-side) and a missing env var degrades to originalUrl.
 */
'use strict';

const D = require('./_data.js');
const S = require('./_secrets.js');
const K = require('./_keywords.js');
const G = require('./_geo.js');

const SITE = (S.env('SITE_URL', 'https://nipcoupon.vercel.app').trim() || 'https://nipcoupon.vercel.app').replace(/\/+$/, '');
const LOCALES = ['en', 'ar'];   // must match locales/*.json
const DEFAULT_LOCALE = 'en';
/* Google Analytics 4 measurement ID. Public by design (it ships in the HTML),
   but env-overridable so staging can point at a different property. */
const GA_ID = (S.env('GA_MEASUREMENT_ID', 'G-MSF77ECT4G').trim() || 'G-MSF77ECT4G');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The Sovrn Commerce loader, inlined.
 * Identical in intent to GET /api/sovrn.js but rendered here so the crawler's
 * copy of the page carries it too. Emits nothing when the key is unset.
 */
function sovrnScript() {
  const key = S.env('SOVRN_API_KEY').trim();
  if (!key) {
    return '\n<!-- Sovrn Commerce disabled: SOVRN_API_KEY is not set. -->';
  }
  const cuid = S.env('SOVRN_CUID', 'nipcoupon').trim();
  return '\n<script>' +
    'window.vglnk=window.vglnk||{};' +
    'window.vglnk.key=' + JSON.stringify(key) + ';' +
    (cuid ? 'window.vglnk.cuid=' + JSON.stringify(cuid) + ';' : '') +
    '(function(d,t){var s=d.createElement(t);s.type="text/javascript";s.async=true;' +
    's.src="//cdn.viglink.com/api/vglnk.js";' +
    'var r=d.getElementsByTagName(t)[0];if(r&&r.parentNode)r.parentNode.insertBefore(s,r);' +
    '}(document,"script"));' +
    '</script>';
}

/* ── SEO helpers ───────────────────────────────────────────────────────────
 * Long-tail intent metadata. Titles carry the current Month + Year because
 * "<brand> promo codes september 2026" is the query people actually type, and
 * a dated title signals freshness in the SERP.
 *
 * The stamp is derived per request from the server clock, so it rolls over on
 * its own — nothing to schedule and nothing to go stale. Pages are cached with
 * s-maxage=3600, so a month boundary is picked up within the hour.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function monthYear(d) {
  const now = d || new Date();
  return MONTHS[now.getUTCMonth()] + ' ' + now.getUTCFullYear();
}

/* Keep <title> under ~60 chars so Google does not truncate it mid-phrase.
   Measured on the RAW string: esc() later expands & into &amp;, and counting
   the entity would clamp a compliant title for no reason. */
function clampTitle(s, max) {
  const lim = max || 62;
  const str = String(s || '');
  if (str.length <= lim) return str;
  const cut = str.slice(0, lim);
  const sp = cut.lastIndexOf(' ');
  return (sp > 30 ? cut.slice(0, sp) : cut).replace(/[\s—·|-]+$/, '') + '…';
}

/* Meta descriptions: ~155 chars is the desktop snippet limit. */
function clampDesc(s, max) {
  const lim = max || 155;
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (str.length <= lim) return str;
  const cut = str.slice(0, lim);
  const sp = cut.lastIndexOf(' ');
  return (sp > 60 ? cut.slice(0, sp) : cut).replace(/[\s,;]+$/, '') + '…';
}

/* High-purchase-intent modifiers appended to the keyword set. These are the
   transactional long-tail variants that convert, as opposed to informational
   queries. Mirrors the list in scripts/keyword-sync.js. */
const INTENT_MODIFIERS = [
  'discount code', 'promo code', 'voucher code', 'coupon code',
  'active promo code', 'valid voucher', 'working discount code',
  'free shipping code', 'first order discount', 'student discount',
  'sale', 'offers today'
];

/* Merge generated keywords with brand × intent combinations, de-duplicated. */
function intentKeywords(baseCsv, subject, stamp) {
  const out = [];
  const seen = Object.create(null);
  const push = k => {
    const v = String(k || '').trim().toLowerCase();
    if (!v || seen[v]) return;
    seen[v] = 1; out.push(v);
  };
  String(baseCsv || '').split(',').forEach(push);
  if (subject) {
    const n = String(subject).toLowerCase();
    INTENT_MODIFIERS.forEach(m => push(n + ' ' + m));
    if (stamp) push(n + ' promo code ' + stamp.toLowerCase());
  }
  return out.slice(0, 28).join(', ');
}

/* BreadcrumbList — renders the crumb trail in the SERP instead of a raw URL. */
function breadcrumbs(trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      item: t.url
    }))
  };
}

/* WebSite + Organization. Emitted on every route so the knowledge panel and
   sitelinks searchbox have a consistent source regardless of entry page. */
function siteSchema() {
  return [
    {
      '@type': 'WebSite',
      '@id': SITE + '/#website',
      url: SITE + '/',
      name: 'NipCoupon',
      description: 'Verified promo codes, coupons and deals from global brands.',
      inLanguage: LOCALES,
      publisher: { '@id': SITE + '/#organization' }
      /* No SearchAction: the storefront filters client-side and never writes a
         ?q= parameter to the URL, so advertising a sitelinks searchbox would
         point Google at a query string the site does not consume. Add it only
         if search state is ever mirrored into the URL. */
    },
    {
      '@type': 'Organization',
      '@id': SITE + '/#organization',
      name: 'NipCoupon',
      url: SITE + '/',
      logo: { '@type': 'ImageObject', url: SITE + '/assets/logo.png' },
      description: 'Global coupon aggregator — verified promo codes and deals.'
    }
  ];
}

/* Wrap everything in one @graph: a single valid JSON-LD block per page beats
   several competing ones, and lets nodes cross-reference by @id. */
function graph(nodes) {
  return { '@context': 'https://schema.org', '@graph': siteSchema().concat(nodes.filter(Boolean)) };
}

/** hreflang alternates. Query-param locales keep the SPA on one canonical URL. */
function alternates(path) {
  const base = SITE + path;
  const out = LOCALES.map(l =>
    '<link rel="alternate" hreflang="' + l + '" href="' + esc(base + (path.indexOf('?') === -1 ? '?' : '&') + 'lang=' + l) + '" />'
  );
  out.push('<link rel="alternate" hreflang="x-default" href="' + esc(base) + '" />');
  return out.join('\n');
}

function page({ title, description, keywords, canonical, path, body, jsonLd, ogImage, robots, lang }) {
  const ld = jsonLd ? '\n<script type="application/ld+json">' + JSON.stringify(jsonLd) + '</script>' : '';
  const kw = keywords ? '\n<meta name="keywords" content="' + esc(keywords) + '">' : '';
  return `<!doctype html>
<html lang="${esc(lang || DEFAULT_LOCALE)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">${kw}
<link rel="canonical" href="${esc(canonical)}">
${alternates(path || '/')}
<meta property="og:type" content="website">
<meta property="og:site_name" content="NipCoupon">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:locale" content="${esc((lang || DEFAULT_LOCALE) === 'ar' ? 'ar_AE' : 'en_US')}">
${ogImage ? '<meta property="og:image" content="' + esc(ogImage) + '">' : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="robots" content="${esc(robots || 'index,follow')}">
<link rel="preconnect" href="https://cdn.viglink.com" crossorigin>
<link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
window.dataLayer=window.dataLayer||[];
window.gtag=function gtag(){window.dataLayer.push(arguments);};
window.gtag('js',new Date());window.gtag('config','${GA_ID}');
</script>
<style>
  body{max-width:820px;margin:0 auto;padding:48px 20px;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#090d16;color:#e2e8f0}
  a{color:#10b981}
  .card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:24px;margin:20px 0}
  .code{display:inline-block;background:#0f172a;border:1px dashed #10b981;color:#10b981;padding:10px 18px;border-radius:8px;font-weight:800;letter-spacing:.08em;font-size:20px;margin:12px 0}
  .btn{display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:#03231b;font-weight:800;padding:14px 26px;border-radius:10px;text-decoration:none}
  .meta{color:#94a3b8;font-size:14px}
  .badge{display:inline-block;background:rgba(16,185,129,.15);color:#34d399;padding:4px 12px;border-radius:999px;font-weight:700;font-size:13px}
  .terms{color:#94a3b8;font-size:13px;margin-top:12px}
</style>${ld}
</head>
<body>
<p class="meta"><a href="/">← NipCoupon</a></p>
${body}
<script>
/* GA4 outbound-click attribution for the server-rendered pages. Delegated so
   it costs one listener regardless of how many links the page carries. */
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a[data-ga-store]') : null;
  if (!a || typeof window.gtag !== 'function') return;
  var url = a.getAttribute('href') || '', domain = '';
  /* Unwrap the Sovrn wrapper so store_domain is the merchant, not sovrn.co. */
  try {
    var u = new URL(url, location.href);
    if (/(^|\\.)sovrn\\.co$/i.test(u.hostname)) {
      var inner = u.searchParams.get('u');
      if (inner) { try { u = new URL(inner); } catch (e2) {} }
    }
    domain = u.hostname.replace(/^www\\./, '');
  } catch (err) {}
  var code = a.getAttribute('data-ga-code') || '';
  var params = {
    store_name: a.getAttribute('data-ga-store') || '',
    store_domain: domain,
    coupon_id: a.getAttribute('data-ga-coupon') || '',
    coupon_code: code,
    has_code: !!code,
    affiliate_network: /sovrn\\.co|viglink/i.test(url) ? 'sovrn' : 'direct',
    page_type: 'ssr',
    link_url: url,
    outbound: true
  };
  window.gtag('event', 'click_affiliate', params);
  window.gtag('event', 'select_content', {
    content_type: 'affiliate_link',
    item_id: params.coupon_id || params.store_name,
    store_name: params.store_name,
    store_domain: domain
  });
});
</script>${sovrnScript()}
</body>
</html>`;
}

function notFound(res, what) {
  // Use res.status() (not res.statusCode =) so the code propagates through both
  // Vercel's response object and the local preview adapter.
  if (typeof res.status === 'function') res.status(404); else res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  res.end(page({
    title: 'Not found — NipCoupon',
    description: 'That page does not exist.',
    canonical: SITE + '/',
    path: '/',
    body: '<h1>Not found</h1><p>We could not find that ' + esc(what) + '.</p><p><a class="btn" href="/">Browse all deals</a></p>'
  }));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  const q = (req && req.query) || {};
  const type = String(q.type || 'coupon').toLowerCase();
  const id = String(q.id || '').trim();

  let catalog;
  try {
    catalog = await D.loadCatalog();
  } catch (err) {
    if (typeof res.status === 'function') res.status(500); else res.statusCode = 500;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(page({
      title: 'NipCoupon', description: 'Deals are temporarily unavailable.',
      canonical: SITE + '/', path: '/',
      body: '<h1>Temporarily unavailable</h1><p>We could not load deals just now. Please try again shortly.</p>'
    }));
  }

  const stores = catalog.stores || [];
  const coupons = catalog.coupons || [];
  const categories = catalog.categories || [];

  /* ── Geo: which storefront should the button point at? ───────────────────
   * The edge middleware has already resolved this; we only honour it. A
   * crawler sending no header simply gets the global storefront, which is
   * what should be indexed anyway. */
  const regionCode = G.countryFromHeaders(req.headers, q) || G.FALLBACK;
  const region = G.resolveRegion(regionCode, (catalog.regions || []).map(r => r.code));
  const profile = region.profile;

  const lang = LOCALES.indexOf(String(q.lang || '').toLowerCase()) !== -1
    ? String(q.lang).toLowerCase()
    : (LOCALES.indexOf(profile.lang) !== -1 ? profile.lang : DEFAULT_LOCALE);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
  /* The HTML varies by market, so a shared cache must not serve one country's
     links to another. */
  res.setHeader('Vary', 'x-nc-country, Accept-Language');

  /* ── /coupon/:id ───────────────────────────────────────────────────────── */
  if (type === 'coupon') {
    const c = coupons.find(x => x.id === id);
    if (!c) return notFound(res, 'coupon');

    const store = stores.find(s => s.id === c.storeId) || {};
    const storeName = store.name || c.storeName || 'Store';
    const stamp = monthYear();
    const title = clampTitle((c.code ? storeName + ' Code: ' : storeName + ': ') +
      (c.title || 'Verified Offer') + ' — ' + stamp);
    const desc = clampDesc((c.code ? 'Use code ' + c.code + ' — ' : '') +
      (c.title || 'Verified offer') + ' at ' + storeName + '. Active, tested ' + stamp +
      '. Free to use, updated daily by NipCoupon.');
    const path = '/coupon/' + encodeURIComponent(c.id);
    const canonical = SITE + path;

    const kw = intentKeywords(
      K.generate(catalog, { store: store.id || storeName, limit: 12 }).meta, storeName, stamp);

    // Resolve through the secrets layer, then localise for the visitor's
    // market. Localisation rewrites the URL *inside* the Sovrn wrapper so the
    // commission survives; if anything fails we keep the plain resolved URL.
    const base = S.resolveUrl(c.landingUrl, '') || S.resolveUrl(store.url, store.originalUrl || '');
    const loc = G.localizeUrl(base, region.code);
    const target = loc.url || base;

    const geoNote = loc.changed && profile.label
      ? '<p class="meta">Showing the ' + esc(profile.label) + ' storefront (' + esc(profile.currency) + ').</p>'
      : '';

    const body = `
<div class="card">
  <span class="badge">${esc(c.badge || (c.type === 'code' ? 'CODE' : 'DEAL'))}</span>
  <h1>${esc(c.title || storeName + ' offer')}</h1>
  <p class="meta">${esc(storeName)}${c.expires ? ' · expires ' + esc(c.expires) : ''}${c.linkVerdict ? ' · link ' + esc(c.linkVerdict) : ''}</p>
  ${c.code ? '<div>Coupon code</div><div class="code">' + esc(c.code) + '</div>' : ''}
  ${target
    ? '<p><a class="btn" rel="nofollow sponsored noopener" target="_blank" href="' + esc(target) + '"' +
      ' data-ga-store="' + esc(storeName) + '" data-ga-coupon="' + esc(c.id || '') + '"' +
      ' data-ga-code="' + esc(c.code || '') + '">Get this deal at ' + esc(storeName) + '</a></p>'
    : '<p class="meta">This deal is temporarily unavailable.</p>'}
  ${geoNote}
  ${c.terms && c.terms.length ? '<div class="terms">Terms: ' + esc(c.terms.join(' · ')) + '</div>' : ''}
  <p class="meta" style="margin-top:18px">NipCoupon may earn a commission on qualifying purchases.</p>
</div>
${(function () {
  /* Crawl paths out of the leaf. Without these a /coupon/* page is a dead end:
     Googlebot lands from the sitemap and the only links are outbound affiliate
     URLs marked nofollow, so no PageRank flows back into the site. */
  const out = [];
  if (store.id) {
    out.push('<a href="/store/' + encodeURIComponent(store.id) + '">All ' + esc(storeName) + ' codes</a>');
  }
  const cat = categories.find(x => x.id === c.categoryId);
  if (cat) {
    out.push('<a href="/category/' + encodeURIComponent(cat.id) + '">' + esc(cat.name || cat.id) + ' deals</a>');
  }
  const related = coupons
    .filter(x => x.id !== c.id && (x.storeId === c.storeId || x.categoryId === c.categoryId))
    .slice(0, 6)
    .map(x => '<a href="/coupon/' + encodeURIComponent(x.id) + '">' + esc(x.title || 'Offer') + '</a>');
  return '<div class="card"><p class="meta">' + out.join(' · ') + '</p>' +
    (related.length ? '<p class="meta">Related: ' + related.join(' · ') + '</p>' : '') +
    '</div>';
})()}`;

    /* An expired offer is dead content: the code no longer works, so the page
       cannot satisfy the query that lands on it. Keep it reachable (follow, so
       the links to the store and related offers still pass value) but out of
       the index. build-sitemap.js already drops expired coupons; this covers
       crawlers that arrive from an old SERP entry or an external link. */
    const expired = (function () {
      if (!c.expires) return false;
      const t = Date.parse(c.expires);
      return !Number.isNaN(t) && t < Date.now();
    })();

    return res.end(page({
      title, description: desc, keywords: kw, canonical, path, lang, body,
      robots: expired ? 'noindex,follow' : 'index,follow',
      jsonLd: graph([
        {
          '@type': 'Offer',
          '@id': canonical + '#offer',
          name: c.title || storeName + ' offer',
          description: desc,
          url: canonical,
          availability: expired
            ? 'https://schema.org/Discontinued'
            : 'https://schema.org/InStock',
          ...(c.code ? { category: 'Coupon', identifier: c.code } : {}),
          ...(c.expires ? { priceValidUntil: c.expires, validThrough: c.expires } : {}),
          ...(profile.currency ? { priceCurrency: profile.currency } : {}),
          seller: { '@type': 'Organization', name: storeName },
          isPartOf: { '@id': SITE + '/#website' }
        },
        breadcrumbs([
          { name: 'Home', url: SITE + '/' },
          { name: storeName, url: SITE + '/store/' + encodeURIComponent(store.id || '') },
          { name: c.title || 'Offer', url: canonical }
        ])
      ])
    }));
  }

  /* ── /store/:id ────────────────────────────────────────────────────────── */
  if (type === 'store') {
    const s = stores.find(x => x.id === id);
    if (!s) return notFound(res, 'store');
    const list = coupons.filter(c => c.storeId === s.id);
    const stamp = monthYear();
    const title = clampTitle(s.name + ' Discount Codes & Promo Codes — ' + stamp);
    const desc = clampDesc(list.length
      ? (list.length === 1
          ? '1 verified ' + s.name + ' discount code for ' + stamp + '.'
          : list.length + ' verified ' + s.name + ' discount codes, promo codes and voucher codes for ' + stamp + '.') +
        ' Tested daily — free to use at ' + s.name + '.'
      : 'Latest ' + s.name + ' discount codes and offers for ' + stamp + ' on NipCoupon.');
    const path = '/store/' + encodeURIComponent(s.id);
    const canonical = SITE + path;
    const kw = intentKeywords(K.generate(catalog, { store: s.id, limit: 12 }).meta, s.name, stamp);

    /* Internal linking: the categories this store's deals belong to, plus a
       few sibling stores. Without these, /store/* pages are crawl dead-ends —
       Googlebot arrives from the sitemap and finds only outbound links. */
    const catIds = [];
    list.forEach(c => { if (c.categoryId && catIds.indexOf(c.categoryId) === -1) catIds.push(c.categoryId); });
    const catLinks = catIds
      .map(cid => categories.find(x => x.id === cid))
      .filter(Boolean)
      .map(cat => '<a href="/category/' + encodeURIComponent(cat.id) + '">' + esc(cat.name || cat.id) + '</a>')
      .join(' · ');

    const siblings = stores
      .filter(x => x.id !== s.id && coupons.some(c => c.storeId === x.id))
      .slice(0, 8)
      .map(x => '<a href="/store/' + encodeURIComponent(x.id) + '">' + esc(x.name) + '</a>')
      .join(' · ');

    const body = `
<div class="card">
  <span class="badge">${list.length} deal${list.length === 1 ? '' : 's'}</span>
  <h1>${esc(s.name)} discount codes &amp; promo codes — ${esc(stamp)}</h1>
  <p>${esc(desc)}</p>
</div>
${list.map(c => `<div class="card">
  <span class="badge">${esc(c.badge || (c.type === 'code' ? 'CODE' : 'DEAL'))}</span>
  <h2 style="margin:8px 0"><a href="/coupon/${encodeURIComponent(c.id)}">${esc(c.title)}</a></h2>
  ${c.code ? '<div class="code">' + esc(c.code) + '</div>' : ''}
  <p class="meta">${c.expires ? 'expires ' + esc(c.expires) : 'no end date'}</p>
</div>`).join('\n')}
${catLinks ? '<div class="card"><p class="meta">Browse categories: ' + catLinks + '</p></div>' : ''}
${siblings ? '<div class="card"><p class="meta">More stores: ' + siblings + '</p></div>' : ''}`;

    // A store page with no deals is thin content — keep it out of the index.
    return res.end(page({
      title, description: desc, keywords: kw, canonical, path, lang, body,
      robots: list.length ? 'index,follow' : 'noindex,follow',
      jsonLd: graph([
        {
          '@type': 'CollectionPage',
          '@id': canonical + '#page',
          url: canonical,
          name: title,
          description: desc,
          isPartOf: { '@id': SITE + '/#website' },
          about: { '@type': 'Organization', name: s.name },
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: list.length,
            itemListElement: list.slice(0, 25).map((c, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              url: SITE + '/coupon/' + encodeURIComponent(c.id),
              name: c.title || (s.name + ' offer')
            }))
          }
        },
        breadcrumbs([
          { name: 'Home', url: SITE + '/' },
          { name: s.name, url: canonical }
        ])
      ])
    }));
  }

  /* ── /category/:id ─────────────────────────────────────────────────────── */
  if (type === 'category') {
    const cat = categories.find(x => x.id === id);
    if (!cat) return notFound(res, 'category');
    const list = coupons.filter(c => c.categoryId === cat.id);
    const stamp = monthYear();
    const catName = cat.name || id;
    const title = clampTitle(catName + ' Promo Codes & Deals — ' + stamp);
    const desc = clampDesc((list.length === 1
        ? '1 verified ' + catName + ' promo code for ' + stamp + '.'
        : list.length + ' verified ' + catName +
          ' promo codes, discount codes and voucher codes for ' + stamp + '.') +
      ' Tested daily and free to use on NipCoupon.');
    const path = '/category/' + encodeURIComponent(cat.id);
    const canonical = SITE + path;
    const kw = intentKeywords(K.generate(catalog, { category: cat.id, limit: 12 }).meta, catName, stamp);

    /* Link out to every store represented in this category, and to sibling
       categories — the horizontal crawl paths Googlebot needs. */
    const storeIds = [];
    list.forEach(c => { if (c.storeId && storeIds.indexOf(c.storeId) === -1) storeIds.push(c.storeId); });
    const storeLinks = storeIds
      .map(sid => stores.find(x => x.id === sid))
      .filter(Boolean)
      .map(x => '<a href="/store/' + encodeURIComponent(x.id) + '">' + esc(x.name) + '</a>')
      .join(' · ');

    const otherCats = categories
      .filter(x => x.id !== cat.id && coupons.some(c => c.categoryId === x.id))
      .map(x => '<a href="/category/' + encodeURIComponent(x.id) + '">' + esc(x.name || x.id) + '</a>')
      .join(' · ');

    const body = `
<div class="card">
  <span class="badge">${list.length} deal${list.length === 1 ? '' : 's'}</span>
  <h1>${esc(catName)} promo codes &amp; discount deals — ${esc(stamp)}</h1>
  <p>${esc(desc)}</p>
</div>
${list.map(c => {
  const st = stores.find(s => s.id === c.storeId) || {};
  return `<div class="card">
  <span class="badge">${esc(c.badge || 'DEAL')}</span>
  <h2 style="margin:8px 0"><a href="/coupon/${encodeURIComponent(c.id)}">${esc(st.name || c.storeName || 'Store')} — ${esc(c.title)}</a></h2>
  ${c.code ? '<div class="code">' + esc(c.code) + '</div>' : ''}
</div>`;
}).join('\n')}
${storeLinks ? '<div class="card"><p class="meta">Stores in ' + esc(catName) + ': ' + storeLinks + '</p></div>' : ''}
${otherCats ? '<div class="card"><p class="meta">Other categories: ' + otherCats + '</p></div>' : ''}`;

    return res.end(page({
      title, description: desc, keywords: kw, canonical, path, lang, body,
      robots: list.length ? 'index,follow' : 'noindex,follow',
      jsonLd: graph([
        {
          '@type': 'CollectionPage',
          '@id': canonical + '#page',
          url: canonical,
          name: title,
          description: desc,
          isPartOf: { '@id': SITE + '/#website' },
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: list.length,
            itemListElement: list.slice(0, 25).map((c, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              url: SITE + '/coupon/' + encodeURIComponent(c.id),
              name: c.title || catName + ' offer'
            }))
          }
        },
        breadcrumbs([
          { name: 'Home', url: SITE + '/' },
          { name: catName, url: canonical }
        ])
      ])
    }));
  }

  return notFound(res, 'page');
};
