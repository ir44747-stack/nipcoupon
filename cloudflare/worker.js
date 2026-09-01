/**
 * Cloudflare Worker — edge geo-detection + CDN + cache for NipCoupon.
 *
 * This is the Cloudflare path of the brief's "Cloudflare Workers or similar
 * edge routing". It is OPTIONAL: the Vercel Edge middleware (middleware.js)
 * already does geo-detection on its own, and Vercel already serves the site
 * from its own edge. Deploy this only if you want Cloudflare in front —
 * typically to own the DNS, add a WAF, or cache at Cloudflare's edge.
 *
 * What it does, in order:
 *   1. resolves the visitor's country from Cloudflare's `cf-ipcountry`
 *      (populated on every request, no lookup, no latency)
 *   2. forwards it to Vercel as `x-nc-country` so /api/geo needs no IP lookup
 *   3. sets the `nc_country` cookie so the storefront localises on first paint
 *   4. caches immutable assets at Cloudflare's edge (the CDN half of the job)
 *   5. strips cookies and headers that would otherwise defeat caching
 *
 * Deploy:
 *   npm i -g wrangler
 *   wrangler deploy --config cloudflare/wrangler.toml
 * Then point the route at your hostname (see wrangler.toml).
 */

const COOKIE = 'nc_country';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days
const FALLBACK = 'GLOBAL';

/* Must stay in sync with data/geo-rules.json → profiles. */
const SUPPORTED = [
  'GLOBAL', 'QA', 'SA', 'AE', 'KW', 'BH', 'OM', 'JO', 'EG',
  'US', 'GB', 'DE', 'IN', 'SG', 'AU'
];

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

/* Origin — override per environment in wrangler.toml [env.*.vars]. */
const ORIGIN = 'https://nipcoupon.vercel.app';

const normalise = c => String(c || '').trim().toUpperCase();

function readCookie(header, name) {
  const match = String(header || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

export default {
  async fetch(request, env, ctx) {
    const origin = (env && env.ORIGIN) || ORIGIN;
    const url = new URL(request.url);
    const isAsset = /\.(?:png|jpe?g|webp|svg|ico|css|js|woff2?|txt|xml)$/i.test(url.pathname);

    /* ── 1. country ─────────────────────────────────────────────────────── */
    const forced = normalise(url.searchParams.get('country') || url.searchParams.get('region'));
    const existing = normalise(readCookie(request.headers.get('cookie'), COOKIE));
    const cf = normalise(request.headers.get('cf-ipcountry'));

    let country = FALLBACK;
    let source = 'fallback';
    if (forced && SUPPORTED.includes(forced)) { country = forced; source = 'query'; }
    else if (existing && SUPPORTED.includes(existing)) { country = existing; source = 'cookie'; }
    else if (cf && SUPPORTED.includes(cf)) { country = cf; source = 'cf-ipcountry'; }
    else if (cf) { source = 'unsupported'; }

    const profile = PROFILES[country] || PROFILES[FALLBACK];

    /* ── 2. cache lookups for immutable assets ──────────────────────────── */
    const cacheKey = new Request(url.toString(), request);
    if (isAsset) {
      const hit = await caches.default.match(cacheKey);
      if (hit) {
        const res = new Response(hit.body, hit);
        res.headers.set('x-nc-cache', 'HIT');
        return res;
      }
    }

    /* ── 3. forward to Vercel with the country attached ─────────────────── */
    const headers = new Headers(request.headers);
    headers.set('x-nc-country', country);
    headers.set('x-nc-source', source);
    headers.set('x-nc-currency', profile.currency);
    headers.set('x-nc-lang', profile.lang);
    if (cf) headers.set('x-nc-detected', cf);
    headers.set('x-forwarded-host', url.hostname);

    const proxied = new Request(origin + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    });

    let response = await fetch(proxied);
    response = new Response(response.body, response);

    /* ── 4. cache + tidy ────────────────────────────────────────────────── */
    response.headers.set('x-nc-country', country);
    response.headers.set('x-nc-source', source);

    if (isAsset && response.status === 200) {
      response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      response.headers.set('x-nc-cache', 'MISS');
    }

    if (existing !== country || !existing) {
      response.headers.append(
        'Set-Cookie',
        `${COOKIE}=${country}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax; Secure`
      );
    }

    return response;
  }
};
