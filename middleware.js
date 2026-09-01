/**
 * Vercel Edge Middleware — country detection at the edge.
 *
 * Runs on every request *before* anything is served, in the region closest to
 * the visitor. Its whole job is to make the visitor's country available
 * instantly, with no client-side round trip:
 *
 *   1. sets the request header  x-nc-country  → read by /api/geo and friends
 *   2. sets the response cookie nc_country    → read synchronously by the
 *      storefront on first paint, so links localise before the first click
 *   3. echoes  x-nc-region / x-nc-currency / x-nc-lang  for debugging
 *
 * WHY NO REDIRECT
 * ---------------
 * The brief says "IP-based redirection", and it is tempting to bounce a
 * Qatari visitor to /qa/ and an American to /us/. We deliberately do not:
 *
 *   • Redirects fragment a single-page storefront into N duplicate URLs. Google
 *     then has to guess which one is canonical, and crawl budget is spent on
 *     the copies.
 *   • A geo-redirect is invisible to crawlers. Googlebot egresses from the US,
 *     so it would only ever index the US variant of every market.
 *   • It adds a full round trip before first byte for every first-time visitor.
 *
 * Instead we do *soft localisation*: one canonical URL, and the page renders
 * itself for the detected market. Same UX, no SEO cost. Enable
 * GEO_REDIRECT=1 in Vercel env if you ever do want hard redirects — the code
 * path is implemented below and kept behind the flag.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ DEPLOY STATUS: OPTIONAL — NOT included in the deploy bundle by default.
 * ─────────────────────────────────────────────────────────────────────────────
 * This file imports `next/server`, and Vercel only guarantees that resolves
 * when the project's framework preset is Next.js. With the preset set to
 * "Other" (our case: `framework: null`, drag-and-drop deploy) that import has
 * been reported to fail the build with "Edge Function middleware is
 * referencing unsupported modules" — which would take the whole deployment
 * down, not just the middleware.
 *
 * It is also largely redundant here: Vercel already attaches
 * `x-vercel-ip-country` to every request for free, and /api/geo reads it
 * directly. The only thing this middleware adds is writing the `nc_country`
 * cookie server-side — and the storefront now sets that cookie itself on
 * first visit, so the same instant-localisation behaviour is available with
 * none of the build risk.
 *
 * Enable it only if you (a) switch the framework preset to Next.js, or
 * (b) add `next` as a dependency and confirm a preview deploy builds. Then
 * copy this file into dist/ before zipping, or add it to your build.
 *
 * For a dependency-free edge option that needs no build step at all, use
 * cloudflare/worker.js instead — it runs on Cloudflare's own runtime.
 */
import { NextResponse } from 'next/server';

const COOKIE = 'nc_country';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days
const FALLBACK = 'GLOBAL';

/* Countries the catalogue actively serves — anything else falls back to GLOBAL. */
const SUPPORTED = [
  'GLOBAL', 'QA', 'SA', 'AE', 'KW', 'BH', 'OM', 'JO', 'EG',
  'US', 'GB', 'DE', 'IN', 'SG', 'AU'
];

/* Market → UI language and currency hints (mirrors data/geo-rules.json). */
const PROFILES = {
  GLOBAL: { lang: 'en', currency: 'USD' },
  US: { lang: 'en', currency: 'USD' },
  GB: { lang: 'en', currency: 'GBP' },
  DE: { lang: 'de', currency: 'EUR' },
  IN: { lang: 'en', currency: 'INR' },
  SG: { lang: 'en', currency: 'SGD' },
  AU: { lang: 'en', currency: 'AUD' },
  AE: { lang: 'ar', currency: 'AED' },
  SA: { lang: 'ar', currency: 'SAR' },
  QA: { lang: 'ar', currency: 'QAR' },
  KW: { lang: 'ar', currency: 'KWD' },
  BH: { lang: 'ar', currency: 'BHD' },
  OM: { lang: 'ar', currency: 'OMR' },
  JO: { lang: 'ar', currency: 'JOD' },
  EG: { lang: 'ar', currency: 'EGP' }
};

const REDIRECT_ENABLED = process.env.GEO_REDIRECT === '1';

function normalise(code) {
  return String(code || '').trim().toUpperCase();
}

export function middleware(request) {
  const url = new URL(request.url);

  /* Respect an explicit choice: ?country=AE wins over everything, and a
     visitor who has already picked a market keeps it. */
  const forced = normalise(url.searchParams.get('country') || url.searchParams.get('region') || '');
  const existing = normalise(request.cookies.get(COOKIE)?.value || '');

  const geoCountry = normalise(
    request.geo?.country ||
    request.headers.get('x-vercel-ip-country') ||
    request.headers.get('cf-ipcountry') ||
    ''
  );

  let country = FALLBACK;
  let source = 'fallback';

  if (forced && SUPPORTED.includes(forced)) { country = forced; source = 'query'; }
  else if (existing && SUPPORTED.includes(existing)) { country = existing; source = 'cookie'; }
  else if (geoCountry && SUPPORTED.includes(geoCountry)) { country = geoCountry; source = 'geo'; }
  else if (geoCountry) { source = 'unsupported'; }

  const profile = PROFILES[country] || PROFILES[FALLBACK];

  /* Optional hard redirect — off by default, see the header comment. */
  if (REDIRECT_ENABLED && source === 'geo' && !existing && url.pathname === '/') {
    const res = NextResponse.redirect(new URL('/?region=' + country, request.url), 307);
    res.cookies.set(COOKIE, country, { maxAge: COOKIE_MAX_AGE, path: '/', sameSite: 'lax' });
    return res;
  }

  /* Pass the country downstream so /api/geo never needs an IP lookup. */
  const headers = new Headers(request.headers);
  headers.set('x-nc-country', country);
  headers.set('x-nc-source', source);
  headers.set('x-nc-region', country);
  headers.set('x-nc-currency', profile.currency);
  headers.set('x-nc-lang', profile.lang);
  if (geoCountry) headers.set('x-nc-detected', geoCountry);

  const response = NextResponse.next({ request: { headers } });

  /* The cookie is what makes localisation instant: the storefront reads it on
     first paint instead of waiting for /api/geo. SameSite=Lax so it survives
     the top-level navigation; not HttpOnly because the UI reads it. */
  if (existing !== country || !existing) {
    response.cookies.set(COOKIE, country, {
      maxAge: COOKIE_MAX_AGE,
      path: '/',
      sameSite: 'lax',
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production'
    });
  }

  /* Debug/observability headers — safe to expose, no PII. */
  response.headers.set('x-nc-country', country);
  response.headers.set('x-nc-source', source);
  return response;
}

/**
 * Run on pages and API routes; skip static assets so the edge cost (and the
 * added latency) is zero for images, fonts and the sitemap.
 */
export const config = {
  matcher: [
    '/((?!assets/|og\\.png$|favicon|robots\\.txt$|sitemap\\.xml$|.*\\.(?:png|jpg|jpeg|webp|svg|ico|css|woff2?|txt)$).*)'
  ]
};
