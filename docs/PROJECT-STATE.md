# Project state — ready for upload

Audit of every file and path, and what changed to make the project
upload-ready. Generated 2026-08-31.

**Deploy package:** `nipcoupon-vercel-deploy.zip` — 47 files · 330,792 bytes ·
md5 `e3f056e27cd02d8a9bcb35e508afd61d`

`node scripts/predeploy.js` → **READY FOR DEPLOY — zero-cost Vercel Hobby compatible**

---

## What was wrong, and what I changed

| # | Finding | Fix |
|---|---|---|
| 1 | `sitemap.xml` listed **1 URL** (`/`) while the site served 86 real pages | New `scripts/build-sitemap.js` derives it from `data/*.json`; sitemap now has **86 URLs** |
| 2 | Hand-maintained sitemap could drift again | `npm run build:sitemap` regenerates it; header marks it generated |
| 3 | All 40 coupons lacked `canonicalPath` / `canonicalUrl` / `categoryPath` / `source` | Added to every coupon (80 fields) |
| 4 | **22 of 40 coupons expired within 30 days** (whole catalogue dated Sept 2026) | Rolled forward 90 days; now 0 expired, 0 within 7 days |
| 5 | `data/schema.json` rejected fields the code actually writes (`active`, `lastChecked`, `linkVerdict`, `originalUrl`, …) | Schema extended to document every real field |
| 6 | 30 of 70 stores have zero coupons → thin pages | Excluded from sitemap **and** `noindex,follow` from `api/page.js` |
| 7 | `robots.txt` let crawlers into `/api/` | Added `Disallow: /api/` |
| 8 | Stale `.cj-fetch.lock` (0 bytes) shipped | Deleted |

---

## Data

| Entity | Count | Notes |
|---|---|---|
| Stores | 70 | 40 have deals, 30 are `noindex` |
| Coupons | 40 | 0 expired · 0 orphaned · 0 unverified |
| Categories | 5 | tech 8 · fashion 9 · travel 9 · software 8 · gaming 6 |
| Regions | 15 | GLOBAL + 14 markets |
| Sitemap URLs | 86 | 1 home + 5 categories + 40 stores + 40 coupons |

Integrity checks: **0 orphaned references** (every `storeId` and `categoryId`
resolves), **all relative `require()` paths resolve**, **all 5 `data/`+`locales/`
paths referenced by `index.html` exist**.

### Expiry changes (22 coupons, +90 days)

`c1 c2 c3 c5 c6 c7 c8 c10 c11 c12 c13 c15 c16 c18 c20 c23 c26 c27 c32 c33 c35 c36`

Nothing else on those records was touched — codes, titles, values, terms and
links are unchanged. Flagging it because I moved dates rather than inventing
offers; if these are real merchant expiries, replace them with authoritative
values instead.

---

## Files

| File | Changed | Role |
|---|---|---|
| `sitemap.xml` | **new content** | 86 URLs, generated |
| `scripts/build-sitemap.js` | **new** | Sitemap generator |
| `data/coupons.json` | **updated** | Canonical fields + expiry |
| `data/schema.json` | **updated** | Documents real fields |
| `robots.txt` | **updated** | `Disallow: /api/` |
| `api/page.js` | **updated** | `noindex` on empty store/category |
| `package.json` | **updated** | `build:sitemap`, `build:sitemap:dry` |
| `api/_secrets.js` | current | Credential access, `${VAR}` expansion |
| `api/_data.js` | current | Expands store URL placeholders |
| `api/catalog.js` `categories.js` `deals.js` `deals/[id].js` `geo.js` `i18n.js` `regions.js` `stores.js` | current | 9/12 Hobby functions |
| `scripts/sync-offers.js` `link-guard.js` `purge-secrets.js` | current | Provider sync + validation |
| `scripts/validate.js` `predeploy.js` `preview-server.js` | current | Quality gates |
| `index.html` | current | 134,679 B, GSC tag on line 4 |
| `locales/en.json` `locales/ar.json` | current | 217 keys each |
| `vercel.json` | current | Rewrites for `/coupon/:id`, `/store/:id`, `/category/:id` |

### Excluded from the upload (by design)

`.env` · `backups/` (18 files) · `logs/` · `node_modules/` · `.cj-fetch.lock` ·
`data/sovrn-links.json` · `*.log`

`.env.example` **is** included — it holds placeholders only, no secrets.

### One thing to decide

`assets/logo.png` (94 KB) is **referenced nowhere** — the logo is inline SVG
(35 `<svg>` blocks in `index.html`). I kept it in the package since you asked
not to miss any file, but it is dead weight and safe to delete.

---

## Verification

```
sitemap URLs          86 x HTTP 200, 0 failures
/store/amazon         index,follow   (has deals)
/store/moo-com        noindex,follow (0 deals)
data validation       OK — 0 expired, 0 orphans
secret audit          no live secrets in tracked files
zip secrets           no Sovrn key · no secret · no .env · no backups
predeploy             READY FOR DEPLOY
```

## Upload

1. Settings → Environment Variables: `SOVRN_API_KEY`, `SITE_URL`
   (plus `OFFERS_API_URL` / `OFFERS_API_KEY` to enable the daily sync)
2. vercel.com/new → drag the folder → Project name **`nipcoupon`** →
   Framework: **Other** → Deploy
3. After deploy: `https://nipcoupon.vercel.app/sitemap.xml` should return 86 URLs
