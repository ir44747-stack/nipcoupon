/**
 * GET /api/deals/:id  ->  a single coupon by id
 * Vercel maps this file (api/deals/[id].js) to /api/deals/c8 etc.
 */
'use strict';
const { loadCatalog } = require('../_data');
const { json, methodNotAllowed } = require('../_http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const id = (req.query && req.query.id) || '';
    const catalog = await loadCatalog();
    const coupon = catalog.coupons.find(c => c.id === id);
    if (!coupon) return json(res, 404, { error: 'Coupon not found', id }, 'no-store');
    return json(res, 200, { coupon, meta: catalog.meta });
  } catch (err) {
    return json(res, 500, { error: 'Failed to load coupon', detail: err.message }, 'no-store');
  }
};
