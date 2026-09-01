#!/usr/bin/env node
/**
 * Local preview server that mimics the Vercel runtime:
 *   • serves the static site from the project root
 *   • routes /api/* to the same serverless handlers Vercel uses
 *
 *   node scripts/preview-server.js        # http://localhost:3000
 *   PORT=8080 node scripts/preview-server.js
 *
 * Zero dependencies — uses only the Node standard library.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const ROUTES = {
  '/api/catalog': 'catalog.js',
  '/api/deals': 'deals.js',
  '/api/stores': 'stores.js',
  '/api/categories': 'categories.js',
  '/api/regions': 'regions.js',
  '/api/geo': 'geo.js',
  '/api/i18n': 'i18n.js'
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}

/** Adapt a plain Node response to the (req, res) shape Vercel handlers expect. */
function fakeRes(res) {
  return {
    status(code) { res.statusCode = code; return this; },
    setHeader(k, v) { res.setHeader(k, v); return this; },
    end(body) { res.end(body); return this; },
    json(body) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return this; }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (ROUTES[pathname]) {
      const handler = require(path.join(ROOT, 'api', ROUTES[pathname]));
      const query = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      return handler({ method: req.method, query, url: req.url, headers: req.headers }, fakeRes(res));
    }
    if (/^\/api\/deals\/[^/]+$/.test(pathname)) {
      const handler = require(path.join(ROOT, 'api', 'deals', '[id].js'));
      return handler({ method: req.method, query: { id: pathname.split('/').pop() }, headers: req.headers }, fakeRes(res));
    }
    /* Mirror the vercel.json rewrites so /coupon/:id works locally too. */
    const seo = /^\/(coupon|store|category)\/([^/]+)$/.exec(pathname);
    if (seo) {
      const handler = require(path.join(ROOT, 'api', 'page.js'));
      return handler({ method: req.method, query: { type: seo[1], id: seo[2] }, headers: req.headers }, fakeRes(res));
    }
    if (pathname === '/api/page') {
      const handler = require(path.join(ROOT, 'api', 'page.js'));
      const query = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      return handler({ method: req.method, query, headers: req.headers }, fakeRes(res));
    }
    if (pathname.startsWith('/api/')) return send(res, 404, JSON.stringify({ error: 'Unknown endpoint' }));

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    send(res, 500, JSON.stringify({ error: 'Server error', detail: err.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log('NipCoupon preview  →  http://localhost:' + PORT);
  console.log('  static site : /');
  console.log('  api         : /api/catalog · /api/deals · /api/deals/:id · /api/stores · /api/categories');
  console.log('                /api/regions · /api/geo · /api/i18n');
});
