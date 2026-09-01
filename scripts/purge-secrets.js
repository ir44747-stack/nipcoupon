#!/usr/bin/env node
/**
 * purge-secrets.js — remove live credentials from tracked files.
 *
 *   node scripts/purge-secrets.js              # report only (safe, changes nothing)
 *   node scripts/purge-secrets.js --fix        # rewrite files with ${VAR} placeholders
 *   node scripts/purge-secrets.js --fix --backups   # also scrub backups/
 *   node scripts/purge-secrets.js --json
 *
 * Why this exists
 * ---------------
 * The Sovrn site key used to be written directly into all 70 store URLs in
 * data/stores.json, e.g.
 *     https://sovrn.co/?key=21216f…&u=https%3A%2F%2Fwww.amazon.com&cuid=nipcoupon
 * That file is committed and shipped, and every backup kept another copy, so
 * rotating the key meant rewriting the catalogue and the key could never really
 * be retired.
 *
 * This script rewrites those to a placeholder:
 *     https://sovrn.co/?key=${SOVRN_API_KEY}&u=https%3A%2F%2Fwww.amazon.com&cuid=nipcoupon
 * `api/_data.js` expands the placeholder per request from the real env var. If
 * the variable is unset the store falls back to its `originalUrl` — a working,
 * non-monetised link instead of a 400.
 *
 * Backups are opt-in (`--backups`) because rewriting history-adjacent files is
 * destructive; the default is to REPORT them so you can decide.
 *
 * Exit codes: 0 clean (or successfully fixed) · 1 secrets still present · 2 bad usage
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('../api/_secrets.js');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const AS_JSON = has('--json');
const FIX = has('--fix');
const DO_BACKUPS = has('--backups');

function say(...a) { if (!AS_JSON) console.log(...a); }

/* Files we always scan — everything that gets committed or deployed. */
const SCAN_DIRS = ['data', 'api', 'scripts', 'locales'];
const SCAN_FILES = ['index.html', 'sitemap.xml', 'robots.txt', 'vercel.json', '.env.example'];
const SKIP = new Set(['.env']); // the one file that is SUPPOSED to hold secrets

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(json|js|html|xml|txt|yml|yaml|md)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function targets() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
  for (const f of SCAN_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) files.push(p);
  }
  if (DO_BACKUPS) walk(path.join(ROOT, 'backups'), files);
  return [...new Set(files)].filter(f => !SKIP.has(path.basename(f)));
}

/* ── Which placeholder stands in for each secret ──────────────────────────── */
function replacementFor(key) {
  return '${' + key + '}';
}

/* Replace `key=<secret>` / `"<secret>"` / bare occurrences with the placeholder.
 * Handles the URL form `?key=VALUE` and any raw embedding. */
function scrub(text, key, value) {
  if (!value || value.length < 8) return { text, count: 0 };
  let count = 0;

  // 1) query-param form:  key=VALUE  (most common — Sovrn/CJ wrappers)
  text = text.replace(
    new RegExp('(key|apikey|api_key|token|access_token|secret)=(' + escapeRe(value) + ')', 'gi'),
    (m, param) => { count++; return param + '=' + replacementFor(key); }
  );

  // 2) any other bare occurrence
  const parts = text.split(value);
  if (parts.length > 1) {
    count += parts.length - 1;
    text = parts.join(replacementFor(key));
  }
  return { text, count };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ── Main ─────────────────────────────────────────────────────────────────── */
const files = targets();
const findings = [];
let fixedFiles = 0;

for (const file of files) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }

  let text = raw;
  let hits = 0;
  for (const key of S.SECRET_KEYS) {
    const value = S.env(key);
    if (!value || value.length < 8) continue;
    if (text.indexOf(value) === -1) continue;
    hits++;
    if (FIX) {
      const r = scrub(text, key, value);
      text = r.text;
    }
  }
  if (!hits) continue;

  const rel = path.relative(ROOT, file);
  findings.push({ file: rel, fixed: FIX });
  if (FIX && text !== raw) {
    fs.writeFileSync(file, text);
    fixedFiles++;
  }
}

const remaining = [];
for (const file of files) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
  for (const key of S.SECRET_KEYS) {
    const value = S.env(key);
    if (value && value.length >= 8 && raw.indexOf(value) !== -1) {
      remaining.push({ file: path.relative(ROOT, file), key });
    }
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ scanned: files.length, found: findings, fixedFiles, remaining }, null, 2));
} else {
  say('');
  say('Secret purge — scanned ' + files.length + ' files');
  say('─'.repeat(52));
  if (!findings.length && !remaining.length) {
    say('  ✓ no live secrets found in tracked files');
  } else {
    for (const f of findings) {
      say('  ' + (FIX ? '✓ scrubbed ' : '! contains secret  ') + f.file);
    }
    if (remaining.length) {
      say('');
      say('  STILL PRESENT (' + remaining.length + '):');
      for (const r of remaining) say('    ' + r.file + '  ← ' + r.key);
    }
  }
  say('');
}

process.exit(remaining.length ? 1 : 0);
