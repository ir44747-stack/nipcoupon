/**
 * GET /api/stores  ->  every store with its live deal count.
 */
'use strict';
const { loadCatalog } = require('./_data');
const { json, methodNotAllowed } = require('./_http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const catalog = await loadCatalog();
    const sorted = catalog.stores.slice().sort((a, b) => b.dealCount - a.dealCount || a.name.localeCompare(b.name));
    return json(res, 200, { stores: sorted, total: sorted.length, meta: catalog.meta });
  } catch (err) {
    return json(res, 500, { error: 'Failed to load stores', detail: err.message }, 'no-store');
  }
};
