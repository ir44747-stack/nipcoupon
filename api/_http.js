/** Tiny helpers shared by the API handlers: CORS + JSON responses. */
'use strict';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, status, body, cacheControl) {
  cors(res);
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl || 's-maxage=60, stale-while-revalidate=300');
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res) {
  json(res, 405, { error: 'Method not allowed. Use GET.' }, 'no-store');
}

module.exports = { cors, json, methodNotAllowed };
