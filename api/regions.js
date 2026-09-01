/**
 * GET /api/regions
 *
 * The markets the catalogue supports, each with its live deal count.
 * The UI builds its country selector from this.
 */
'use strict';
const { loadCatalog, regionCounts } = require('./_data');
const { json, methodNotAllowed } = require('./_http');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const catalog = await loadCatalog();
    const counts = regionCounts(catalog);
    const regions = catalog.regions.map(r => Object.assign({}, r, { dealCount: counts[r.code] || 0 }));
    return json(res, 200, {
      regions,
      default: (catalog.regions.find(r => r.default) || { code: 'GLOBAL' }).code,
      meta: catalog.meta
    });
  } catch (err) {
    return json(res, 500, { error: 'Failed to load regions', detail: err.message }, 'no-store');
  }
};
