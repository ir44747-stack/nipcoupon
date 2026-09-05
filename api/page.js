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

/* ══════════════════════════════════════════════════════ UI components ═══ */

/* Typographic store tile. Most stores ship no logo file, so the mark is the
   abbreviation on the brand colour — same treatment as .store-logo in the SPA,
   so a visitor moving between the two sees one product. */
function logoTile(store, name) {
  const label = String(store.abbr || name || '?').slice(0, 4).toUpperCase();
  const bg = /^#[0-9a-f]{3,8}$/i.test(String(store.color || '')) ? store.color : '#1e293b';
  const fg = /^#[0-9a-f]{3,8}$/i.test(String(store.fg || '')) ? store.fg : '#ffffff';
  const size = label.length >= 4 ? '1.05rem' : label.length === 3 ? '1.25rem' : '1.45rem';
  return '<div class="logo" style="background:' + esc(bg) + ';color:' + esc(fg) +
    ';font-size:' + size + '" aria-hidden="true"><span>' + esc(label) + '</span></div>';
}

/* Rating as a pill. Kept text-based rather than drawn stars: it reads in every
   locale, survives a failed font load, and matches the aggregateRating we
   already emit in JSON-LD so the page and the structured data cannot disagree. */
function ratingPill(rating, reviews) {
  const r = Number(rating);
  if (!(r > 0)) return '';
  const n = Number(reviews) || 0;
  return '<span class="pill star">&#9733; <b>' + r.toFixed(1) + '</b>' +
    (n > 0 ? ' <span style="opacity:.75">(' + fmtNum(n) + ' reviews)</span>' : '') + '</span>';
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(v);
}

/* "Verified 3 hours ago" — from the real verifiedHoursAgo field, not invented. */
function verifiedAgo(hours) {
  const h = Number(hours);
  if (!(h >= 0)) return '';
  if (h < 1) return 'just now';
  if (h === 1) return '1 hour ago';
  if (h < 24) return h + ' hours ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

/* Community proof. Uses the genuine .uses count and .verifiedHoursAgo stamp —
   no fabricated "X shoppers in the last Y minutes" ticker, because nothing in
   the dataset records live redemptions and inventing one would be a lie told
   to every visitor. */
function socialProof(c) {
  const uses = Number(c.uses) || 0;
  const ago = verifiedAgo(c.verifiedHoursAgo);
  const bits = [];
  if (uses > 0) bits.push('Used <b>' + fmtNum(uses) + '</b> times');
  if (ago) bits.push('last verified <b>' + esc(ago) + '</b>');
  return bits.length ? '<p class="social">' + bits.join(' &middot; ') + '</p>' : '';
}

/* Discount headline for the card's left rail. Prefers the curated badge. */
function dealValue(c) {
  const badge = String(c.badge || '').trim();
  if (badge) {
    const m = badge.match(/^(\S+)\s*(.*)$/);
    return '<b>' + esc(m ? m[1] : badge) + '</b><i>' + esc(m && m[2] ? m[2] : (c.type === 'code' ? 'code' : 'deal')) + '</i>';
  }
  return '<b>' + esc(c.type === 'code' ? 'CODE' : 'DEAL') + '</b><i>offer</i>';
}

/* Tag row. Every tag is backed by a field: verified, hot -> Staff Pick,
   addedDaysAgo <= 7 -> New, type -> Code/Deal. */
function dealTags(c) {
  const out = [];
  /* Key off verifiedHoursAgo, not .verified: _data.js normalises rows and drops
     the boolean, so testing it silently hid the Verified tag on every card.
     A timestamp is the stronger claim anyway — it says when, not just whether. */
  if (Number(c.verifiedHoursAgo) >= 0) out.push('<span class="tag v">&#10003; Verified</span>');
  if (c.hot) out.push('<span class="tag hot">Staff pick</span>');
  if (Number(c.addedDaysAgo) >= 0 && Number(c.addedDaysAgo) <= 7) out.push('<span class="tag new">New</span>');
  out.push('<span class="tag">' + (c.type === 'code' ? 'Promo code' : 'Deal') + '</span>');
  return '<div class="tags">' + out.join('') + '</div>';
}

/* The reveal control. With JS the button hides and the dashed code box takes
   its place; without JS both render and the code is simply visible. */
function revealCta(c, target, storeName) {
  const ga = ' data-ga-store="' + esc(storeName) + '" data-ga-coupon="' + esc(c.id || '') +
    '" data-ga-code="' + esc(c.code || '') + '"';
  if (!target) return '<span class="meta">Temporarily unavailable</span>';
  const label = c.code ? 'Get code' : 'Get deal';
  const btn = '<a class="btn" data-reveal rel="nofollow sponsored noopener" target="_blank" href="' +
    esc(target) + '"' + ga + '>' + label + '</a>';
  if (!c.code) return '<div class="reveal">' + btn + '</div>';
  /* No `hidden` attribute in the markup: with JS disabled that would leave the
     code permanently invisible and the page useless to the visitor. It is the
     .js class on <html> (set by a one-line inline script) that collapses the
     code box, so JS-off users simply see the code and the link side by side. */
  return '<div class="reveal">' + btn +
    '<button type="button" class="code" data-code="' + esc(c.code) +
    '" data-label="Tap to copy" aria-label="Copy code ' + esc(c.code) + '">' +
    esc(c.code) + '<small>Tap to copy</small></button></div>';
}

/* Crawlable crumb trail matching the BreadcrumbList JSON-LD. */
function crumbHtml(trail) {
  return '<nav class="crumbs" aria-label="Breadcrumb">' + trail.map((t, i) => {
    const last = i === trail.length - 1;
    const node = last
      ? '<span aria-current="page">' + esc(t.name) + '</span>'
      : '<a href="' + esc(t.href) + '">' + esc(t.name) + '</a>';
    return (i ? '<i>&#8250;</i>' : '') + node;
  }).join('') + '</nav>';
}

const DISCLOSURE = '<div class="disclosure">' +
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>' +
  '<span><b style="color:#94a3b8">Affiliate disclosure.</b> NipCoupon may earn a commission when you ' +
  'buy through links on this page. It never changes the price you pay, and it does not affect which ' +
  'codes we list or how they are ranked. Codes are re-tested regularly, but merchants can change or ' +
  'withdraw an offer at any time.</span></div>';

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
<meta name="description" content="${esc(description)}">${kw}${canonical ? `
<link rel="canonical" href="${esc(canonical)}">` : ''}
${canonical ? alternates(path || '/') : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="NipCoupon">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:locale" content="${esc((lang || DEFAULT_LOCALE) === 'ar' ? 'ar_AE' : 'en_US')}">
${(() => {
  /* ogImage was a parameter no caller ever passed, so every server-rendered
     store and coupon page shipped twitter:card=summary_large_image with no
     image behind it. Shared to Instagram, WhatsApp, Facebook or X those URLs
     unfurled as a bare text link — the single biggest leak in the social
     funnel, since /og.png (1200x630, the correct OG size) already exists in
     the web root and index.html has always referenced it. Default to it so
     every route unfurls with a card, and let callers override per page later. */
  const img = ogImage || (SITE + '/og.png');
  return '<meta property="og:image" content="' + esc(img) + '">\n' +
         '<meta property="og:image:width" content="1200">\n' +
         '<meta property="og:image:height" content="630">\n' +
         '<meta property="og:image:alt" content="' + esc(title) + '">\n' +
         '<meta name="twitter:image" content="' + esc(img) + '">';
})()}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="robots" content="${esc(robots || 'index,follow')}">
<!-- Site icons. These were absent from every server-rendered route, which is
     ~110 of the site's indexed URLs — only the SPA shell at / declared one.
     Google picks the favicon from the page it crawls, so store, category and
     coupon results had no icon to show at all. Same set as index.html. -->
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/icons/favicon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="/assets/icons/favicon-48.png">
<link rel="icon" type="image/svg+xml" href="/assets/icons/icon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#090d16">
<link rel="preconnect" href="https://cdn.viglink.com" crossorigin>
<link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
window.dataLayer=window.dataLayer||[];
window.gtag=function gtag(){window.dataLayer.push(arguments);};
window.gtag('js',new Date());window.gtag('config','${GA_ID}');
</script>
<style>
/* Design tokens mirror index.html :root so the SSR routes and the SPA are the
   same product. Previously these pages shipped ~10 lines of CSS — a bare
   820px column — while the SPA had a full dark design system. */
:root{
  --bg:#090d16;--bg-2:#0f172a;--card:#1e293b;--card-2:#172033;
  --border:rgba(148,163,184,.14);--border-strong:rgba(148,163,184,.26);
  --green:#10b981;--green-soft:rgba(16,185,129,.12);--green-glow:rgba(16,185,129,.35);
  --blue:#3b82f6;--text:#e8eef7;--muted:#94a3b8;--muted-2:#64748b;
  --radius:18px;--radius-sm:12px;
  --shadow:0 18px 40px -18px rgba(2,6,23,.9);
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;
}
*,*::before,*::after{box-sizing:border-box}
body{
  margin:0;padding:0;font:16px/1.65 var(--font);color:var(--text);
  background:var(--bg);
  /* Depth without going flat black: two faint brand-tinted pools behind an
     obsidian base, exactly the treatment the SPA uses. */
  background-image:
    radial-gradient(900px 480px at 12% -8%,rgba(16,185,129,.10),transparent 60%),
    radial-gradient(760px 420px at 92% 0%,rgba(59,130,246,.09),transparent 62%);
  background-attachment:fixed;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 72px}
a{color:var(--green);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{line-height:1.2;margin:0}
img{max-width:100%;height:auto}
:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(59,130,246,.45);border-radius:8px}

/* ── top bar ─────────────────────────────────────────────────────────── */
.top{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.top a.home{
  display:inline-flex;align-items:center;gap:8px;color:var(--muted);
  font-size:14px;font-weight:600;padding:8px 14px;border-radius:999px;
  border:1px solid var(--border);background:rgba(15,23,42,.6)
}
.top a.home:hover{color:var(--text);border-color:var(--border-strong);text-decoration:none}

/* ── breadcrumbs ─────────────────────────────────────────────────────── */
.crumbs{
  display:flex;flex-wrap:wrap;align-items:center;gap:7px;
  font-size:13px;color:var(--muted-2);margin-bottom:18px
}
.crumbs a{color:var(--muted)}
.crumbs span[aria-current]{color:var(--text);font-weight:600}
.crumbs i{font-style:normal;opacity:.5}

/* ── surfaces ────────────────────────────────────────────────────────── */
.card{
  background:linear-gradient(180deg,rgba(30,41,59,.92),rgba(23,32,51,.92));
  border:1px solid var(--border);border-radius:var(--radius);
  padding:22px;margin:0 0 16px;box-shadow:var(--shadow)
}
/* Glassmorphism for the stat rail — translucent over the page gradient. */
.glass{
  background:rgba(30,41,59,.55);
  -webkit-backdrop-filter:blur(14px) saturate(140%);
  backdrop-filter:blur(14px) saturate(140%);
  border:1px solid var(--border-strong);
}

/* ── hero ────────────────────────────────────────────────────────────── */
.hero{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.logo{
  width:74px;height:74px;border-radius:20px;flex:none;
  display:grid;place-items:center;position:relative;overflow:hidden;isolation:isolate;
  font-weight:900;font-size:1.45rem;letter-spacing:-.03em;color:#fff;
  box-shadow:0 1px 2px rgba(0,0,0,.45),0 10px 20px -12px rgba(0,0,0,.8),
    inset 0 1px 0 rgba(255,255,255,.30),inset 0 0 0 1px rgba(255,255,255,.10)
}
.logo::after{
  content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.04) 42%,rgba(0,0,0,.10))
}
.logo span{position:relative;z-index:2}
.hero-main{flex:1 1 320px;min-width:0}
h1{font-size:clamp(1.5rem,4vw,2.05rem);font-weight:800;letter-spacing:-.02em}
.sub{color:var(--muted);margin:10px 0 0;font-size:15px}

/* ── pill badges ─────────────────────────────────────────────────────── */
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.pill{
  display:inline-flex;align-items:center;gap:6px;
  padding:6px 12px;border-radius:999px;font-size:13px;font-weight:700;
  background:rgba(15,23,42,.7);border:1px solid var(--border);color:var(--muted)
}
.pill b{color:var(--text);font-weight:800}
.pill.ok{background:var(--green-soft);border-color:rgba(16,185,129,.32);color:#6ee7b7}
.pill.star{color:#fbbf24;border-color:rgba(251,191,36,.28);background:rgba(251,191,36,.10)}

/* ── stat rail ───────────────────────────────────────────────────────── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 16px}
.stat{border-radius:var(--radius-sm);padding:16px 18px}
.stat .k{
  display:block;font-size:11px;font-weight:800;letter-spacing:.09em;
  text-transform:uppercase;color:var(--muted-2)
}
.stat .v{display:block;font-size:1.6rem;font-weight:900;letter-spacing:-.02em;margin-top:6px;color:var(--text)}
.stat .v.g{color:#34d399}
.stat .n{display:block;font-size:12px;color:var(--muted-2);margin-top:2px}

/* ── coupon cards ────────────────────────────────────────────────────── */
.deal{
  display:flex;gap:18px;align-items:stretch;
  background:linear-gradient(180deg,rgba(30,41,59,.92),rgba(23,32,51,.92));
  border:1px solid var(--border);border-radius:var(--radius);
  padding:18px;margin:0 0 14px;
  transition:transform .22s cubic-bezier(.2,.7,.3,1),border-color .22s ease,box-shadow .22s ease
}
.deal:hover{transform:translateY(-2px);border-color:rgba(16,185,129,.34);box-shadow:0 22px 44px -22px rgba(2,6,23,.95)}
.deal-val{
  flex:none;width:104px;border-radius:14px;text-align:center;
  /* Column flex, not grid: place-items:center on a two-child grid puts each
     child in its own stretched row, which stranded the "OFF" label at the
     bottom of tall cards instead of tucking it under the number. */
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  padding:14px 8px;background:var(--green-soft);border:1px dashed rgba(16,185,129,.42)
}
.deal-val b{display:block;font-size:1.5rem;font-weight:900;color:#34d399;line-height:1.05;letter-spacing:-.02em}
.deal-val i{display:block;font-style:normal;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-top:4px}
.deal-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:9px}
.deal-body h3{font-size:1.06rem;font-weight:700}
.deal-body h3 a{color:var(--text)}
.deal-body h3 a:hover{color:#6ee7b7;text-decoration:none}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{
  font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;
  padding:4px 9px;border-radius:6px;border:1px solid var(--border);color:var(--muted);background:rgba(15,23,42,.6)
}
.tag.v{color:#6ee7b7;border-color:rgba(16,185,129,.34);background:var(--green-soft)}
.tag.hot{color:#fda4af;border-color:rgba(251,113,133,.32);background:rgba(251,113,133,.10)}
.tag.new{color:#93c5fd;border-color:rgba(59,130,246,.32);background:rgba(59,130,246,.10)}
.deal-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:auto;padding-top:4px}
.social{font-size:12.5px;color:var(--muted-2)}
.social b{color:#6ee7b7;font-weight:700}

/* ── reveal / CTA ────────────────────────────────────────────────────── */
.reveal{position:relative;flex:none;min-width:172px}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;
  background:linear-gradient(135deg,#10b981,#059669);color:#03231b;
  font-weight:800;font-size:14.5px;padding:13px 20px;border-radius:11px;
  border:0;cursor:pointer;font-family:inherit;text-decoration:none;
  box-shadow:0 10px 24px -12px var(--green-glow);
  transition:transform .18s ease,box-shadow .18s ease,filter .18s ease
}
.btn:hover{transform:translateY(-1px);filter:brightness(1.06);box-shadow:0 16px 30px -14px var(--green-glow);text-decoration:none}
.btn:active{transform:translateY(0)}
.btn.ghost{
  background:transparent;color:#6ee7b7;border:1px solid rgba(16,185,129,.42);
  box-shadow:none;font-weight:700
}
.btn.ghost:hover{background:var(--green-soft);filter:none}
/* Click-to-reveal: the code sits behind the CTA and is swapped in by JS.
   Rendered in the HTML so it is present for crawlers and for no-JS users. */
.code{
  display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;
  background:var(--bg-2);border:1px dashed var(--green);color:#6ee7b7;
  padding:11px 14px;border-radius:11px;font-weight:800;letter-spacing:.09em;
  font-size:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  cursor:pointer;text-align:left
}
.code small{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-2);font-weight:700;flex:none}
.code.copied{border-style:solid;background:var(--green-soft);color:#a7f3d0}
/* Only collapse the code box when JS can reveal it again; with JS off both the
   code and the link stay on screen rather than the code being unreachable. */
.js .reveal .code{display:none}
.js .reveal.is-open .code{display:flex}
.js .reveal.is-open .btn[data-reveal]{display:none}

/* ── misc ────────────────────────────────────────────────────────────── */
.meta{color:var(--muted);font-size:13.5px;margin:0}
.badge{display:inline-block;background:var(--green-soft);color:#6ee7b7;padding:5px 13px;border-radius:999px;font-weight:800;font-size:12.5px;border:1px solid rgba(16,185,129,.28)}
.terms{color:var(--muted);font-size:13px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
.terms ul{margin:8px 0 0;padding-left:18px}
.terms li{margin:3px 0}
h2.sec{font-size:1.15rem;font-weight:800;margin:26px 0 12px;letter-spacing:-.01em}
.disclosure{
  display:flex;gap:11px;align-items:flex-start;
  font-size:12.5px;line-height:1.55;color:var(--muted-2);
  background:rgba(15,23,42,.5);border:1px solid var(--border);
  border-radius:var(--radius-sm);padding:13px 15px;margin:18px 0 0
}
.disclosure svg{flex:none;margin-top:1px;opacity:.8}
.links{display:flex;flex-wrap:wrap;gap:8px}
.links a{
  font-size:13px;font-weight:600;padding:7px 13px;border-radius:999px;
  border:1px solid var(--border);background:rgba(15,23,42,.6);color:var(--muted)
}
.links a:hover{color:#6ee7b7;border-color:rgba(16,185,129,.34);text-decoration:none}

@media (max-width:640px){
  .wrap{padding:20px 15px 56px}
  .deal{flex-wrap:wrap;gap:14px}
  .deal-val{width:84px}
  .reveal{min-width:0;width:100%}
  .logo{width:60px;height:60px;border-radius:17px;font-size:1.2rem}
  .stat .v{font-size:1.4rem}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
</style>${ld}
</head>
<body>
<script>document.documentElement.className+=' js';</script>
<div class="wrap">
<div class="top"><a class="home" href="/">&#8592; NipCoupon</a></div>
${body}
</div>
<script>
/* Click-to-reveal + copy. The code is always in the HTML (crawlable, and it
   still works with JS off, where the button is a plain link and the code is
   visible); JS only upgrades it to reveal-then-copy. */
(function () {
  function flash(el, msg) {
    var prev = el.getAttribute('data-label');
    el.classList.add('copied');
    el.querySelector('small').textContent = msg;
    setTimeout(function () {
      el.classList.remove('copied');
      el.querySelector('small').textContent = prev;
    }, 1800);
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    /* Reveal: swap the CTA for the code, then open the merchant in a new tab
       so the affiliate click still fires on the same gesture. */
    var rv = t.closest('[data-reveal]');
    if (rv) {
      var wrap = rv.parentNode;
      if (wrap && wrap.querySelector('.code')) {
        wrap.classList.add('is-open');
        var href = rv.getAttribute('href');
        if (href) window.open(href, '_blank', 'noopener');
      }
      return;
    }

    /* Copy */
    var code = t.closest('.code');
    if (code) {
      var val = code.getAttribute('data-code') || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(function () { flash(code, 'Copied'); },
          function () { flash(code, 'Press Ctrl+C'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = val; ta.setAttribute('readonly', '');
        ta.style.position = 'absolute'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); flash(code, 'Copied'); }
        catch (err) { flash(code, 'Press Ctrl+C'); }
        document.body.removeChild(ta);
      }
    }
  });
})();
</script>
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
  /* Acquisition channel on the conversion event itself. GA4 attributes the
     session, but the affiliate click is the revenue moment and it carried no
     source dimension, so an Instagram-driven conversion was indistinguishable
     from an organic one in the events table. Read the campaign from the
     landing URL (persisted for the tab, since the utm_* params are gone once
     the visitor navigates) and fall back to classifying the referrer. */
  try {
    var LS = 'np_acq';
    var q = new URLSearchParams(location.search);
    var acq = null;
    if (q.get('utm_source')) {
      acq = { source: q.get('utm_source'), medium: q.get('utm_medium') || '', campaign: q.get('utm_campaign') || '' };
      try { sessionStorage.setItem(LS, JSON.stringify(acq)); } catch (e3) {}
    } else {
      try { acq = JSON.parse(sessionStorage.getItem(LS) || 'null'); } catch (e3) {}
    }
    if (!acq) {
      var ref = document.referrer || '';
      var host = '';
      try { host = ref ? new URL(ref).hostname.replace(/^www\\./, '') : ''; } catch (e4) {}
      var social = /instagram|facebook|fb\\.|tiktok|t\\.co|twitter|x\\.com|pinterest|snapchat|whatsapp|telegram|linkedin|reddit/i;
      var search = /google|bing|yahoo|duckduckgo|yandex|baidu|ecosia/i;
      acq = {
        source: host || 'direct',
        medium: !host ? 'direct' : (social.test(host) ? 'social' : (search.test(host) ? 'organic' : 'referral')),
        campaign: ''
      };
    }
    params.acq_source = acq.source || '';
    params.acq_medium = acq.medium || '';
    params.acq_campaign = acq.campaign || '';
  } catch (e5) {}
  window.gtag('event', 'click_affiliate', params);
  window.gtag('event', 'select_content', {
    content_type: 'affiliate_link',
    item_id: params.coupon_id || params.store_name,
    store_name: params.store_name,
    store_domain: domain
  });
});
</script>${sovrnScript()}
<!-- Vercel Web Analytics. Same bundle the SPA loads, so the ~110 server-
     rendered /store/*, /category/* and /coupon/* routes are measured too;
     without it the dashboard would only ever show the homepage. -->
<script defer src="/assets/analytics.js"></script>
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
    /* A 404 body was being served with robots "index,follow" and a canonical
       pointing at the homepage. That is the classic soft-404 signal: Google is
       told the page is indexable and that its canonical is "/", so expired or
       mistyped deal URLs can end up consolidating into the homepage instead of
       dropping out of the index. The HTTP status alone is not enough once a
       canonical contradicts it. */
    robots: 'noindex,follow',
    canonical: '',
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

    const cat = categories.find(x => x.id === c.categoryId);
    const siblingDeals = coupons.filter(x => x.storeId === c.storeId && x.id !== c.id);

    const body = `
${crumbHtml([
  { name: 'Home', href: '/' },
  ...(cat ? [{ name: cat.name || cat.id, href: '/category/' + encodeURIComponent(cat.id) }] : []),
  ...(store.id ? [{ name: storeName, href: '/store/' + encodeURIComponent(store.id) }] : []),
  { name: c.title || 'Offer' }
])}
<div class="card">
  <div class="hero">
    ${logoTile(store, storeName)}
    <div class="hero-main">
      <h1>${esc(c.title || storeName + ' offer')}</h1>
      <p class="sub">${esc(storeName)} &middot; verified ${esc(stamp)}</p>
      <div class="pills">
        <span class="pill ok">&#10003; Verified offer</span>
        ${ratingPill(c.rating, c.uses)}
        ${c.expires ? '<span class="pill">Expires <b>' + esc(c.expires) + '</b></span>' : '<span class="pill">No end date</span>'}
        ${verifiedAgo(c.verifiedHoursAgo) ? '<span class="pill">Checked <b>' + esc(verifiedAgo(c.verifiedHoursAgo)) + '</b></span>' : ''}
      </div>
    </div>
  </div>

  <div class="deal" style="margin-top:20px">
    <div class="deal-val">${dealValue(c)}</div>
    <div class="deal-body">
      ${dealTags(c)}
      ${socialProof(c)}
      ${geoNote}
    </div>
    ${revealCta(c, target, storeName)}
  </div>

  ${c.terms && c.terms.length
    ? '<div class="terms"><b style="color:#cbd5e1">Terms &amp; conditions</b><ul>' +
      c.terms.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></div>'
    : ''}
  ${DISCLOSURE}
</div>

${siblingDeals.length ? `<h2 class="sec">More ${esc(storeName)} offers</h2>
${siblingDeals.slice(0, 6).map(x => `<div class="deal">
  <div class="deal-val">${dealValue(x)}</div>
  <div class="deal-body">
    <h3><a href="/coupon/${encodeURIComponent(x.id)}">${esc(x.title || storeName + ' offer')}</a></h3>
    ${dealTags(x)}
    ${socialProof(x)}
  </div>
  <div class="reveal"><a class="btn ghost" href="/coupon/${encodeURIComponent(x.id)}">View offer</a></div>
</div>`).join('\n')}` : ''}
${(function () {
  /* Crawl paths out of the leaf. Without these a /coupon/* page is a dead end:
     Googlebot lands from the sitemap and the only links are outbound affiliate
     URLs marked nofollow, so no PageRank flows back into the site. */
  const out = [];
  if (store.id) {
    out.push('<a href="/store/' + encodeURIComponent(store.id) + '">All ' + esc(storeName) + ' codes</a>');
  }
  const cc = categories.find(x => x.id === c.categoryId);
  if (cc) {
    out.push('<a href="/category/' + encodeURIComponent(cc.id) + '">' + esc(cc.name || cc.id) + ' deals</a>');
  }
  const related = coupons
    .filter(x => x.id !== c.id && x.storeId !== c.storeId && x.categoryId === c.categoryId)
    .slice(0, 6)
    .map(x => '<a href="/coupon/' + encodeURIComponent(x.id) + '">' + esc(x.title || 'Offer') + '</a>');
  return '<h2 class="sec">Keep browsing</h2><div class="card">' +
    '<div class="links">' + out.join('') + '</div>' +
    (related.length ? '<div class="links" style="margin-top:10px">' + related.join('') + '</div>' : '') +
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
          /* price is REQUIRED whenever priceCurrency is present — Google drops
             the whole Offer from rich-result eligibility if one appears without
             the other. A coupon has no price of its own: the saving is applied
             to the merchant's basket, so 0 is the honest value and is what
             schema.org expects for a free-to-claim offer. */
          price: 0,
          ...(profile.currency ? { priceCurrency: profile.currency } : {}),
          /* Surface the discount itself so the snippet can show "30% off"
             rather than just a title. */
          ...(Number(c.value) > 0
            ? { discount: Number(c.value), discountCurrency: profile.currency || 'USD' }
            : {}),
          seller: { '@type': 'Organization', name: storeName },
          isPartOf: { '@id': SITE + '/#website' }
        },
        /* Ratings drive the star snippet. The data carries a real rating and a
           usage count for every coupon, and both were being thrown away.
           aggregateRating must hang off a node Google accepts it on — attaching
           it directly to an Offer is invalid — so it goes on the Product that
           represents this deal, which references the Offer above. */
        ...(!expired && Number(c.rating) > 0 && Number(c.uses) > 0 ? [{
          '@type': 'Product',
          '@id': canonical + '#product',
          name: c.title || storeName + ' offer',
          description: desc,
          url: canonical,
          brand: { '@type': 'Brand', name: storeName },
          offers: { '@id': canonical + '#offer' },
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: Number(c.rating).toFixed(1),
            reviewCount: Number(c.uses),
            bestRating: '5',
            worstRating: '1'
          }
        }] : []),
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
      .join('');

    const siblings = stores
      .filter(x => x.id !== s.id && coupons.some(c => c.storeId === x.id))
      .slice(0, 8)
      .map(x => '<a href="/store/' + encodeURIComponent(x.id) + '">' + esc(x.name) + '</a>')
      .join('');

    /* Monetised outbound link for the store page itself. Without this the
       server-rendered /store/* page had no affiliate link at all: every
       visitor who landed here from search and clicked through to the merchant
       via the coupon list was attributed, but anyone wanting the storefront
       directly had no monetised path. Resolve through the secrets layer, then
       localise inside the wrapper so the commission survives the host swap. */
    const storeBase = S.resolveUrl(s.url, s.originalUrl || '');
    const storeLoc = G.localizeUrl(storeBase, region.code);
    const storeTarget = storeLoc.url || storeBase;

    /* Aggregates for the stat rail. Every figure is computed from fields that
       exist in the dataset — see the note below on what is deliberately absent. */
    const codeCount = list.filter(c => c.type === 'code').length;
    const rated = list.filter(c => Number(c.rating) > 0);
    const avgRating = rated.length
      ? rated.reduce((a, c) => a + Number(c.rating), 0) / rated.length
      : 0;
    const totalUses = list.reduce((a, c) => a + (Number(c.uses) || 0), 0);
    const freshest = list.reduce((best, c) => {
      const h = Number(c.verifiedHoursAgo);
      return h >= 0 && (best === null || h < best) ? h : best;
    }, null);
    /* .value is a bare number whose unit lives in .badge — "30% OFF" vs
       "$8 OFF". Appending % blindly turned an $8 coupon into "8%", so read the
       best offer's own badge instead and only report a percentage when the
       winning badge is actually a percentage. */
    const pctOffers = list.filter(c => /%/.test(String(c.badge || '')));
    const topPct = pctOffers.reduce((m, c) => Math.max(m, Number(c.value) || 0), 0);
    const topBadge = (list.slice().sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))[0] || {}).badge || '';

    const body = `
${crumbHtml([{ name: 'Home', href: '/' }, { name: s.name }])}
<div class="card">
  <div class="hero">
    ${logoTile(s, s.name)}
    <div class="hero-main">
      <h1>Top ${esc(s.name)} promo codes &amp; verified deals</h1>
      <p class="sub">${esc(desc)}</p>
      <div class="pills">
        <span class="pill ok">&#10003; ${list.length} verified offer${list.length === 1 ? '' : 's'}</span>
        ${avgRating > 0 ? ratingPill(avgRating, totalUses) : ''}
        ${freshest !== null ? '<span class="pill">Checked <b>' + esc(verifiedAgo(freshest)) + '</b></span>' : ''}
        <span class="pill">Updated <b>${esc(stamp)}</b></span>
      </div>
    </div>
  </div>
  ${storeTarget
    ? '<div style="margin-top:18px;max-width:260px"><a class="btn" rel="nofollow sponsored noopener" target="_blank" href="' +
      esc(storeTarget) + '" data-ga-store="' + esc(s.name) + '">Visit ' + esc(s.name) + '</a></div>'
    : ''}
</div>

${list.length ? `<div class="stats">
  <div class="stat glass"><span class="k">Working codes</span><span class="v g">${list.length}</span><span class="n">${codeCount} code${codeCount === 1 ? '' : 's'} &middot; ${list.length - codeCount} deal${list.length - codeCount === 1 ? '' : 's'}</span></div>
  ${avgRating > 0 ? '<div class="stat glass"><span class="k">Shopper rating</span><span class="v">' + avgRating.toFixed(1) + '<span style="font-size:.9rem;color:#64748b">/5</span></span><span class="n">from ' + fmtNum(totalUses) + ' uses</span></div>' : ''}
  ${topPct > 0
    ? '<div class="stat glass"><span class="k">Best discount</span><span class="v g">' + esc(String(topPct)) + '%</span><span class="n">highest live saving</span></div>'
    : (topBadge ? '<div class="stat glass"><span class="k">Best discount</span><span class="v g">' + esc(String(topBadge).replace(/\s*off\s*$/i, '')) + '</span><span class="n">highest live saving</span></div>' : '')}
  ${freshest !== null ? '<div class="stat glass"><span class="k">Last verified</span><span class="v">' + esc(verifiedAgo(freshest)) + '</span><span class="n">re-tested continuously</span></div>' : ''}
</div>` : ''}

${list.length ? `<h2 class="sec">${list.length} live ${esc(s.name)} offer${list.length === 1 ? '' : 's'}</h2>` : ''}
${list.map(c => {
  const cBase = S.resolveUrl(c.landingUrl, '') || S.resolveUrl(s.url, s.originalUrl || '');
  const cTarget = G.localizeUrl(cBase, region.code).url || cBase;
  return `<div class="deal">
  <div class="deal-val">${dealValue(c)}</div>
  <div class="deal-body">
    <h3><a href="/coupon/${encodeURIComponent(c.id)}">${esc(c.title || s.name + ' offer')}</a></h3>
    ${dealTags(c)}
    ${socialProof(c)}
    <div class="deal-foot"><span class="meta">${c.expires ? 'Expires ' + esc(c.expires) : 'No end date'}</span></div>
  </div>
  ${revealCta(c, cTarget, s.name)}
</div>`;
}).join('\n')}

<div class="card">${DISCLOSURE.replace(' class="disclosure"', ' class="disclosure" style="margin:0;border:0;background:transparent;padding:0"')}</div>

${catLinks ? '<h2 class="sec">Browse categories</h2><div class="card"><div class="links">' + catLinks + '</div></div>' : ''}
${siblings ? '<h2 class="sec">More stores</h2><div class="card"><div class="links">' + siblings + '</div></div>' : ''}`;

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
