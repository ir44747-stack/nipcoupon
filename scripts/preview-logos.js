#!/usr/bin/env node
/**
 * preview-logos.js — render every merchant logo tile to a standalone page.
 *
 *   node scripts/preview-logos.js            # writes logo-preview.html
 *   node scripts/preview-logos.js --open     # also prints the path
 *
 * The tiles use the SAME CSS and the SAME optical sizing rules as index.html,
 * so what you see here is what ships. Regenerate after editing data/stores.json
 * to check a new brand's mark before deploying.
 *
 * The file is a review artefact — delete it whenever you like.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const stores = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stores.json'), 'utf8')).stores || [];

function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const a = Math.round(2.55 * pct);
  const r = Math.min(255, Math.max(0, (n >> 16) + a));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 255) + a));
  const b = Math.min(255, Math.max(0, (n & 255) + a));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Mirrors logoVars() / logoInner() in index.html */
function logoVars(m) {
  const n = String(m.abbr || '?').length;
  const fs2 = m.glyph ? '1.2rem'
    : n <= 1 ? '1.55rem' : n === 2 ? '1.3rem' : n === 3 ? '1.02rem' : '0.8rem';
  const ls = m.glyph ? '0'
    : n <= 2 ? '0.01em' : n === 3 ? '-0.01em' : '-0.02em';
  return 'background:linear-gradient(150deg,' + shade(m.color, 16) + ' 0%,' + m.color +
    ' 48%,' + shade(m.color, -30) + ' 100%);color:' + m.fg + ';--sl-fs:' + fs2 + ';--sl-ls:' + ls;
}
function logoInner(m) {
  return m.glyph ? m.glyph
    : '<span class="sl-in">' + esc(String(m.abbr || '?').toUpperCase()) + '</span>';
}

const tiles = stores.map(s =>
  '<div class="cell">' +
    '<div class="store-logo" style="' + logoVars(s) + '">' + logoInner(s) + '</div>' +
    '<span class="nm">' + esc(s.name) + '</span>' +
  '</div>'
).join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NipCoupon — logo tiles</title>
<style>
  body{margin:0;background:#090d16;color:#e2e8f0;
       font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:36px 28px 60px}
  h1{font-size:1.15rem;margin:0 0 4px}
  p.sub{margin:0 0 26px;color:#94a3b8;font-size:.85rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:18px}
  .cell{display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center}
  .nm{font-size:.72rem;color:#94a3b8;line-height:1.25;max-width:96px}

  /* ── identical to index.html ─────────────────────────────── */
  .store-logo,.sg-badge{
    position:relative;display:grid;place-items:center;flex:none;
    overflow:hidden;isolation:isolate;
    font-weight:900;line-height:1;color:#fff;
    box-shadow:
      0 1px 2px rgba(0,0,0,.45),
      0 10px 20px -12px rgba(0,0,0,.8),
      inset 0 1px 0 rgba(255,255,255,.30),
      inset 0 0 0 1px rgba(255,255,255,.10);
  }
  .store-logo{
    width:52px;height:52px;border-radius:15px;
    transition:transform .32s cubic-bezier(.2,.7,.3,1),box-shadow .32s ease;
  }
  .sg-badge{width:36px;height:36px;border-radius:11px;--sl-scale:.62}
  .store-logo::after,.sg-badge::after{
    content:'';position:absolute;inset:0;z-index:1;pointer-events:none;border-radius:inherit;
    background:linear-gradient(180deg,
      rgba(255,255,255,.22) 0%,
      rgba(255,255,255,.04) 42%,
      rgba(0,0,0,.10) 100%);
  }
  .store-logo>*,.sg-badge>*{position:relative;z-index:2;display:block;line-height:1}
  .sl-in{font-size:calc(var(--sl-fs,1.05rem) * var(--sl-scale,1));letter-spacing:var(--sl-ls,-.03em)}
  .store-logo svg,.sg-badge svg{width:58%;height:58%;display:block}
  .cell:hover .store-logo{transform:scale(1.08) rotate(-3deg)}
</style></head>
<body>
  <h1>Merchant logo tiles</h1>
  <p class="sub">${stores.length} brands · hover to see the card hover state</p>
  <div class="grid">
${tiles}
  </div>
</body></html>
`;

const out = path.join(ROOT, 'logo-preview.html');
fs.writeFileSync(out, html);
console.log('wrote ' + path.relative(ROOT, out) + '  (' + stores.length + ' tiles)');
