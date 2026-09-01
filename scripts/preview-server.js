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
 *
 * Routing is GENERIC, not a hard-coded list: any /api/<name> maps to
 * api/<name>.js (or api/<name> verbatim, so /api/sovrn.js works too). Adding an
 * endpoint needs no change here — a previous hard-coded table silently 404'd
 * /api/keywords and /api/cron until someone noticed.
 *
 * Files whose name starts with `_` are private modules (_data.js, _secrets.js,
 * _geo.js, _keywords.js). Vercel never exposes them as routes and neither do
 * we — they hold secret-handling code and must not be reachable.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
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
    json(body) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
      return this;
    }
  };
}

/**
 * Resolve /api/<name> to a handler module, or null.
 * Safe against traversal and against exposing private `_` modules.
 */
function resolveApi(pathname) {
  if (!pathname.startsWith('/api/')) return null;
  const name = pathname.slice('/api/'.length);
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return null;

  const candidates = [name + '.js', name];
  for (const c of candidates) {
    if (c.startsWith('_')) continue;                       // private module
    const file = path.join(API_DIR, c);
    if (!file.startsWith(API_DIR + path.sep)) continue;    // traversal guard
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function collectQuery(url) {
  const query = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });
  return query;
}

function invoke(file, req, url, extraQuery, res) {
  const query = Object.assign(collectQuery(url), extraQuery || {});
  let handler;
  try {
    delete require.cache[require.resolve(file)];   // pick up edits without a restart
    handler = require(file);
  } catch (err) {
    return send(res, 500, JSON.stringify({ error: 'Handler failed to load', detail: err.message }));
  }
  const fn = typeof handler === 'function' ? handler : handler.default;
  if (typeof fn !== 'function') {
    return send(res, 500, JSON.stringify({ error: 'Handler does not export a function' }));
  }
  return Promise.resolve(fn({
    method: req.method,
    query,
    url: req.url,
    headers: req.headers,
    body: undefined
  }, fakeRes(res))).catch(err => {
    send(res, 500, JSON.stringify({ error: 'Handler threw', detail: String(err && err.message || err) }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    /* 1 — explicit serverless routes */
    const apiFile = resolveApi(pathname);
    if (apiFile) return invoke(apiFile, req, url, null, res);

    /* 2 — /api/deals/:id */
    if (/^\/api\/deals\/[^/]+$/.test(pathname)) {
      const file = path.join(API_DIR, 'deals', '[id].js');
      if (fs.existsSync(file)) {
        return invoke(file, req, url, { id: decodeURIComponent(pathname.split('/').pop()) }, res);
      }
    }

    /* 3 — mirror the vercel.json rewrites so /coupon/:id works locally */
    const seo = /^\/(coupon|store|category)\/([^/]+)$/.exec(pathname);
    if (seo) {
      const file = path.join(API_DIR, 'page.js');
      if (fs.existsSync(file)) {
        return invoke(file, req, url, { type: seo[1], id: decodeURIComponent(seo[2]) }, res);
      }
    }

    if (pathname.startsWith('/api/')) {
      return send(res, 404, JSON.stringify({ error: 'Unknown endpoint', path: pathname }));
    }

    /* 4 — static files */
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
      return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
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
  console.log('  seo routes  : /coupon/:id · /store/:id · /category/:id');
  console.log('  api         : /api/<name> → api/<name>.js  (generic)');
  try {
    const list = fs.readdirSync(API_DIR)
      .filter(f => f.endsWith('.js') && !f.startsWith('_'))
      .map(f => f.replace(/\.js$/, ''))
      .sort();
    console.log('                ' + list.join(' · '));
  } catch (e) { /* ignore */ }
  console.log('  private     : api/_*.js are never routed');
});
