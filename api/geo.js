/**
 * GET /api/geo — country detection + the localisation rules for that market.
 *
 * Resolution order (first hit wins, never blocks rendering):
 *   1. x-nc-country        — injected by our own Edge middleware (middleware.js
 *                            on Vercel, cloudflare/worker.js on Cloudflare).
 *                            Zero latency: the answer is already in the request.
 *   2. x-vercel-ip-country — Vercel's own edge geolocation.
 *   3. cf-ipcountry        — Cloudflare.
 *   4. IP lookup           — local dev and non-edge hosts only.
 *   5. GLOBAL              — always a safe, fully-populated fallback.
 *
 * Unsupported countries collapse to GLOBAL rather than erroring, so nobody
 * lands on an empty storefront.
 *
 * The response also carries the *rules* (domain/path/currency variants and the
 * market's merchant priority list) so the browser can localise links instantly
 * with no extra round trip. Rules contain no secrets — the Sovrn key is never
 * sent to the client; it is expanded server-side only.
 *
 *   GET /api/geo            → detected market
 *   GET /api/geo?country=AE → force a market (QA / debugging / ?country= preview)
 */
'use strict';

const { loadCatalog } = require('./_data');
const { json, methodNotAllowed } = require('./_http');
const G = require('./_geo');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const catalog = await loadCatalog();
    const supported = catalog.regions.map(r => G.normCode(r.code));

    const query = (req && req.query) || {};
    /* Pass the query through so ?country=AE forces a market — that is how the
       UI previews another country and how you debug a market without a VPN. */
    const headerCountry = G.countryFromHeaders(req.headers, query);

    let country = '';
    let source = 'fallback';
    let detected = headerCountry || null;

    if (headerCountry && supported.indexOf(headerCountry) !== -1) {
      country = headerCountry;
      source = 'edge-header';
    } else if (headerCountry) {
      source = 'unsupported-country';
    }

    // 4 — network lookup. Only when the edge told us nothing (local dev).
    //     Hard 4s timeout; any failure falls through to GLOBAL.
    if (!country) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const r = await fetch('https://ipapi.co/json/', {
          signal: controller.signal,
          headers: { accept: 'application/json' }
        });
        clearTimeout(timer);
        if (r.ok) {
          const j = await r.json();
          const cc = G.normCode(j.country_code);
          detected = cc || detected;
          if (cc && supported.indexOf(cc) !== -1) { country = cc; source = 'ip-lookup'; }
          else source = 'unsupported-country';
        }
      } catch (err) {
        source = 'lookup-unavailable';
      }
    }

    const resolved = G.resolveRegion(country, supported);
    const code = resolved.code;
    const rules = G.loadRules();

    return json(res, 200, {
      country: code,
      detected: detected,
      supported: resolved.supported,
      fallback: resolved.fallback,
      source: source,
      regions: supported,
      profile: resolved.profile,
      /* Client-side localisation table — public data, no secrets. */
      rules: {
        domainVariants: rules.domainVariants,
        pathVariants: rules.pathVariants,
        currencyParams: rules.currencyParams
      },
      priority: rules.priority[code] || rules.priority[G.FALLBACK] || [],
      version: G.version()
    }, 'private, max-age=300, stale-while-revalidate=3600');
  } catch (err) {
    const rules = G.loadRules();
    return json(res, 200, {
      country: G.FALLBACK,
      detected: null,
      supported: true,
      fallback: true,
      source: 'error-fallback',
      regions: [G.FALLBACK],
      profile: G.profileFor(G.FALLBACK),
      rules: { domainVariants: {}, pathVariants: {}, currencyParams: {} },
      priority: rules.priority[G.FALLBACK] || [],
      version: G.version()
    }, 'no-store');
  }
};
