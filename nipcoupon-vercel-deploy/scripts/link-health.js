#!/usr/bin/env node
/**
 * NipCoupon — JOB 3 · Daily health & link check.
 *
 * For every coupon that is currently active it:
 *   · checks the expiry date      → deactivates anything already expired
 *   · HEADs the destination URL   → classifies ok / blocked / dead / unknown
 *   · deactivates after N consecutive failures (default 2, avoids a bad-day wipeout)
 *   · reactivates a coupon as soon as it recovers
 *
 * Bot walls (403/429) are treated as "blocked", not "dead" — Cloudflare and
 * friends reject HEAD requests from datacenter IPs, and punishing a working
 * coupon for that would silently delete good inventory.
 *
 * Writes:  data/coupons.json  (active, lastChecked, healthNote, consecutiveFailures)
 *          data/health.json   (machine-readable run report)
 *
 * Usage:  node scripts/link-health.js [--dry-run] [--json] [--limit=40]
 *                [--concurrency=6] [--timeout=12000] [--threshold=2]
 *                [--expired-only] [--include-inactive]
 */
'use strict';

const D = require('./_daily');

const args = D.parseArgs(process.argv);
const DRY         = D.bool(args.flags['dry-run']);
const AS_JSON     = D.bool(args.flags.json);
const LIMIT       = D.num(args.flags.limit, D.env('HEALTH_LIMIT', 0)) || Infinity;
const CONCURRENCY = D.num(args.flags.concurrency, D.env('HEALTH_CONCURRENCY', 6));
const TIMEOUT     = D.num(args.flags.timeout, D.env('HEALTH_TIMEOUT', 12000));
const THRESHOLD   = D.num(args.flags.threshold, D.env('HEALTH_THRESHOLD', 2));
const EXPIRED_ONLY = D.bool(args.flags['expired-only']);
const INCLUDE_INACTIVE = D.bool(args.flags['include-inactive']);

D.setLogMode({ json: AS_JSON });

/* ========================================================== target url === */

function targetFor(coupon, storeById) {
  if (coupon.landingUrl) return coupon.landingUrl;
  const s = storeById[coupon.storeId];
  if (!s) return '';
  return s.url || s.originalUrl || '';
}

/* =========================================================== http probe === */

/**
 * HEAD, falling back to GET when the server does not allow HEAD (405/501).
 * Follows redirects so a Sovrn wrapper URL is validated end-to-end.
 */
async function probe(url) {
  let r = await D.request(url, { method: 'HEAD', timeout: TIMEOUT, readBody: false });
  if (r.status === 405 || r.status === 501 || r.status === 0) {
    const again = await D.request(url, { method: 'GET', timeout: TIMEOUT, readBody: false });
    if (again.status) r = again;
  }
  return r;
}

/** Map an HTTP result onto a health verdict. */
function classify(res) {
  if (!res || !res.status) return 'unknown';                 // timeout / DNS / TLS
  const s = res.status;
  if (s >= 200 && s < 400) return 'ok';                      // includes 3xx redirect chains
  if (s === 403 || s === 429 || s === 401) return 'blocked';  // bot protection, not a dead link
  if (s === 404 || s === 410) return 'dead';
  if (s >= 400 && s < 500) return 'dead';
  if (s >= 500) return 'unknown';                             // server-side blip, retry next run
  return 'unknown';
}

/* ================================================================ main === */

async function main() {
  const started = Date.now();
  const today = D.todayISO();

  const rawCoupons = D.readData('coupons.json', { coupons: [] });
  const coupons = rawCoupons.coupons || [];
  const stores = D.readData('stores.json', { stores: [] }).stores || [];
  const storeById = {};
  stores.forEach(s => { storeById[s.id] = s; });

  D.step('NipCoupon — link health · ' + today);
  D.info('coupons: ' + coupons.length + ' · fail threshold: ' + THRESHOLD + ' consecutive run(s)');

  /* --- 1. expiry sweep (no network needed) ---------------------------- */
  let expiredCount = 0;
  coupons.forEach(c => {
    const days = D.daysUntil(c.expires);
    if (!Number.isNaN(days) && days < 0) {
      if (c.active !== false) {
        c.active = false;
        c.healthNote = 'expired on ' + c.expires;
        c.lastChecked = today;
        expiredCount++;
      }
    }
  });
  if (expiredCount) D.ok('expired sweep: deactivated ' + expiredCount + ' coupon(s)');
  else D.info('expired sweep: nothing past its end date');

  if (EXPIRED_ONLY) {
    const report = { job: 'health', date: today, mode: 'expired-only', expired: expiredCount, durationMs: Date.now() - started };
    if (!DRY) { D.backup('coupons', rawCoupons); D.writeData('coupons.json', rawCoupons); }
    if (AS_JSON) console.log(JSON.stringify(report, null, 2));
    return report;
  }

  /* --- 2. live URL probe ---------------------------------------------- */
  const toCheck = coupons.filter(c => (INCLUDE_INACTIVE ? true : c.active !== false));
  const queue = toCheck.slice(0, LIMIT === Infinity ? toCheck.length : LIMIT);

  D.info('probing ' + queue.length + ' URL(s), ' + CONCURRENCY + ' at a time');

  const results = await D.pool(queue, CONCURRENCY, async coupon => {
    const url = targetFor(coupon, storeById);
    if (!url) return { coupon, verdict: 'unknown', detail: 'no destination URL', status: 0, url: '' };
    const res = await probe(url);
    return {
      coupon,
      verdict: classify(res),
      detail: res.error ? res.error : ('HTTP ' + res.status),
      status: res.status,
      url: url
    };
  });

  /* --- 3. apply state transitions ------------------------------------- */
  const tally = { ok: 0, blocked: 0, dead: 0, unknown: 0, noUrl: 0 };
  let deactivated = 0;
  let reactivated = 0;
  const details = [];

  results.forEach(r => {
    if (!r) return;
    const c = r.coupon;
    const wasActive = c.active !== false;
    tally[r.verdict === 'unknown' && r.status === 0 && r.detail === 'no destination URL' ? 'noUrl' : r.verdict]++;

    c.lastChecked = today;

    if (r.verdict === 'ok' || r.verdict === 'blocked') {
      c.consecutiveFailures = 0;
      c.healthNote = r.verdict === 'blocked' ? 'bot-protected (' + r.detail + ') — not treated as broken' : '';
      if (!wasActive) { c.active = true; reactivated++; }
    } else {
      c.consecutiveFailures = (Number(c.consecutiveFailures) || 0) + 1;
      c.healthNote = r.detail;
      if (wasActive && c.consecutiveFailures >= THRESHOLD) {
        c.active = false;
        deactivated++;
      }
    }

    details.push({
      id: c.id,
      storeId: c.storeId,
      verdict: r.verdict,
      status: r.status,
      detail: r.detail,
      failures: c.consecutiveFailures,
      active: c.active !== false
    });
  });

  D.info('verdicts — ok: ' + tally.ok + ' · blocked: ' + tally.blocked
       + ' · dead: ' + tally.dead + ' · unknown: ' + tally.unknown
       + ' · no-url: ' + tally.noUrl);
  if (deactivated) D.ok('deactivated ' + deactivated + ' coupon(s)');
  if (reactivated) D.ok('reactivated ' + reactivated + ' recovered coupon(s)');

  /* --- 4. persist ------------------------------------------------------ */
  const activeNow = coupons.filter(c => c.active !== false).length;
  const report = {
    job: 'health',
    date: today,
    checked: results.length,
    verdicts: tally,
    expired: expiredCount,
    deactivated,
    reactivated,
    activeCoupons: activeNow,
    inactiveCoupons: coupons.length - activeNow,
    threshold: THRESHOLD,
    durationMs: Date.now() - started,
    details
  };

  if (DRY) {
    D.ok('dry run — no files written');
    if (AS_JSON) { report.dryRun = true; console.log(JSON.stringify(report, null, 2)); }
    return report;
  }

  D.backup('coupons', rawCoupons);
  D.writeData('coupons.json', rawCoupons);
  D.writeData('health.json', report);
  D.ok('wrote data/coupons.json + data/health.json · ' + activeNow + '/' + coupons.length + ' active');

  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  return report;
}

main().catch(e => {
  D.fail('link health crashed — ' + ((e && e.message) || e));
  process.exit(1);
});
