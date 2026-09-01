#!/usr/bin/env node
/**
 * NipCoupon — shared runtime for the daily automation jobs.
 *
 * Zero dependencies, Node 18+ (uses the global fetch).
 * Consumed by: keyword-sync.js · sitemap-ping.js · link-health.js · run-daily.js
 *
 * Everything here is defensive: a network failure, a missing .env or a
 * read-only filesystem downgrades to a warning instead of exiting non-zero,
 * because a cron job that throws at 03:00 is worse than one that does less.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(ROOT, 'backups');
const DEFAULT_SITE_URL = 'https://nipcoupon.vercel.app';

/* ======================================================== CLI arguments === */

function parseArgs(argv) {
  const out = { flags: {}, positional: [] };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) { out.positional.push(raw); continue; }
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) out.flags[body] = true;
    else out.flags[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

/** Read a flag, falling back when it is absent or a bare `--flag`. */
function flag(args, name, fallback) {
  const v = args.flags[name];
  return v === undefined || v === true ? fallback : v;
}
const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const bool = v => v === true || v === 'true' || v === '1' || v === 'yes' || v === 'on';

/* ========================================================== environment === */

/** Minimal .env reader — no dependency. Ignores comments, blank lines, quotes. */
function loadDotEnv(file) {
  const p = file || path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

let _envCache = null;
/** process.env wins, then .env, then fallback. Never throws. */
function env(key, fallback) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  if (_envCache === null) _envCache = loadDotEnv();
  const v = _envCache[key];
  if (v === undefined || v === '') return fallback === undefined ? '' : fallback;
  return v;
}

/* =============================================================== logging === */

const LOG = { quiet: false, json: false };

function setLogMode(opts) {
  if (opts && typeof opts.quiet === 'boolean') LOG.quiet = opts.quiet;
  if (opts && typeof opts.json === 'boolean') LOG.json = opts.json;
}

function say(msg) { if (!LOG.quiet && !LOG.json) console.log(msg); }
const info  = msg => say('  · ' + msg);
const ok    = msg => say('  ✓ ' + msg);
const warn  = msg => { if (!LOG.json) console.warn('  ! ' + msg); };
const fail  = msg => { if (!LOG.json) console.error('  ✗ ' + msg); };
function step(title) { if (!LOG.quiet && !LOG.json) console.log('\n' + title + '\n' + '─'.repeat(52)); }

/* ============================================================== file i/o === */

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function dataPath(name) { return path.join(DATA_DIR, name); }

function readData(name, fallback) {
  const p = dataPath(name);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { warn('could not parse data/' + name + ' — ' + e.message); return fallback; }
}

/** Pretty-printed, trailing-newline, LF-only. Returns false when read-only. */
function writeData(name, obj) {
  const p = dataPath(name);
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) { warn('could not write data/' + name + ' — ' + e.message); return false; }
}

function readText(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }

function writeText(p, text) {
  try { fs.writeFileSync(p, text, 'utf8'); return true; }
  catch (e) { warn('could not write ' + path.basename(p) + ' — ' + e.message); return false; }
}

/** Timestamped snapshot so any automated write is reversible. */
function backup(name, obj) {
  try {
    ensureDir(BACKUP_DIR);
    const p = path.join(BACKUP_DIR, name + '-' + stamp() + '.json');
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return p;
  } catch (e) { warn('backup skipped — ' + e.message); return null; }
}

/* =================================================================== http === */

const UA = 'Mozilla/5.0 (compatible; NipCouponBot/1.0; +https://nipcoupon.vercel.app)';

/**
 * fetch() with a hard timeout and a non-throwing result.
 * Always resolves: inspect `.ok` / `.status` / `.error`.
 */
async function request(url, opts) {
  opts = opts || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 15000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'user-agent': UA, accept: '*/*' }, opts.headers || {}),
      body: opts.body,
      redirect: opts.follow === false ? 'manual' : 'follow',
      signal: controller.signal
    });
    let body = '';
    if (opts.readBody !== false) { try { body = await res.text(); } catch (e) { /* ignore */ } }
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, body, error: null };
  } catch (e) {
    const err = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    return { ok: false, status: 0, finalUrl: url, body: '', error: err };
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON(url, opts) {
  const r = await request(url, Object.assign({ headers: { accept: 'application/json' } }, opts || {}));
  if (!r.ok || !r.body) return { ok: false, data: null, error: r.error || ('HTTP ' + r.status) };
  try { return { ok: true, data: JSON.parse(r.body), error: null }; }
  catch (e) { return { ok: false, data: null, error: 'invalid JSON' }; }
}

/* ============================================================ concurrency === */

/** Run `worker(item, index)` with at most `limit` in flight, order preserved. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { error: String((e && e.message) || e) }; }
    }
  });
  await Promise.all(lanes);
  return results;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================== utilities === */

const todayISO = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Deterministic PRNG (mulberry32) so a given day always picks the same set. */
function rng(seed) {
  let a = 0;
  for (let i = 0; i < seed.length; i++) a = (a * 31 + seed.charCodeAt(i)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable shuffle — same seed always yields the same order. */
function seededShuffle(arr, seed) {
  const out = arr.slice();
  const rand = rng(String(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

function unique(arr) { return Array.from(new Set(arr.filter(Boolean))); }

/** Canonical site origin, no trailing slash. Override with SITE_URL. */
function siteUrl() {
  const raw = env('SITE_URL', DEFAULT_SITE_URL) || DEFAULT_SITE_URL;
  return String(raw).replace(/\/+$/, '');
}

const escapeXml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const escapeHtml = escapeXml;

/** Days from today; negative means the date is in the past. */
function daysUntil(isoDate) {
  const a = Date.parse(isoDate + 'T00:00:00Z');
  if (Number.isNaN(a)) return NaN;
  return Math.round((a - Date.parse(todayISO() + 'T00:00:00Z')) / 86400000);
}

module.exports = {
  ROOT, DATA_DIR, BACKUP_DIR, DEFAULT_SITE_URL, UA,
  parseArgs, flag, num, bool,
  loadDotEnv, env,
  setLogMode, say, info, ok, warn, fail, step,
  ensureDir, dataPath, readData, writeData, readText, writeText, backup,
  request, getJSON, pool, sleep,
  todayISO, stamp, sha256, rng, seededShuffle, unique,
  siteUrl, escapeXml, escapeHtml, daysUntil
};
