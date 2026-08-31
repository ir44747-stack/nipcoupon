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
 *   title, meta description, canonical, Open Graph, JSON-LD — without executing
 *   JavaScript. A crawler that hits a JS-only shell indexes an empty page.
 *
 * Security: this endpoint only ever emits data that is already public. Store
 * URLs are resolved through api/_secrets.js, so a ${…} placeholder is expanded
 * here (server-side) and a missing env var degrades to originalUrl.
 */
'use strict';

const D = require('./_data.js');
const S = require('./_secrets.js');

const SITE = (S.env('SITE_URL', 'https://nipcoupon.vercel.app').trim() || 'https://nipcoupon.vercel.app').replace(/\/+$/, '');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page({ title, description, canonical, body, jsonLd, ogImage, robots }) {
  const ld = jsonLd ? '\n<script type="application/ld+json">' + JSON.stringify(jsonLd) + '</script>' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="NipCoupon">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${ogImage ? '<meta property="og:image" content="' + esc(ogImage) + '">' : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="robots" content="${esc(robots || 'index,follow')}">
<link rel="stylesheet" href="/styles.css">
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
</body>
</html>`;
}

function notFound(res, what) {
  // Use res.status() (not res.statusCode =) so the code propagates through both
  // Vercel's response object and the local preview adapter.
  if (typeof res.status === 'function') res.status(404); else res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page({
    title: 'Not found — NipCoupon',
    description: 'That page does not exist.',
    canonical: SITE + '/coupon/',
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
      canonical: SITE + '/',
      body: '<h1>Temporarily unavailable</h1><p>We could not load deals just now. Please try again shortly.</p>'
    }));
  }

  const stores = catalog.stores || [];
  const coupons = catalog.coupons || [];
  const categories = catalog.categories || [];

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');

  /* ── /coupon/:id ───────────────────────────────────────────────────────── */
  if (type === 'coupon') {
    const c = coupons.find(x => x.id === id);
    if (!c) return notFound(res, 'coupon');

    const store = stores.find(s => s.id === c.storeId) || {};
    const storeName = store.name || c.storeName || 'Store';
    const title = (c.title || storeName + ' offer') + ' — ' + storeName + ' | NipCoupon';
    const desc = (c.code ? 'Use code ' + c.code + ' — ' : '') +
      (c.title || 'Verified offer') + ' at ' + storeName + '. Verified and updated daily by NipCoupon.';
    const canonical = SITE + '/coupon/' + encodeURIComponent(c.id);

    // Resolve through the secrets layer; fall back to the store's plain URL.
    const target = S.resolveUrl(c.landingUrl, '') || S.resolveUrl(store.url, store.originalUrl || '');

    const body = `
<div class="card">
  <span class="badge">${esc(c.badge || (c.type === 'code' ? 'CODE' : 'DEAL'))}</span>
  <h1>${esc(c.title || storeName + ' offer')}</h1>
  <p class="meta">${esc(storeName)}${c.expires ? ' · expires ' + esc(c.expires) : ''}${c.linkVerdict ? ' · link ' + esc(c.linkVerdict) : ''}</p>
  ${c.code ? '<div>Coupon code</div><div class="code">' + esc(c.code) + '</div>' : ''}
  ${target
    ? '<p><a class="btn" rel="nofollow sponsored noopener" target="_blank" href="' + esc(target) + '">Get this deal at ' + esc(storeName) + '</a></p>'
    : '<p class="meta">This deal is temporarily unavailable.</p>'}
  ${c.terms && c.terms.length ? '<div class="terms">Terms: ' + esc(c.terms.join(' · ')) + '</div>' : ''}
  <p class="meta" style="margin-top:18px">NipCoupon may earn a commission on qualifying purchases.</p>
</div>`;

    return res.end(page({
      title, description: desc, canonical, body,
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'Offer',
        name: c.title || storeName + ' offer',
        description: desc, url: canonical,
        availability: 'https://schema.org/InStock',
        ...(c.expires ? { priceValidUntil: c.expires } : {}),
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
    const canonical = SITE + '/store/' + encodeURIComponent(s.id);

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
    return res.end(page({ title, description: desc, canonical, body, robots: list.length ? 'index,follow' : 'noindex,follow' }));
  }

  /* ── /category/:id ─────────────────────────────────────────────────────── */
  if (type === 'category') {
    const cat = categories.find(x => x.id === id);
    if (!cat) return notFound(res, 'category');
    const list = coupons.filter(c => c.categoryId === cat.id);
    const title = (cat.name || id) + ' promo codes & deals (' + list.length + ') | NipCoupon';
    const desc = list.length + ' verified ' + (cat.name || id) + ' promo codes and deals, updated daily on NipCoupon.';
    const canonical = SITE + '/category/' + encodeURIComponent(cat.id);

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

    return res.end(page({ title, description: desc, canonical, body, robots: list.length ? 'index,follow' : 'noindex,follow' }));
  }

  return notFound(res, 'page');
};
