#!/usr/bin/env node
/**
 * inventory.js — store-by-store offer inventory, plus the alerts that matter.
 *
 *   node scripts/inventory.js              # table, thinnest stores first
 *   node scripts/inventory.js --json       # machine-readable
 *   node scripts/inventory.js --alerts     # exit 1 if any CRITICAL alert fires
 *
 * The point is to make an inventory problem visible before a shopper finds it.
 * Everything here is derived from data already in the repo — no estimates, no
 * modelled numbers. Where a figure is unavailable (affiliate EPC, click
 * performance) the column reads "—" rather than 0, because zero is a claim and
 * "we were never told" is the truth.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const O = require('../api/_offers.js');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const ALERTS_ONLY = ARGS.includes('--alerts');

const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

const stores = read('stores.json').stores;
const coupons = read('coupons.json').coupons;
let sources = [];
try { sources = read('sources.json').sources || []; } catch (e) { /* registry optional */ }

const storeById = {};
stores.forEach(s => { storeById[s.id] = s; });
const srcById = {};
sources.forEach(s => { srcById[s.id] = s; });

const canon = coupons.map(c =>
  O.canonical(c, srcById[c.source] || { id: c.source || 'local', priority: 1 }, storeById[c.storeId]));
const { all } = O.reconcile(canon, { storeIds: new Set(stores.map(s => s.id)) });

const byStore = {};
all.forEach(o => { (byStore[o.storeId] = byStore[o.storeId] || []).push(o); });

const rows = stores.map(s => {
  const l = byStore[s.id] || [];
  const count = st => l.filter(o => o.verificationStatus === st).length;
  const freshest = l.reduce((m, o) => {
    const h = O.hoursSince(o.verifiedAt);
    return h !== null && (m === null || h < m) ? h : m;
  }, null);
  return {
    id: s.id,
    name: s.name,
    total: l.length,
    verified: count(O.STATUS.VERIFIED),
    pending: count(O.STATUS.PENDING),
    unknown: count(O.STATUS.UNKNOWN),
    expired: count(O.STATUS.EXPIRED),
    rejected: count(O.STATUS.REJECTED),
    sources: [...new Set(l.map(o => o.source))],
    lastVerifiedHours: freshest === null ? null : Math.round(freshest),
    epc: s.sovrnEpc !== undefined && s.sovrnEpc !== null ? s.sovrnEpc : null,
    indexable: l.some(o => o.verificationStatus === O.STATUS.VERIFIED ||
                           o.verificationStatus === O.STATUS.UNKNOWN ||
                           o.verificationStatus === O.STATUS.PENDING)
  };
});

/* ── alerts ──────────────────────────────────────────────────────────────────
 * CRITICAL means revenue or trust is affected right now. WARNING means it will
 * be soon. Thresholds are deliberately concrete so they can be argued with. */
const alerts = [];
const add = (level, code, msg) => alerts.push({ level, code, msg });

const stocked = rows.filter(r => r.total > 0);
const emptyStores = rows.filter(r => r.total === 0);
const single = stocked.filter(r => r.total === 1);

if (!stocked.length) add('CRITICAL', 'catalogue-empty', 'No store has a single offer — the site has nothing to sell.');
if (emptyStores.length) {
  add('INFO', 'stores-empty',
    emptyStores.length + ' of ' + rows.length + ' stores have zero offers (correctly noindex, no crawl cost).');
}
if (single.length) {
  add(single.length === stocked.length ? 'WARNING' : 'INFO', 'single-offer',
    single.length + ' store(s) carry exactly one offer — thin inventory caps both revenue and page depth.');
}

const expiredTotal = rows.reduce((n, r) => n + r.expired, 0);
if (expiredTotal) add('WARNING', 'expired-live', expiredTotal + ' offer(s) are past their expiry and still in coupons.json — run `npm run prune`.');

const rejectedTotal = rows.reduce((n, r) => n + r.rejected, 0);
if (rejectedTotal) add('CRITICAL', 'rejected-offers', rejectedTotal + ' offer(s) fail the quality gate — inspect before they reach a page.');

const staleStores = stocked.filter(r => r.lastVerifiedHours !== null && r.lastVerifiedHours > O.VERIFY_WINDOW_HOURS);
if (staleStores.length) {
  add('WARNING', 'verification-stale',
    staleStores.length + ' store(s) have no offer verified inside ' + O.VERIFY_WINDOW_HOURS + 'h: ' +
    staleStores.slice(0, 6).map(r => r.id).join(', '));
}

const neverVerified = rows.reduce((n, r) => n + r.pending, 0);
if (neverVerified) add('WARNING', 'never-verified', neverVerified + ' offer(s) have never been verified.');

const activeSources = sources.filter(s => s.enabled);
if (activeSources.length <= 1) {
  add('WARNING', 'single-source',
    'Only ' + activeSources.length + ' offer source is enabled (' +
    (activeSources.map(s => s.id).join(', ') || 'none') +
    '). Inventory cannot grow and has no redundancy if it stops.');
}
sources.filter(s => !s.enabled).forEach(s => {
  add('INFO', 'source-disabled', s.id + ': ' + s.status + (s.requiresCredential ? ' — needs ' + s.requiresCredential : ''));
});

const report = {
  checkedAt: new Date().toISOString(),
  totals: {
    stores: rows.length,
    stocked: stocked.length,
    empty: emptyStores.length,
    offers: all.length,
    verified: rows.reduce((n, r) => n + r.verified, 0),
    pending: neverVerified,
    unknown: rows.reduce((n, r) => n + r.unknown, 0),
    expired: expiredTotal,
    rejected: rejectedTotal,
    sourcesEnabled: activeSources.length,
    sourcesRegistered: sources.length
  },
  alerts,
  stores: rows
};

if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); }
else {
  const t = report.totals;
  console.log('\nNipCoupon inventory · ' + report.checkedAt);
  console.log('─'.repeat(78));
  console.log('  stores ' + t.stores + '  (stocked ' + t.stocked + ' · empty ' + t.empty + ')');
  console.log('  offers ' + t.offers + '  (verified ' + t.verified + ' · pending ' + t.pending +
              ' · unknown ' + t.unknown + ' · expired ' + t.expired + ' · rejected ' + t.rejected + ')');
  console.log('  sources ' + t.sourcesEnabled + ' enabled of ' + t.sourcesRegistered + ' registered');
  if (!ALERTS_ONLY) {
    console.log('');
    console.log('  ' + 'store'.padEnd(20) + 'tot'.padStart(4) + 'ver'.padStart(4) + 'pend'.padStart(5) +
                'unk'.padStart(4) + 'exp'.padStart(4) + 'rej'.padStart(4) + '  lastVer'.padEnd(10) + 'epc'.padStart(5) + '  source');
    rows.sort((a, b) => a.total - b.total || a.id.localeCompare(b.id)).slice(0, 16).forEach(r => {
      console.log('  ' + r.id.slice(0, 19).padEnd(20) + String(r.total).padStart(4) + String(r.verified).padStart(4) +
        String(r.pending).padStart(5) + String(r.unknown).padStart(4) + String(r.expired).padStart(4) +
        String(r.rejected).padStart(4) + '  ' + (r.lastVerifiedHours === null ? '—' : r.lastVerifiedHours + 'h').padEnd(8) +
        (r.epc === null ? '—' : String(r.epc)).padStart(5) + '  ' + (r.sources.join(',') || '—'));
    });
  }
  console.log('\n  ALERTS');
  if (!alerts.length) console.log('    none');
  alerts.forEach(a => console.log('    [' + a.level + '] ' + a.code + ' — ' + a.msg));
  console.log('');
}

process.exit(alerts.some(a => a.level === 'CRITICAL') ? 1 : 0);
