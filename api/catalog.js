/**
 * GET /api/catalog
 *
 * Everything the homepage needs in one request:
 * { config, regions[], categories[], stores[], coupons: { items[], total }, meta }
 *
 * Handy query params: ?limit=20&sort=discount&type=code&category=tech&region=QA
 * Deals are NOT pre-filtered by region — the storefront filters client-side so
 * switching country is instant. Stores are narrowed to ?region= when given.
 */
'use strict';
const { loadCatalog, queryDeals, storesForRegion } = require('./_data');
const { json, methodNotAllowed } = require('./_http');
const G = require('./_geo');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const catalog = await loadCatalog();
    const q = (req && req.query) || {};

    /* Region: an explicit ?region= wins, then the country the edge middleware
       already resolved, then plain global ordering. */
    const asked = G.countryFromHeaders(req.headers, q);
    const regionCode = asked && asked !== 'ALL' ? asked : '';

    let stores = storesForRegion(catalog, (q.region && q.region !== 'ALL') ? q.region : 'ALL');
    let region = null;

    if (regionCode) {
      region = G.resolveRegion(regionCode, (catalog.regions || []).map(r => r.code));
      stores = stores
        .slice()
        .sort(G.storeComparator(region.code))
        .map(s => G.localizeStore(s, region.code, stores));
    }

    const payload = {
      config: catalog.config,
      regions: catalog.regions,
      categories: catalog.categories,
      stores,
      coupons: queryDeals(catalog, q),
      meta: catalog.meta
    };
    if (region) {
      payload.region = region.code;
      payload.profile = region.profile;
    }

    return json(res, 200, payload,
      region ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
             : 's-maxage=60, stale-while-revalidate=300');
  } catch (err) {
    return json(res, 500, { error: 'Failed to load catalogue', detail: err.message }, 'no-store');
  }
};
