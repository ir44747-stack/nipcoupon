/**
 * GET /api/sovrn.js — the Sovrn Commerce tracking loader, with your publisher
 * key injected at request time.
 *
 *    <script async src="/api/sovrn.js"></script>     ← just before </body>
 *
 * WHY AN ENDPOINT AND NOT A PLAIN <script> TAG
 * --------------------------------------------
 * The Sovrn Commerce snippet needs your campaign API key inline:
 *
 *     var vglnk = { key: '21216f…' };
 *
 * Hard-coding it in index.html would commit a credential to git, ship it in
 * the deploy zip, and bake it into every backup — the exact failure this
 * project already had to clean up once. Serving the snippet from an endpoint
 * keeps the key in a Vercel environment variable: it appears only in the
 * response body, rotating it is a one-field change, and nothing in the repo
 * holds a secret.
 *
 * WHAT IT DOES
 * ------------
 * Sovrn's loader (cdn.viglink.com/api/vglnk.js) scans the rendered page and
 * rewrites qualifying merchant links into affiliate links on the fly — the
 * "Convert" behaviour. That is the dynamic half of monetisation: it catches
 * product mentions and links the catalogue does not know about. The static
 * half is server-side wrapping (sovrn.co/?key=…&u=…) which already covers all
 * 70 stores in data/stores.json.
 *
 * The two are complementary and safe to run together: Sovrn skips links that
 * are already wrapped, so no double-attribution.
 *
 * GRACEFUL DEGRADATION
 * --------------------
 * If SOVRN_API_KEY is unset the endpoint returns a comment, not an error and
 * not a script with a blank key. The page then serves plain merchant links:
 * working, just not monetised. Set the env var and it starts earning with no
 * code change.
 *
 * Performance: async loader, served with a long shared cache. It cannot block
 * first paint because it is the last thing in <body>.
 */
'use strict';

const S = require('./_secrets.js');

const LOADER = '//cdn.viglink.com/api/vglnk.js';

module.exports = function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  const key = S.env('SOVRN_API_KEY').trim();
  const cuid = S.env('SOVRN_CUID', 'nipcoupon').trim();

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  if (!key) {
    // No key configured → a valid, empty script. Never an error, never a
    // script carrying an empty key (Sovrn would reject it and log a warning).
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).end(
      '/* NipCoupon: SOVRN_API_KEY is not set — Commerce tracking disabled. ' +
      'Links work normally, they are simply not monetised. */\n'
    );
  }

  const body =
    '/* NipCoupon — Sovrn Commerce loader. Key injected server-side from env; ' +
    'it is never stored in the repository. */\n' +
    'window.vglnk = window.vglnk || {};\n' +
    'window.vglnk.key = ' + JSON.stringify(key) + ';\n' +
    (cuid ? 'window.vglnk.cuid = ' + JSON.stringify(cuid) + ';\n' : '') +
    '(function (d, t) {\n' +
    '  var s = d.createElement(t);\n' +
    '  s.type = "text/javascript";\n' +
    '  s.async = true;\n' +
    '  s.src = ' + JSON.stringify(LOADER) + ';\n' +
    '  var r = d.getElementsByTagName(t)[0];\n' +
    '  if (r && r.parentNode) r.parentNode.insertBefore(s, r);\n' +
    '}(document, "script"));\n';

  /* The key is public-by-design in the page, but caching it on shared
     infrastructure for a long time makes rotation sluggish. One hour at the
     edge is the balance. */
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).end(body);
};
