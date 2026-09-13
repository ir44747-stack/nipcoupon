#!/usr/bin/env node
/**
 * NIPCOUPON health check — the supervisor routine, runnable without a human.
 *
 *   node scripts/health-check.js              # local checks only
 *   node scripts/health-check.js --live       # also probe the deployed site
 *   node scripts/health-check.js --json       # machine-readable report
 *
 * Exit 0 = healthy, 1 = at least one check failed. Designed to be the single
 * command a scheduled workflow runs, so the checks live in the repo and are
 * reviewable rather than buried in YAML.
 *
 * WHY THIS EXISTS
 * ---------------
 * An LLM agent cannot run on a timer: it executes only when invoked, and holds
 * no process between turns. Anything that must happen "every hour" has to be a
 * scheduled job. This script is that job's body — it encodes the same checks a
 * human (or agent) would run by hand, so the monitoring keeps working whether
 * or not anyone is watching.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ARGS = new Set(process.argv.slice(2));
const LIVE = ARGS.has('--live');
const AS_JSON = ARGS.has('--json');
const SITE = (process.env.SITE_URL || 'https://nipcoupon.vercel.app').replace(/\/+$/, '');

const failures = [];
const warnings = [];
const notes = [];
const fail = (area, msg) => failures.push(area + ': ' + msg);
const warn = (area, msg) => warnings.push(area + ': ' + msg);
const note = (area, msg) => notes.push(area + ': ' + msg);

/* ── 1. syntax ───────────────────────────────────────────────────────────── */
function walkJs(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walkJs(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  });
  return out;
}

function checkSyntax() {
  const files = walkJs(path.join(ROOT, 'api')).concat(walkJs(path.join(ROOT, 'scripts')));
  let bad = 0;
  files.forEach(f => {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { bad++; fail('syntax', f.replace(ROOT + '/', '') + ' — ' + String(e.stderr || '').split('\n')[0]); }
  });
  note('syntax', files.length + ' JS files checked, ' + bad + ' failing');

  /* index.html carries the whole SPA inline; a syntax error there is invisible
     to `node --check` on the repo's .js files and takes the site down. */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
  inline.forEach(([, attrs, body], i) => {
    if (!body.trim()) return;
    const type = (String(attrs).match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [, ''])[1].toLowerCase();
    try {
      if (type && !/^(module|text\/javascript|application\/javascript)$/.test(type)) {
        if (/json/.test(type)) JSON.parse(body);       // ld+json is data, not code
      } else {
        new Function(body);
      }
    } catch (e) { fail('syntax', 'index.html inline script #' + i + ' — ' + e.message); }
  });
  note('syntax', inline.length + ' inline scripts in index.html checked');
}

/* ── 2. data files ───────────────────────────────────────────────────────── */
function checkJson() {
  const files = []
    .concat(fs.readdirSync(path.join(ROOT, 'data')).filter(f => f.endsWith('.json')).map(f => 'data/' + f))
    .concat(fs.readdirSync(path.join(ROOT, 'locales')).filter(f => f.endsWith('.json')).map(f => 'locales/' + f))
    .concat(['package.json', 'vercel.json', 'site.webmanifest'].filter(f => fs.existsSync(path.join(ROOT, f))));
  files.forEach(f => {
    try { JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
    catch (e) { fail('json', f + ' — ' + e.message); }
  });
  note('json', files.length + ' JSON files parsed');

  try {
    const en = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8')));
    const ar = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/ar.json'), 'utf8'))));
    const missing = en.filter(k => !ar.has(k));
    if (missing.length) warn('i18n', missing.length + ' keys missing from ar.json: ' + missing.slice(0, 5).join(', '));
    else note('i18n', 'parity ' + en.length + '/' + ar.size);
  } catch (e) { fail('i18n', e.message); }
}

/* ── 3. routes + schema ──────────────────────────────────────────────────── */
async function checkRoutes() {
  const handler = require(path.join(ROOT, 'api', 'page.js'));
  const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
  const stores = read('stores.json').stores;
  const coupons = read('coupons.json').coupons;
  const cats = read('categories.json').categories;
  let posts = [];
  try { posts = read('posts.json').posts || []; } catch (e) { /* optional */ }

  const render = q => new Promise(resolve => {
    let out = '', code = 200;
    const res = {
      setHeader() {},
      get statusCode() { return code; }, set statusCode(v) { code = v; },
      status(c) { code = c; return res; },
      write(s) { out += s; },
      end(s) { out += (s || ''); resolve({ out, code }); }
    };
    Promise.resolve(handler({ url: '/api/page', query: q, headers: { host: 'nipcoupon.vercel.app' }, method: 'GET' }, res))
      .catch(e => resolve({ out: 'ERR:' + e.message, code: 500 }));
  });

  const routes = [{ type: 'blog' }]
    .concat(posts.map(p => ({ type: 'blog', id: p.slug })))
    .concat(cats.map(c => ({ type: 'category', id: c.id })))
    .concat(stores.map(s => ({ type: 'store', id: s.id })))
    .concat(coupons.map(c => ({ type: 'coupon', id: c.id })));

  const dec = x => x.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  let badLd = 0, dangling = 0, faqHidden = 0, relBad = 0, relTotal = 0;
  let noH1 = 0, skipped = 0, longTitle = 0, longDesc = 0;
  const titles = new Map();

  for (const q of routes) {
    const { out } = await render(q);
    const label = q.type + (q.id ? '/' + q.id : '');
    if (out.startsWith('ERR:')) { fail('route', label + ' — ' + out.slice(4, 120)); continue; }

    const m = out.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) { badLd++; fail('schema', label + ' — no JSON-LD'); }
    else {
      let graph;
      try { graph = JSON.parse(m[1])['@graph'] || []; }
      catch (e) { badLd++; fail('schema', label + ' — JSON-LD does not parse'); graph = []; }

      const ids = new Set(graph.map(n => n['@id']).filter(Boolean));
      (function walk(node) {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        Object.keys(node).forEach(k => {
          const v = node[k];
          if (v && typeof v === 'object' && Object.keys(v).length === 1 && v['@id']) {
            if (!ids.has(v['@id']) && !/#(organization|website)/.test(v['@id'])) {
              dangling++; fail('schema', label + ' — dangling @id ' + v['@id']);
            }
          } else walk(v);
        });
      })(graph);

      /* FAQPage is only legal when the answer is visible to the user. */
      const faq = graph.find(n => n['@type'] === 'FAQPage');
      if (faq) {
        const visible = dec(out.replace(/<script[\s\S]*?<\/script>/g, ''));
        (faq.mainEntity || []).forEach(x => {
          if (!visible.includes(x.name) || !visible.includes(x.acceptedAnswer.text)) {
            faqHidden++; fail('schema', label + ' — FAQ item not visible on page: ' + String(x.name).slice(0, 48));
          }
        });
      }
    }

    /* Monetised links must be marked, or we are passing PageRank to merchants.
       Match ANY external anchor, not just sovrn.co: without SOVRN_API_KEY set,
       store.url keeps its ${SOVRN_API_KEY} placeholder and resolves to the bare
       merchant domain, so a sovrn-only pattern matched zero links and reported
       "0/0 compliant" — a check that silently inspects nothing. */
    [...out.matchAll(/<a\b[^>]*href="https?:\/\/[^"]+"[^>]*>/gi)].forEach(a => {
      const href = (a[0].match(/href="([^"]+)"/) || [, ''])[1];
      let host = '';
      try { host = new URL(href).hostname.replace(/^www\./, ''); } catch (e) { return; }
      if (/nipcoupon/.test(host)) return;              // internal, must stay followable
      relTotal++;
      const rel = (a[0].match(/rel="([^"]*)"/) || [, ''])[1];
      if (!(/nofollow/.test(rel) && /sponsored/.test(rel) && /noopener/.test(rel))) {
        relBad++; fail('affiliate', label + ' — outbound ' + host + ' missing rel tokens: "' + rel + '"');
      }
    });

    const levels = [...out.matchAll(/<(h[1-6])[^>]*>/gi)].map(x => +x[1][1]);
    if (levels.filter(l => l === 1).length !== 1) { noH1++; warn('headings', label + ' — ' + levels.filter(l => l === 1).length + ' H1 tags'); }
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i - 1] > 1) { skipped++; warn('headings', label + ' — skips h' + levels[i - 1] + ' to h' + levels[i]); break; }
    }

    const t = dec((out.match(/<title>([^<]*)<\/title>/) || [, ''])[1]);
    const d = dec((out.match(/name="description" content="([^"]*)"/) || [, ''])[1]);
    if (t.length > 62) { longTitle++; warn('meta', label + ' — title ' + t.length + ' chars'); }
    if (d.length > 155) { longDesc++; warn('meta', label + ' — description ' + d.length + ' chars'); }
    titles.set(t, (titles.get(t) || 0) + 1);
  }

  const dupes = [...titles.entries()].filter(([, n]) => n > 1);
  if (dupes.length) warn('meta', dupes.length + ' duplicate titles, e.g. "' + dupes[0][0].slice(0, 48) + '"');

  note('routes', routes.length + ' rendered, ' + badLd + ' bad JSON-LD, ' + dangling + ' dangling @id');
  note('schema', faqHidden + ' hidden FAQ items, ' + relBad + '/' + relTotal + ' non-compliant affiliate links');
  note('headings', noH1 + ' without exactly one H1, ' + skipped + ' skipping a level');
  note('meta', longTitle + ' long titles, ' + longDesc + ' long descriptions');
}

/* ── 4. sitemap ──────────────────────────────────────────────────────────── */
function checkSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  let total = 0, future = 0, files = 0;
  fs.readdirSync(ROOT).filter(f => /^sitemap.*\.xml$/.test(f)).forEach(f => {
    files++;
    const xml = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lm = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]);
    total += lm.length;
    lm.forEach(v => { if (v.slice(0, 10) > today) { future++; fail('sitemap', f + ' — future lastmod ' + v); } });
    if (!/<\/(urlset|sitemapindex)>/.test(xml)) fail('sitemap', f + ' — malformed, no closing tag');
  });
  note('sitemap', files + ' files, ' + total + ' lastmod values, ' + future + ' in the future');

  const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  if (!/Sitemap:/i.test(robots)) fail('robots', 'robots.txt lists no sitemap');
  if (/^\s*Disallow:\s*\/\s*$/mi.test(robots)) fail('robots', 'robots.txt disallows the whole site');
}

/* ── 5. live deployment ──────────────────────────────────────────────────── */
async function checkLive() {
  const probes = [
    ['/', 200], ['/store/amazon', 200], ['/coupon/c1', 200], ['/category/tech', 200],
    ['/blog', 200], ['/robots.txt', 200], ['/sitemap.xml', 200], ['/favicon.ico', 200],
    ['/store/definitely-not-a-real-store', 404]
  ];
  for (const [p, want] of probes) {
    try {
      const r = await fetch(SITE + p, { redirect: 'follow' });
      if (r.status !== want) fail('live', p + ' returned ' + r.status + ', expected ' + want);
      if (p === '/') {
        const html = await r.text();
        /* A truncated index.html has happened before and served HTTP 200. */
        if (!/<\/html>/i.test(html)) fail('live', 'homepage HTML is truncated — no closing </html>');
        if (html.length < 20000) fail('live', 'homepage is only ' + html.length + ' bytes — suspiciously small');
      }
    } catch (e) { fail('live', p + ' — ' + e.message); }
  }
  note('live', probes.length + ' production routes probed at ' + SITE);
}

/* ── run ─────────────────────────────────────────────────────────────────── */
(async function main() {
  checkSyntax();
  checkJson();
  await checkRoutes();
  checkSitemap();
  if (LIVE) await checkLive();

  const report = {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    failures, warnings, notes
  };

  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log('\nNIPCOUPON health check · ' + report.checkedAt);
    console.log('─'.repeat(56));
    notes.forEach(n => console.log('  · ' + n));
    if (warnings.length) { console.log('\n  warnings (' + warnings.length + '):'); warnings.slice(0, 20).forEach(w => console.log('    ! ' + w)); }
    if (failures.length) { console.log('\n  FAILURES (' + failures.length + '):'); failures.slice(0, 30).forEach(f => console.log('    ✗ ' + f)); }
    console.log('\n  ' + (report.ok ? 'HEALTHY — all checks passed' : 'UNHEALTHY — ' + failures.length + ' failure(s)') + '\n');
  }

  process.exit(report.ok ? 0 : 1);
})();
