/**
 * GET /api/deals
 *
 * Filterable, sortable, paginated coupon endpoint.
 *   ?q=nike            full-text over title, code, badge, store, category
 *   &category=tech     category id (or "all")
 *   &store=amazon      store id
 *   &type=code|deal
 *   &hot=1
 *   &sort=popular|discount|expiring|newest|rating
 *   &page=1&limit=9
 *   &region=QA        deals tagged QA or GLOBAL (omit/ALL for no region filter)
 *   &source=local|feed  only curated deals, or only DEALS_FEED_URL deals
 *
 * When DEALS_FEED_URL is set, remote deals are fetched, validated, categorised
 * and merged on every (cached) catalogue load — see meta.feed for the report.
 */
'use strict';
const { loadCatalog, queryDeals } = require('./_data');
const { json, methodNotAllowed } = require('./_http');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const catalog = await loadCatalog();
    const query = Object.assign({}, req.query || {});
    let result = queryDeals(catalog, query);

    // ?source= lets a client see exactly what the remote feed contributed
    const source = String(query.source || '').toLowerCase();
    if (source === 'feed' || source === 'local') {
      const items = result.items.filter(c => (c.source || 'local') === source);
      result = Object.assign({}, result, { items, returned: items.length, source });
    }
    const feedMeta = catalog.meta && catalog.meta.feed;
    return json(res, 200, Object.assign({
      meta: catalog.meta,
      feed: feedMeta ? {
        status: feedMeta.status, fetched: feedMeta.fetched, merged: feedMeta.merged,
        skipped: feedMeta.skipped, storesAdded: feedMeta.storesAdded,
        autoCategorised: feedMeta.autoCategorised, durationMs: feedMeta.durationMs, note: feedMeta.note
      } : { status: 'disabled' }
    }, result));
  } catch (err) {
    return json(res, 500, { error: 'Failed to load deals', detail: err.message }, 'no-store');
  }
};
