#!/usr/bin/env node
/**
 * NipCoupon — asset minifier.
 *
 *   node scripts/minify.js              → writes dist/  (deployable copy)
 *   node scripts/minify.js --dry-run    → report only, write nothing
 *   node scripts/minify.js --in-place   → overwrite index.html (NOT recommended;
 *                                         keep the readable file as the source)
 *
 * WHY dist/ AND NOT IN-PLACE
 * --------------------------
 * index.html is a single 137 KB file holding all the CSS and JS. That is
 * deliberate — no build step, no bundler, drag-and-drop deploy — but it also
 * means every visitor downloads the comments and indentation too. This script
 * produces a minified *copy* in dist/ so the repository keeps one readable
 * source of truth and the deployment ships the compact one.
 *
 * TWO ENGINES
 * -----------
 * 1. esbuild, when it is installed (`npm i`). Real minification: identifier
 *    mangling, dead-code removal, property collapsing. ~30% smaller.
 * 2. A built-in conservative minifier otherwise: strips comments and collapses
 *    whitespace, and nothing else. It never renames anything and never reorders
 *    a statement, so it cannot change behaviour.
 *
 * Engine 2 exists because node_modules is not part of the repository. Anyone
 * who clones this and runs `node scripts/minify.js` without installing
 * dependencies still gets a working, if less aggressive, result — the script
 * never hard-fails on a missing optional dependency.
 *
 * The built-in JS pass is string-aware: it tracks ', " and ` literals and
 * distinguishes regex literals from division, so it will not corrupt code the
 * way a naive regex-based stripper does.
 *
 * The minified output is verified before it is written: the inline script is
 * re-parsed with `new Function()`, and if that throws, the ORIGINAL is written
 * instead. Shipping a smaller broken page is the one outcome that must never
 * happen.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const IN_PLACE = args.includes('--in-place');

/* ============================================================ esbuild === */

let esbuild = null;
try {
  esbuild = require('esbuild');
} catch (e) {
  esbuild = null;                              // optional — fallback below
}

function esbuildJs(code) {
  return esbuild.transformSync(code, {
    loader: 'js',
    minify: true,
    target: ['es2019'],
    legalComments: 'none',
    format: 'iife'
  }).code;
}

function esbuildCss(code) {
  return esbuild.transformSync(code, {
    loader: 'css',
    minify: true,
    target: ['chrome80', 'firefox80', 'safari13', 'edge80']
  }).code;
}

/* ================================================== built-in fallback === */

/**
 * Strip comments and collapse whitespace in JavaScript, safely.
 * Walks the source once, tracking string/template/regex context.
 */
function miniJs(src) {
  const n = src.length;
  let out = '';
  let i = 0;

  /* Previous significant character — used to tell `/regex/` from `a / b`. */
  let prev = '';

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // ── comments ────────────────────────────────────────────────────────
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // ── strings ─────────────────────────────────────────────────────────
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      prev = quote;
      continue;
    }

    // ── template literals (no nested ${} tracking needed for whitespace) ─
    if (c === '`') {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === '`') { i++; break; }
        i++;
      }
      prev = '`';
      continue;
    }

    // ── regex literal ───────────────────────────────────────────────────
    // A `/` starts a regex when the previous significant token cannot end an
    // expression: after an operator, a comma, a bracket, or at the start.
    if (c === '/' && /[(,;:=!&|?{}\[+\-*%~^<>]/.test(prev)) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { out += src[i]; i++; break; }
        out += src[i];
        i++;
      }
      // trailing flags
      while (i < n && /[gimsuyd]/.test(src[i])) { out += src[i]; i++; }
      prev = '/';
      continue;
    }

    // ── whitespace: collapse to the minimum that keeps the code valid ───
    if (/\s/.test(c)) {
      // Newlines matter for ASI (automatic semicolon insertion). Keep them
      // only when the line would otherwise join into a different statement.
      if (c === '\n' && /[A-Za-z0-9_$)\]`]/.test(prev)) {
        const nextNonSpace = src.slice(i + 1).match(/\S/);
        const nxt = nextNonSpace ? nextNonSpace[0] : '';
        // `return`/`throw`/`break`/`continue` are restricted productions: a
        // newline after them is significant. Be conservative — keep all
        // newlines. The size cost is tiny compared to a broken site.
        out += '\n';
        prev = '\n';
        i++;
        continue;
      }
      if (prev && prev !== ' ' && prev !== '\n' && out.slice(-1) !== ' ') {
        const nextNonSpace = src.slice(i).match(/\S/);
        const nxt = nextNonSpace ? nextNonSpace[0] : '';
        if (/[A-Za-z0-9_$]/.test(prev) && /[A-Za-z0-9_$]/.test(nxt)) out += ' ';
      }
      i++;
      continue;
    }

    out += c;
    prev = c;
    i++;
  }

  return out.trim();
}

function miniCss(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')            // comments
    .replace(/\s*([{}:;,>])\s*/g, '$1')          // space around punctuation
    .replace(/;}/g, '}')                         // trailing semicolon
    .replace(/\s+/g, ' ')                        // collapse runs
    .replace(/ (\*|[>+~])/g, '$1')               // descendant combinator space
    .trim();
}

/* ================================================================ html === */

function miniHtml(html) {
  return html
    // keep only comments explicitly marked as preserved
    .replace(/<!--(?!\s*preserve)[\s\S]*?-->/g, '')
    .replace(/\n\s*\n+/g, '\n')                  // blank lines
    .replace(/^\s+|\s+$/gm, '')                  // line indentation
    .replace(/\n/g, '');
}

/* ================================================================ main === */

function pct(before, after) {
  if (!before) return '0%';
  return '-' + (((before - after) / before) * 100).toFixed(1) + '%';
}

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('minify: index.html not found at ' + SRC);
    process.exit(1);
  }

  const original = fs.readFileSync(SRC, 'utf8');
  const engine = esbuild ? 'esbuild' : 'built-in';

  let html = original;
  let jsBefore = 0, jsAfter = 0, cssBefore = 0, cssAfter = 0;
  const problems = [];

  /* ── inline scripts (skip any with src= or a non-JS type) ─────────────── */
  html = html.replace(/<script(?![^>]*\bsrc=)(?![^>]*\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript))[^>]*>([\s\S]*?)<\/script>/gi,
    function (m, body) {
      if (!body.trim()) return m;
      jsBefore += Buffer.byteLength(body);
      let out;
      try {
        out = esbuild ? esbuildJs(body) : miniJs(body);
        /* PARITY GATE — if the minified script does not parse, keep the
           original. A 30% smaller page that throws on load is worthless. */
        new Function(out);
      } catch (err) {
        problems.push('script minify failed, kept original: ' + err.message);
        out = body;
      }
      jsAfter += Buffer.byteLength(out);
      return m.replace(body, () => out);
    });

  /* ── inline styles ────────────────────────────────────────────────────── */
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, function (m, body) {
    if (!body.trim()) return m;
    cssBefore += Buffer.byteLength(body);
    let out;
    try {
      out = esbuild ? esbuildCss(body) : miniCss(body);
    } catch (err) {
      problems.push('style minify failed, kept original: ' + err.message);
      out = body;
    }
    cssAfter += Buffer.byteLength(out);
    return m.replace(body, () => out);
  });

  /* ── the HTML shell itself ─────────────────────────────────────────────── */
  const beforeHtml = Buffer.byteLength(html);
  html = miniHtml(html);

  const before = Buffer.byteLength(original);
  const after = Buffer.byteLength(html);

  /* ── final safety gate ─────────────────────────────────────────────────── */
  let verified = true;
  try {
    const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
    m.forEach(tag => {
      const body = tag.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
      if (body.trim()) new Function(body);
    });
  } catch (err) {
    verified = false;
    problems.push('FINAL GATE FAILED — output does not parse, writing original: ' + err.message);
  }

  const report = {
    engine,
    originalBytes: before,
    minifiedBytes: verified ? after : before,
    saved: verified ? before - after : 0,
    reduction: verified ? pct(before, after) : '0%',
    css: { before: cssBefore, after: cssAfter, reduction: pct(cssBefore, cssAfter) },
    js: { before: jsBefore, after: jsAfter, reduction: pct(jsBefore, jsAfter) },
    html: { before: beforeHtml, after: Buffer.byteLength(html), reduction: pct(beforeHtml, Buffer.byteLength(html)) },
    verified,
    problems
  };

  if (!verified) html = original;

  if (!DRY) {
    const target = IN_PLACE ? SRC : path.join(OUT_DIR, 'index.html');
    if (!IN_PLACE) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(target, html);

    /* Carry over the static files a deployment needs. */
    if (!IN_PLACE) {
      ['robots.txt', 'sitemap.xml', 'sitemap-pages.xml', 'sitemap-stores.xml',
       'sitemap-coupons.xml', 'sitemap-all.xml',
       'vercel.json', 'og.png', 'og.webp', 'favicon.ico']
        .forEach(f => {
          const src = path.join(ROOT, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, f));
        });
      ['assets', 'api', 'data', 'locales'].forEach(d => {
        const src = path.join(ROOT, d);
        const dst = path.join(OUT_DIR, d);
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const s = path.join(src, entry.name);
          const t = path.join(dst, entry.name);
          if (entry.isDirectory()) fs.cpSync(s, t, { recursive: true });
          else fs.copyFileSync(s, t);
        }
      });
      /* middleware.js is deliberately NOT copied. It imports `next/server`,
         which Vercel only resolves when the framework preset is Next.js; on a
         framework:null project that import can fail the build and take the
         whole deployment with it. The site does not need it — Vercel supplies
         x-vercel-ip-country natively and the storefront sets the nc_country
         cookie itself. See the header of middleware.js. */
    }
  }

  console.log('minify  engine=' + engine + (DRY ? '  (dry run)' : '') + (IN_PLACE ? '  (in place)' : ''));
  console.log('  total   ' + kb(report.originalBytes) + ' → ' + kb(report.minifiedBytes) + '  ' + report.reduction);
  console.log('  css     ' + kb(cssBefore) + ' → ' + kb(cssAfter) + '  ' + report.css.reduction);
  console.log('  js      ' + kb(jsBefore) + ' → ' + kb(jsAfter) + '  ' + report.js.reduction);
  console.log('  html    ' + kb(report.html.before) + ' → ' + kb(report.html.after) + '  ' + report.html.reduction);
  console.log('  verify  ' + (verified ? 'inline scripts parse OK' : 'FAILED — original written'));
  if (problems.length) problems.forEach(p => console.log('  ! ' + p));
  if (!DRY) console.log('  wrote   ' + (IN_PLACE ? 'index.html' : 'dist/'));

  process.exitCode = verified ? 0 : 1;
}

main();
