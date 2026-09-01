#!/usr/bin/env node
/**
 * check-geo.js — regression test for the geo-localisation engine.
 *
 *   node scripts/check-geo.js          # human-readable report
 *   node scripts/check-geo.js --json   # machine-readable
 *
 * Localisation is the one feature where a bug is both silent and expensive:
 * a bad rule turns a monetised affiliate link into either a 404 or a plain
 * link with the commission stripped. Neither shows up in a browser test. So
 * this checks the properties that actually matter, across every store and
 * every region:
 *
 *   1. every localised URL is still a valid http(s) URL
 *   2. if the input was Sovrn-wrapped, the output still is — and still carries
 *      the key. This is the bug that would cost real money.
 *   3. the host actually changed only when a rule said it should
 *   4. no URL grew a duplicated path prefix when localised twice (idempotence)
 *   5. no ${PLACEHOLDER} survives into any output
 *   6. the client-side localiser in index.html produces byte-identical output
 *      to api/_geo.js — they are two implementations of the same rule set and
 *      drift between them would be invisible in production
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('../api/_secrets.js');
const G = require('../api/_geo.js');

const ROOT = path.join(__dirname, '..');
const AS_JSON = process.argv.includes('--json');

const log = AS_JSON ? () => {} : (...a) => console.log(...a);
const fail = [];
const warn = [];

function check(cond, msg) { if (!cond) fail.push(msg); }

/* ── load ────────────────────────────────────────────────────────────────── */

const stores = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stores.json'), 'utf8')).stores || [];
const rules = G.loadRules();
const regions = Object.keys(rules.profiles);

log('');
log('geo check — ' + stores.length + ' stores × ' + regions.length + ' regions');
log('─'.repeat(52));

/* ── 1–5: server engine over the full matrix ─────────────────────────────── */

let localised = 0;
let wrappedIn = 0;
let wrappedOut = 0;
let placeholderLeaks = 0;

for (const s of stores) {
  const base = S.resolveUrl(s.url, s.originalUrl || '');
  if (!base) { warn.push(s.id + ': no resolvable URL'); continue; }
  const wasWrapped = !!G.unwrapSovrn(base);

  for (const r of regions) {
    if (wasWrapped) wrappedIn++;
    const out = G.localizeUrl(base, r);
    const url = out.url;

    // 1 — still a usable URL
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      check(false, s.id + '/' + r + ': not a valid URL — ' + url);
      continue;
    }
    check(u.protocol === 'https:' || u.protocol === 'http:',
      s.id + '/' + r + ': unsafe protocol ' + u.protocol);

    // 2 — monetisation survives
    const nowWrapped = !!G.unwrapSovrn(url);
    if (wasWrapped) {
      check(nowWrapped, s.id + '/' + r + ': LOST the Sovrn wrapper (commission stripped)');
      if (nowWrapped) {
        wrappedOut++;
        const key = u.searchParams.get('key');
        check(!!key, s.id + '/' + r + ': Sovrn wrapper has no key');
        check(u.searchParams.get('cuid') === (S.env('SOVRN_CUID', 'nipcoupon') || 'nipcoupon'),
          s.id + '/' + r + ': cuid lost');
      }
    }

    /* 3 — the INNER host may change (amazon.com → amazon.ae); the outer host
       must stay sovrn.co. Compare inner hosts, or this reports nothing when
       every link is wrapped — which is exactly our case. */
    /* Note the two contracts: api/_geo.js → { wrapper, target };
       the in-page helper in index.html → a URL. Both are correct for their
       caller; mixing them up silently returns '' and the check passes vacuously. */
    const innerOf = str => {
      const w = G.unwrapSovrn(str);
      try { return new URL(w ? w.target : str).hostname; } catch (e) { return ''; }
    };
    const origHost = innerOf(base);
    const newHost = innerOf(url);
    if (newHost !== origHost) {
      const k = origHost.replace(/^www\./, '');
      const v = rules.domainVariants[k];
      check(!!(v && v[r]),
        s.id + '/' + r + ': inner host changed ' + origHost + ' → ' + newHost + ' with no rule');
      localised++;
    }

    // 4 — idempotence
    const twice = G.localizeUrl(url, r).url;
    check(twice === url, s.id + '/' + r + ': not idempotent\n    once: ' + url + '\n    twice: ' + twice);

    // 5 — no unresolved placeholders
    if (/\$\{[A-Z0-9_]+\}/.test(url)) {
      placeholderLeaks++;
      check(false, s.id + '/' + r + ': unresolved ${…} placeholder');
    }
  }
}

log('  URLs checked        : ' + (stores.length * regions.length));
log('  host localisations  : ' + localised);
log('  sovrn wrappers in   : ' + wrappedIn);
log('  sovrn wrappers out  : ' + wrappedOut);
if (wrappedIn !== wrappedOut) {
  fail.push('wrapper count changed: ' + wrappedIn + ' in, ' + wrappedOut + ' out');
}
if (placeholderLeaks) fail.push(placeholderLeaks + ' unresolved ${…} placeholder(s)');

/* ── 6: client/server parity ─────────────────────────────────────────────── */

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function grabJs(sig) {
  const i = html.indexOf(sig);
  if (i < 0) return null;
  let depth = 0;
  for (let k = html.indexOf('{', i); k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); }
  }
  return null;
}

const needed = ['function hostKey(', 'function unwrapSovrn(', 'function clientLocalizeUrl('];
const parts = needed.map(grabJs);
const haveClient = parts.every(Boolean);

let parityChecked = 0;
if (!haveClient) {
  warn.push('could not extract the client localiser from index.html — parity not checked');
} else {
  const client = new Function('location', 'URL',
    'const GEO={code:"",profile:null,rules:null};\n' + parts.join('\n') +
    '\nreturn {GEO,clientLocalizeUrl};'
  )({ href: 'https://nipcoupon.vercel.app/' }, URL);

  client.GEO.rules = {
    domainVariants: rules.domainVariants,
    pathVariants: rules.pathVariants,
    currencyParams: rules.currencyParams
  };

  for (const s of stores) {
    const base = S.resolveUrl(s.url, s.originalUrl || '');
    if (!base) continue;
    for (const r of regions) {
      client.GEO.code = r;
      client.GEO.profile = rules.profiles[r];
      const c = client.clientLocalizeUrl(base);
      const v = G.localizeUrl(base, r).url;
      parityChecked++;
      if (c !== v) {
        fail.push('client/server mismatch ' + s.id + '/' + r + '\n    client: ' + c + '\n    server: ' + v);
      }
    }
  }
  log('  parity comparisons  : ' + parityChecked);
}

/* ── substitution sanity ─────────────────────────────────────────────────── */

let subs = 0;
for (const r of regions) {
  for (const s of stores) {
    if (G.serves(s, r)) continue;
    const sub = G.substituteFor(s.id, r, stores);
    if (sub) {
      subs++;
      const target = stores.find(x => x.id === sub);
      check(!!target, r + ': substitute "' + sub + '" for ' + s.id + ' does not exist');
      check(sub !== s.id, r + ': ' + s.id + ' substitutes to itself');
    }
  }
}
log('  substitutions       : ' + subs);

/* ── report ──────────────────────────────────────────────────────────────── */

warn.forEach(w => log('  ! warn  ' + w));

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: fail.length === 0,
    stores: stores.length,
    regions: regions.length,
    checked: stores.length * regions.length,
    localised,
    wrappedIn,
    wrappedOut,
    parityChecked,
    substitutions: subs,
    warnings: warn,
    failures: fail
  }, null, 2));
} else {
  log('─'.repeat(52));
  if (fail.length) {
    log('  FAILED — ' + fail.length + ' problem(s):');
    fail.slice(0, 20).forEach(f => log('   ✗ ' + f));
    if (fail.length > 20) log('   … and ' + (fail.length - 20) + ' more');
  } else {
    log('  PASS — all checks green');
  }
  log('');
}

process.exitCode = fail.length ? 1 : 0;
