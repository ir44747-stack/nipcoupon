/**
 * _secrets.js — the ONLY place in NipCoupon that is allowed to touch credentials.
 *
 * Rules, in order of importance:
 *
 *   1. Secrets come from process.env. On Vercel those are injected from the
 *      project's Environment Variables panel. Locally they come from `nipcoupon/.env`.
 *   2. Nothing here ever logs, serialises or throws a secret value.
 *   3. Secrets never get written into /data/*.json. Data files may hold a
 *      `${VAR_NAME}` placeholder, which `template()` expands at request time.
 *      If the variable is missing the caller falls back to a safe URL — the site
 *      degrades to a non-monetised link, it never ships a broken one.
 *
 * Why placeholders instead of real keys in the data files?
 *   Rotation. One env var change re-points all 70 store links. With the key
 *   copied into every record you would have to rewrite the whole catalogue,
 *   and every backup would keep a stale copy of the old key forever.
 *
 * Underscore prefix → Vercel does not expose this file as a route.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ── Which variables are secret ────────────────────────────────────────────
 * Anything in this set is redacted by `redact()` / `safeDump()` and refused
 * by `assertNoSecrets()` if it turns up in a data file.
 * Add to it whenever a new credential is introduced. */
const SECRET_KEYS = new Set([
  'CJ_ACCESS_TOKEN',
  'CJ_PAT',
  'SOVRN_API_KEY',
  'SOVRN_SECRET_KEY',
  'OFFERS_API_KEY',
  'OFFERS_API_TOKEN',
  'PROVIDER_SECRET',
  'FEED_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'INDEXNOW_KEY',
  'CRON_SECRET'
]);

/* Non-secret config we also read from the environment. */
const CONFIG_KEYS = new Set([
  'SITE_URL',
  'OFFERS_API_URL',
  'SOVRN_LINK_BASE',
  'SOVRN_CUID',
  'CJ_PUBLISHER_ID',
  'CJ_PROPERTY_ID',
  'DEALS_FEED_URL',
  'LINK_GUARD_ALLOWLIST'
]);

/* ── Local .env (dev only; Vercel already injects) ────────────────────────── */
let dotEnvLoaded = false;
function loadDotEnv() {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const file = path.join(ROOT, '.env');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return; }

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) val = val.slice(1, -1);
    // real env always wins over the file, so CI/Vercel can override
    if (val && process.env[key] === undefined) process.env[key] = val;
  }
}

/* ── Accessors ───────────────────────────────────────────────────────────── */
function env(key, fallback) {
  loadDotEnv();
  const v = process.env[key];
  return v === undefined || v === '' ? (fallback === undefined ? '' : fallback) : String(v);
}

/** True when a secret is actually configured. Never reveals the value. */
function has(key) {
  return env(key).trim() !== '';
}

/**
 * Mask a secret for logging: `21216f6776…b3b56` (first 6 + last 4).
 * Short values collapse to asterisks so length isn't leaked either.
 */
function mask(value) {
  const v = String(value == null ? '' : value);
  if (!v) return '(unset)';
  if (v.length <= 12) return '*'.repeat(Math.min(v.length, 8));
  return v.slice(0, 6) + '…' + v.slice(-4);
}

/** Present/absent report — safe to log or return from a debug endpoint. */
function status(keys) {
  loadDotEnv();
  return (keys || [...SECRET_KEYS]).map(k => ({
    key: k,
    secret: SECRET_KEYS.has(k),
    set: env(k).trim() !== '',
    preview: SECRET_KEYS.has(k) ? mask(env(k)) : (env(k) || '(unset)')
  }));
}

/**
 * Replace `${VAR}` placeholders with env values.
 *
 * Returns `{ value, missing }`. When `missing` is non-empty the substitution is
 * INCOMPLETE — callers must treat the string as unusable and fall back, never
 * publish it. That is the whole point: a missing key produces a plain link,
 * not a half-built URL carrying a literal `${SOVRN_API_KEY}`.
 */
function template(str) {
  const missing = [];
  if (typeof str !== 'string') return { value: '', missing };
  if (str.indexOf('${') === -1) return { value: str, missing };

  const value = str.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name) => {
    const v = env(name);
    if (v === '') { missing.push(name); return m; }
    return v;
  });
  return { value, missing };
}

/**
 * Resolve a store/coupon URL safely.
 *   - expands `${…}` placeholders
 *   - if expansion is incomplete, returns `fallback` (usually `originalUrl`)
 *   - if nothing resolves, returns ''
 */
function resolveUrl(raw, fallback) {
  const { value, missing } = template(raw);
  if (missing.length || !value) return String(fallback || '');
  return value;
}

/* ── Guard rails ─────────────────────────────────────────────────────────── */

/** Scrub known secret values out of an arbitrary string (for error messages). */
function redact(input) {
  let out = String(input == null ? '' : input);
  loadDotEnv();
  for (const key of SECRET_KEYS) {
    const v = env(key);
    if (v && v.length >= 8) out = out.split(v).join('[REDACTED:' + key + ']');
  }
  return out;
}

/** Recursively redact an object (safe to console.log). */
function safeDump(obj) {
  try {
    return redact(JSON.stringify(obj, null, 2));
  } catch (e) {
    return '[unserialisable]';
  }
}

/**
 * Scan a serialisable value for any live secret.
 * Returns an array of `{ key, where }` findings — empty means clean.
 * Used by scripts/secret-audit.js and predeploy to fail the build.
 */
function assertNoSecrets(value, where, findings) {
  findings = findings || [];
  where = where || 'value';
  loadDotEnv();

  if (typeof value === 'string') {
    for (const key of SECRET_KEYS) {
      const v = env(key);
      if (v && v.length >= 8 && value.indexOf(v) !== -1) {
        findings.push({ key, where });
      }
    }
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, where + '[' + i + ']', findings));
    return findings;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      assertNoSecrets(value[k], where + '.' + k, findings);
    }
  }
  return findings;
}

module.exports = {
  SECRET_KEYS,
  CONFIG_KEYS,
  loadDotEnv,
  env,
  has,
  mask,
  status,
  template,
  resolveUrl,
  redact,
  safeDump,
  assertNoSecrets
};
