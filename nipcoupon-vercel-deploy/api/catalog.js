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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const catalog = await loadCatalog();
    return json(res, 200, {
      config: catalog.config,
      regions: catalog.regions,
      categories: catalog.categories,
      stores: storesForRegion(catalog, (req.query && req.query.region) || 'ALL'),
      coupons: queryDeals(catalog, req.query || {}),
      meta: catalog.meta
    });
  } catch (err) {
    return json(res, 500, { error: 'Failed to load catalogue', detail: err.message }, 'no-store');
  }
};
