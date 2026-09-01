/**
 * GET /api/keywords — live long-tail keyword rotation.
 *
 * Thin HTTP wrapper over api/_keywords.js (which holds the engine so
 * api/page.js can call it without a network hop).
 *
 * The homepage ships static meta tags, so those can only change when the file
 * is rebuilt. This endpoint covers everything that must be live:
 *
 *   • /api/page pulls the same engine to write <meta name="keywords">
 *     server-side, into the HTML a crawler actually receives
 *   • scripts/keyword-sync.js rotates the homepage's static tags on a schedule
 *   • the storefront can refresh its term bank between deploys
 *
 * Query params:
 *   ?limit=12          how many terms to return (default 12, max 40)
 *   ?store=amazon      bias to one store (id or display name)
 *   ?category=tech     bias to one category (id or display name)
 *   ?date=YYYY-MM-DD   preview a different day's rotation
 *   ?format=csv        text/plain instead of JSON
 *
 * Fully offline — no third-party calls, so it cannot fail because someone
 * else's API is down.
 */
'use strict';

const { loadCatalog } = require('./_data');
const { json, methodNotAllowed } = require('./_http');
const K = require('./_keywords');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') return methodNotAllowed(res);

  const q = (req && req.query) || {};
  const limit = Math.max(1, Math.min(40, Number(q.limit) || 12));
  const asCsv = String(q.format || '').toLowerCase() === 'csv';

  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (err) {
    return json(res, 200, { date: K.isoDate(), keywords: [], meta: '', seasonal: [], total: 0, note: 'catalogue unavailable' }, 'no-store');
  }

  const out = K.generate(catalog, {
    limit,
    store: q.store,
    category: q.category,
    date: q.date
  });

  const payload = {
    date: K.isoDate(q.date),
    keywords: out.keywords,
    meta: out.meta,
    seasonal: out.seasonal,
    total: out.total,
    store: q.store || null,
    category: q.category || null
  };

  if (asCsv) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).end(out.meta);
  }

  return json(res, 200, payload, 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
};
