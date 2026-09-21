#!/usr/bin/env node
/**
 * content-quality.js — measures how differentiated each store page actually is.
 *
 *   node scripts/content-quality.js            # table, worst pages first
 *   node scripts/content-quality.js --json     # machine-readable
 *   node scripts/content-quality.js --min=12   # exit 1 if any INDEXED page scores below
 *
 * WHY
 * ---
 * Store pages are generated from one template, so they will always share
 * boilerplate. That is fine — what is not fine is a page whose ONLY difference
 * from 39 others is the store name. This measures the difference rather than
 * guessing at it, by rendering every store page and comparing each one against
 * the shared baseline.
 *
 * "Unique" here means: tokens on this page that do not appear on the majority
 * of other store pages. That is deliberately strict — the store name, its
 * offer titles and its real coupon conditions count; the FAQ scaffolding and
 * the nav do not.
 *
 * The score is a diagnostic, not a target. Chasing a percentage by padding
 * pages with text is exactly the failure mode this is meant to catch.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const MIN = (() => {
  const a = ARGS.find(x => x.startsWith('--min='));
  return a ? Number(a.split('=')[1]) : null;
})();

const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = t => t.toLowerCase().match(/[a-z0-9$%][a-z0-9'’$%.-]*/g) || [];

(async function main() {
  const handler = require(path.join(ROOT, 'api', 'page.js'));
  const stores = read('stores.json').stores;
  const coupons = read('coupons.json').coupons;

  const render = q => new Promise(resolve => {
    let out = '';
    const res = {
      setHeader() {}, statusCode: 200, status(c) { res.statusCode = c; return res; },
      write(s) { out += s; }, end(s) { out += (s || ''); resolve(out); }
    };
    Promise.resolve(handler({ url: '/api/page', query: q, headers: { host: 'nipcoupon.vercel.app' }, method: 'GET' }, res))
      .catch(e => resolve('ERR:' + e.message));
  });

  const pages = [];
  for (const s of stores) {
    const html = await render({ type: 'store', id: s.id });
    if (html.startsWith('ERR:')) { pages.push({ id: s.id, error: html.slice(4) }); continue; }
    const text = visibleText(html);
    const toks = tokens(text);
    const offers = coupons.filter(c => c.storeId === s.id);
    pages.push({
      id: s.id,
      name: s.name,
      indexed: !/name="robots" content="[^"]*noindex/.test(html),
      words: toks.length,
      set: new Set(toks),
      offers: offers.length,
      conditions: offers.reduce((n, c) => n + (c.terms || []).length, 0),
      faqs: (html.match(/<details class="faq"/g) || []).length,
      reasons: (html.match(/From the offer terms/g) || []).length
    });
  }

  /* Baseline = tokens present on more than half of the store pages. Anything in
     that set is scaffolding by definition, however store-flavoured it reads. */
  const freq = new Map();
  pages.filter(p => p.set).forEach(p => p.set.forEach(t => freq.set(t, (freq.get(t) || 0) + 1)));
  const half = pages.filter(p => p.set).length / 2;
  const boiler = new Set([...freq.entries()].filter(([, n]) => n > half).map(([t]) => t));

  pages.forEach(p => {
    if (!p.set) return;
    const uniq = [...p.set].filter(t => !boiler.has(t));
    p.uniqueTokens = uniq.length;
    p.uniquePct = p.set.size ? Math.round((uniq.length / p.set.size) * 1000) / 10 : 0;
    delete p.set;
  });

  const scored = pages.filter(p => !p.error);
  const indexed = scored.filter(p => p.indexed);
  const summary = {
    checkedAt: new Date().toISOString(),
    stores: scored.length,
    indexed: indexed.length,
    noindexed: scored.length - indexed.length,
    medianUniqueTokens: median(indexed.map(p => p.uniqueTokens)),
    medianUniquePct: median(indexed.map(p => p.uniquePct)),
    worst: [...indexed].sort((a, b) => a.uniqueTokens - b.uniqueTokens).slice(0, 10)
      .map(p => ({ id: p.id, uniqueTokens: p.uniqueTokens, uniquePct: p.uniquePct, offers: p.offers, conditions: p.conditions }))
  };

  const failures = MIN === null ? [] : indexed.filter(p => p.uniqueTokens < MIN);

  if (AS_JSON) {
    console.log(JSON.stringify({ summary, failures: failures.map(f => f.id), pages: scored }, null, 2));
  } else {
    console.log('\nStore page content quality · ' + summary.checkedAt);
    console.log('─'.repeat(74));
    console.log('  stores rendered   : ' + summary.stores + ' (' + summary.indexed + ' indexable, ' + summary.noindexed + ' noindex)');
    console.log('  median unique tok : ' + summary.medianUniqueTokens + '  (' + summary.medianUniquePct + '% of page tokens)');
    console.log('');
    console.log('  ' + 'store'.padEnd(22) + 'uniq'.padStart(6) + 'pct'.padStart(8) +
                'offers'.padStart(8) + 'cond'.padStart(6) + 'faq'.padStart(5) + 'why'.padStart(5) + '  idx');
    [...scored].sort((a, b) => a.uniqueTokens - b.uniqueTokens).slice(0, 18).forEach(p => {
      console.log('  ' + String(p.id).slice(0, 21).padEnd(22) +
        String(p.uniqueTokens).padStart(6) + (p.uniquePct + '%').padStart(8) +
        String(p.offers).padStart(8) + String(p.conditions).padStart(6) +
        String(p.faqs).padStart(5) + String(p.reasons).padStart(5) +
        '  ' + (p.indexed ? 'yes' : 'no'));
    });
    if (MIN !== null) {
      console.log('\n  threshold --min=' + MIN + ': ' +
        (failures.length ? failures.length + ' INDEXED page(s) below it: ' + failures.map(f => f.id).join(', ')
                         : 'all indexed pages pass'));
    }
    console.log('');
  }

  process.exit(failures.length ? 1 : 0);
})();

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}
