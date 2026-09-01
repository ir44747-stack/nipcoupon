/**
 * GET /api/geo
 *
 * Best-effort country detection for the storefront:
 *   1. Vercel's edge header  x-vercel-ip-country   (production, no network call)
 *   2. Cloudflare's header   cf-ipcountry
 *   3. a public IP lookup                          (local dev / other hosts)
 *   4. "GLOBAL"                                    (always the safe fallback)
 *
 * Countries we do not actively support are mapped to GLOBAL rather than
 * dropped, so nobody lands on an empty storefront.
 */
'use strict';
const { loadCatalog } = require('./_data');
const { json, methodNotAllowed } = require('./_http');

const FALLBACK = 'GLOBAL';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const catalog = await loadCatalog();
    const supported = catalog.regions.map(r => r.code);

    const header = String(
      (req.headers && (req.headers['x-vercel-ip-country'] || req.headers['cf-ipcountry'])) || ''
    ).trim().toUpperCase();

    let country = '';
    let source = 'fallback';
    let detected = header || null;

    if (header && supported.indexOf(header) !== -1) {
      country = header;
      source = 'edge-header';
    } else if (header) {
      source = 'unsupported-country';
    }

    if (!country) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const r = await fetch('https://ipapi.co/json/', { signal: controller.signal, headers: { accept: 'application/json' } });
        clearTimeout(timer);
        if (r.ok) {
          const j = await r.json();
          const cc = String(j.country_code || '').toUpperCase();
          detected = cc || detected;
          if (supported.indexOf(cc) !== -1) { country = cc; source = 'ip-lookup'; }
          else source = 'unsupported-country';
        }
      } catch (err) {
        source = 'lookup-unavailable';
      }
    }

    if (!country) country = FALLBACK;

    return json(res, 200, {
      country,
      supported: supported.indexOf(country) !== -1,
      source,
      detected,
      regions: catalog.regions.map(r => r.code)
    }, 'private, max-age=300');
  } catch (err) {
    return json(res, 200, { country: FALLBACK, supported: true, source: 'error-fallback', detail: err.message }, 'no-store');
  }
};
