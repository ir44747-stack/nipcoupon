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
${body}${sovrnScript()}
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
    const title = (c.title || storeName + ' offer') + ' — ' + storeName + ' | NipCoupon';
    const desc = (c.code ? 'Use code ' + c.code + ' — ' : '') +
      (c.title || 'Verified offer') + ' at ' + storeName + '. Verified and updated daily by NipCoupon.';
    const path = '/coupon/' + encodeURIComponent(c.id);
    const canonical = SITE + path;

    const kw = K.generate(catalog, { store: store.id || storeName, limit: 12 }).meta;

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
    ? '<p><a class="btn" rel="nofollow sponsored noopener" target="_blank" href="' + esc(target) + '">Get this deal at ' + esc(storeName) + '</a></p>'
    : '<p class="meta">This deal is temporarily unavailable.</p>'}
  ${geoNote}
  ${c.terms && c.terms.length ? '<div class="terms">Terms: ' + esc(c.terms.join(' · ')) + '</div>' : ''}
  <p class="meta" style="margin-top:18px">NipCoupon may earn a commission on qualifying purchases.</p>
</div>`;

    return res.end(page({
      title, description: desc, keywords: kw, canonical, path, lang, body,
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'Offer',
        name: c.title || storeName + ' offer',
        description: desc, url: canonical,
        availability: 'https://schema.org/InStock',
        ...(c.expires ? { priceValidUntil: c.expires } : {}),
        ...(profile.currency ? { priceCurrency: profile.currency } : {}),
        seller: { '@type': 'Organization', name: storeName }
      }
    }));
  }

  /* ── /store/:id ────────────────────────────────────────────────────────── */
  if (type === 'store') {
    const s = stores.find(x => x.id === id);
    if (!s) return notFound(res, 'store');
    const list = coupons.filter(c => c.storeId === s.id);
    const title = s.name + ' promo codes & deals (' + list.length + ') | NipCoupon';
    const desc = list.length
      ? list.length + ' verified ' + s.name + ' promo codes and deals, updated daily. Save at ' + s.name + ' with NipCoupon.'
      : 'Browse the latest ' + s.name + ' offers on NipCoupon.';
    const path = '/store/' + encodeURIComponent(s.id);
    const canonical = SITE + path;
    const kw = K.generate(catalog, { store: s.id, limit: 12 }).meta;

    const body = `
<div class="card">
  <span class="badge">${list.length} deal${list.length === 1 ? '' : 's'}</span>
  <h1>${esc(s.name)} promo codes &amp; deals</h1>
  <p>${esc(desc)}</p>
</div>
${list.map(c => `<div class="card">
  <span class="badge">${esc(c.badge || (c.type === 'code' ? 'CODE' : 'DEAL'))}</span>
  <h2 style="margin:8px 0"><a href="/coupon/${encodeURIComponent(c.id)}">${esc(c.title)}</a></h2>
  ${c.code ? '<div class="code">' + esc(c.code) + '</div>' : ''}
  <p class="meta">${c.expires ? 'expires ' + esc(c.expires) : 'no end date'}</p>
</div>`).join('\n')}`;

    // A store page with no deals is thin content — keep it out of the index.
    return res.end(page({ title, description: desc, keywords: kw, canonical, path, lang, body, robots: list.length ? 'index,follow' : 'noindex,follow' }));
  }

  /* ── /category/:id ─────────────────────────────────────────────────────── */
  if (type === 'category') {
    const cat = categories.find(x => x.id === id);
    if (!cat) return notFound(res, 'category');
    const list = coupons.filter(c => c.categoryId === cat.id);
    const title = (cat.name || id) + ' promo codes & deals (' + list.length + ') | NipCoupon';
    const desc = list.length + ' verified ' + (cat.name || id) + ' promo codes and deals, updated daily on NipCoupon.';
    const path = '/category/' + encodeURIComponent(cat.id);
    const canonical = SITE + path;
    const kw = K.generate(catalog, { category: cat.id, limit: 12 }).meta;

    const body = `
<div class="card">
  <span class="badge">${list.length} deal${list.length === 1 ? '' : 's'}</span>
  <h1>${esc(cat.name || id)} promo codes &amp; deals</h1>
  <p>${esc(desc)}</p>
</div>
${list.map(c => {
  const st = stores.find(s => s.id === c.storeId) || {};
  return `<div class="card">
  <span class="badge">${esc(c.badge || 'DEAL')}</span>
  <h2 style="margin:8px 0"><a href="/coupon/${encodeURIComponent(c.id)}">${esc(st.name || c.storeName || 'Store')} — ${esc(c.title)}</a></h2>
  ${c.code ? '<div class="code">' + esc(c.code) + '</div>' : ''}
</div>`;
}).join('\n')}`;

    return res.end(page({ title, description: desc, keywords: kw, canonical, path, lang, body, robots: list.length ? 'index,follow' : 'noindex,follow' }));
  }

  return notFound(res, 'page');
};
