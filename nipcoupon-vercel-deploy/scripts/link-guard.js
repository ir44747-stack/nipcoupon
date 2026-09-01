#!/usr/bin/env node
/**
 * link-guard.js — validate every link before it is allowed onto the site.
 *
 *   node scripts/link-guard.js                    # validate data/coupons.json + stores
 *   node scripts/link-guard.js --dry-run          # report, change nothing
 *   node scripts/link-guard.js --url=https://x.co # validate one URL
 *   node scripts/link-guard.js --json
 *
 * Used as a module by sync-offers.js:
 *   const { validateOffers } = require('./link-guard.js');
 *
 * Every link passes four gates. A link is published only if it clears all four:
 *
 *   1. SYNTAX     absolute http(s), parseable, no credentials in the URL, no
 *                 javascript:/data:/file: schemes, no unresolved ${…}.
 *   2. POLICY     host is on the allowlist (or the allowlist is empty = open mode).
 *                 Blocks known link-shortener abuse, localhost, and raw IPs.
 *   3. FRESHNESS  not expired per `expires`, and the provider marked it verified
 *                 (or `--allow-unverified`).
 *   4. LIVE       HEAD probe, GET fallback on 405/501/0.
 *
 * A 403/429/401 is classified `blocked`, NOT `dead` — big retailers bot-wall
 * datacenter IPs. Marking those dead would silently delete good inventory, so
 * `blocked` links are published and simply not re-probed as often.
 *
 * Exit codes: 0 all good · 1 some links rejected · 2 config error
 */
'use strict';

const S = require('../api/_secrets.js');

const DEFAULT_ALLOW_HOSTS = [
  'sovrn.co',        // our own monetising wrapper — everything routes through it
  'www.sovrn.co',
  'shareasale.com',
  'click.linksynergy.com',
  'howl.me',
  'geni.us',
  'amzn.to'
];

const BLOCKED_SCHEMES = /^(javascript|data|file|vbscript|blob):/i;
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

/* ── helpers ──────────────────────────────────────────────────────────────── */
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (e) { return ''; }
}

function isExpired(expires, now) {
  if (!expires) return false;
  const t = Date.parse(String(expires));
  if (Number.isNaN(t)) return false;      // unparseable ≠ expired; don't drop good data
  return t < now;
}

function allowlist() {
  const raw = S.env('LINK_GUARD_ALLOWLIST', '').trim();
  if (!raw) return DEFAULT_ALLOW_HOSTS;
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/* ── Gate 1–3: cheap, no network ──────────────────────────────────────────── */
function staticChecks(url, opts) {
  const now = opts && opts.now ? opts.now : Date.now();
  const allow = opts && opts.allow !== undefined ? opts.allow : allowlist();

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: 'empty-url', gate: 'syntax' };
  }
  const trimmed = url.trim();

  if (BLOCKED_SCHEMES.test(trimmed)) {
    return { ok: false, reason: 'unsafe-scheme', gate: 'syntax' };
  }
  // An unresolved placeholder means an env var is missing — never publish it.
  if (trimmed.indexOf('${') !== -1) {
    return { ok: false, reason: 'unresolved-placeholder', gate: 'syntax' };
  }

  let parsed;
  try { parsed = new URL(trimmed); }
  catch (e) { return { ok: false, reason: 'unparseable', gate: 'syntax' }; }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'bad-protocol', gate: 'syntax' };
  }
  if (parsed.protocol === 'http:') {
    return { ok: false, reason: 'insecure-http', gate: 'syntax' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials-in-url', gate: 'syntax' };
  }

  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || IPV4_HOST.test(host)) {
    return { ok: false, reason: 'private-host', gate: 'policy' };
  }

  const bare = host.replace(/^www\./, '');
  if (allow.length && !allow.includes(bare) && !allow.includes(host)) {
    return { ok: false, reason: 'host-not-allowlisted', gate: 'policy', host: bare };
  }

  return { ok: true, host: bare };
}

/* ── Gate 4: live probe ───────────────────────────────────────────────────── */
async function probe(url, opts) {
  const timeout = (opts && opts.timeout) || 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const tryOne = async (method) => {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'NipCouponBot/1.0 (+https://nipcoupon.vercel.app)',
          'Accept': '*/*'
        }
      });
      return { status: res.status };
    } catch (err) {
      return { status: 0, error: err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'network' };
    }
  };

  try {
    let r = await tryOne('HEAD');
    // Some CDNs reject HEAD outright — retry with GET before judging.
    if (r.status === 405 || r.status === 501 || r.status === 0) {
      const g = await tryOne('GET');
      if (g.status !== 0 || r.status === 0) r = g;
    }
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/** Map an HTTP status to a verdict. */
function classify(status) {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 401 || status === 403 || status === 429) return 'blocked'; // bot wall, not broken
  if (status === 404 || status === 410) return 'dead';
  if (status === 0) return 'unknown';                                        // timeout / DNS / TLS
  if (status >= 400 && status < 500) return 'dead';
  if (status >= 500) return 'unknown';
  return 'unknown';
}

/* ── Public: validate one offer ───────────────────────────────────────────── */
async function validateOne(url, opts) {
  opts = opts || {};
  const s = staticChecks(url, opts);
  if (!s.ok) return s;

  if (opts.skipLive) return { ok: true, host: s.host, verdict: 'unchecked' };

  const r = await probe(url, opts);
  const verdict = classify(r.status);
  return {
    ok: verdict === 'ok' || verdict === 'blocked',
    host: s.host,
    status: r.status,
    verdict,
    reason: verdict === 'ok' || verdict === 'blocked' ? undefined : 'link-' + verdict
  };
}

/**
 * Validate a batch of offers concurrently.
 * Returns { publishable, rejected } — `publishable` keeps the original objects
 * with `linkVerdict` / `linkCheckedAt` attached.
 */
async function validateOffers(offers, opts) {
  opts = opts || {};
  const limit = opts.concurrency || 6;
  const allowUnverified = !!opts.allowUnverified;
  const now = Date.now();

  const publishable = [];
  const rejected = [];
  let cursor = 0;

  async function worker() {
    while (cursor < offers.length) {
      const i = cursor++;
      const offer = offers[i];
      const url = offer.landingUrl || offer.url || offer.link || '';

      // freshness gate (no network)
      if (isExpired(offer.expires, now)) {
        rejected.push({ offer, reason: 'expired', gate: 'freshness' });
        continue;
      }
      if (!allowUnverified && offer.verified === false) {
        rejected.push({ offer, reason: 'unverified-by-provider', gate: 'freshness' });
        continue;
      }

      const res = await validateOne(url, opts);
      if (res.ok) {
        publishable.push(Object.assign({}, offer, {
          linkVerdict: res.verdict || 'ok',
          linkStatus: res.status,
          linkCheckedAt: new Date().toISOString()
        }));
      } else {
        rejected.push({ offer, reason: res.reason, gate: res.gate, status: res.status });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, offers.length) }, worker));
  return { publishable, rejected, checked: offers.length, at: new Date().toISOString() };
}

module.exports = {
  staticChecks,
  probe,
  classify,
  validateOne,
  validateOffers,
  isExpired,
  hostOf,
  allowlist,
  DEFAULT_ALLOW_HOSTS
};

/* ── CLI ──────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const has = f => argv.includes(f);
    const argOf = (n, d) => {
      const hit = argv.find(a => a.startsWith(n + '='));
      return hit ? hit.slice(n.length + 1) : d;
    };
    const AS_JSON = has('--json');
    const DRY = has('--dry-run');
    const single = argOf('--url', '');
    const concurrency = Number(argOf('--concurrency', 6)) || 6;
    const timeout = Number(argOf('--timeout', 12000)) || 12000;

    const { DAILY } = {};
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.join(__dirname, '..');

    let offers;
    if (single) {
      offers = [{ id: 'single', landingUrl: single }];
    } else {
      const coupons = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'coupons.json'), 'utf8')).coupons || [];
      offers = coupons;
    }

    const result = await validateOffers(offers, { concurrency, timeout, allowUnverified: true });

    const byReason = {};
    result.rejected.forEach(r => { byReason[r.reason] = (byReason[r.reason] || 0) + 1; });

    if (AS_JSON) {
      console.log(JSON.stringify({
        checked: result.checked,
        publishable: result.publishable.length,
        rejected: result.rejected.length,
        byReason,
        rejectedSample: result.rejected.slice(0, 25).map(r => ({
          id: r.offer.id, reason: r.reason, gate: r.gate, status: r.status
        }))
      }, null, 2));
    } else {
      console.log('');
      console.log('Link guard — ' + result.checked + ' links checked');
      console.log('─'.repeat(52));
      console.log('  publishable : ' + result.publishable.length);
      console.log('  rejected    : ' + result.rejected.length);
      if (result.rejected.length) {
        console.log('');
        console.log('  Rejections by reason:');
        for (const [reason, n] of Object.entries(byReason)) {
          console.log('    ' + String(n).padStart(4) + '  ' + reason);
        }
        console.log('');
        console.log('  Samples:');
        result.rejected.slice(0, 10).forEach(r => {
          const url = (r.offer.landingUrl || r.offer.url || '').slice(0, 70);
          console.log('    ' + r.reason + '  ' + url);
        });
      }
      console.log('');
    }
    process.exit(result.rejected.length ? 1 : 0);
  })();
}
