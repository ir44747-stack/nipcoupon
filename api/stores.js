/**
 * GET /api/stores  ->  every store with its live deal count.
 *
 * Query params:
 *   ?region=QA   localise for a market: URLs point at the visitor's own
 *                storefront (amazon.ae in the Gulf, amazon.com in the US), the
 *                list is ranked with regional merchants first, and stores that
 *                do not ship to the market expose a `substituteFor` hint.
 *                Omit it and you get the plain global catalogue.
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
    const q = (req && req.query) || {};
    const regionCode = (G.countryFromHeaders(req.headers, q) || '').toUpperCase();

    const byDeals = catalog.stores.slice().sort((a, b) => b.dealCount - a.dealCount || a.name.localeCompare(b.name));

    if (!regionCode) {
      return json(res, 200, { stores: byDeals, total: byDeals.length, region: null, meta: catalog.meta });
    }

    const region = G.resolveRegion(regionCode, (catalog.regions || []).map(r => r.code));
    const localised = byDeals
      .slice()
      .sort(G.storeComparator(region.code))
      .map(s => G.localizeStore(s, region.code, byDeals));

    return json(res, 200, {
      stores: localised,
      total: localised.length,
      region: region.code,
      profile: region.profile,
      meta: catalog.meta
    }, 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
  } catch (err) {
    return json(res, 500, { error: 'Failed to load stores', detail: err.message }, 'no-store');
  }
};
