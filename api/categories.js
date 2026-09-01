/**
 * GET /api/categories  ->  every category with its live deal count.
 */
'use strict';
const { loadCatalog } = require('./_data');
const { json, methodNotAllowed } = require('./_http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const catalog = await loadCatalog();
    return json(res, 200, { categories: catalog.categories, total: catalog.categories.length, meta: catalog.meta });
  } catch (err) {
    return json(res, 500, { error: 'Failed to load categories', detail: err.message }, 'no-store');
  }
};
