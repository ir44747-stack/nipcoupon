# Growth stack — affiliate, geo, keyword, performance and SEO

Everything added to satisfy the five-part brief, what it does, and — just as
important — what it deliberately does *not* do.

Last updated: 2026-09-01

---

## 1. Sovrn affiliate integration & monetisation

| Piece | Where | What it does |
|---|---|---|
| Commerce loader | `api/sovrn.js` | Serves the official Sovrn snippet with your campaign key injected at request time |
| Static wrapping | `data/stores.json` + `api/_secrets.js` | All 70 store URLs are Sovrn wrappers, `${SOVRN_API_KEY}` expanded server-side |
| SSR injection | `api/page.js` | The same loader is inlined into `/coupon/*`, `/store/*`, `/category/*` |
| Client loader | `index.html` (last element in `<body>`) | `<script async src="/api/sovrn.js"></script>` |

**Two layers, by design.** Server-side wrapping covers the 70 known merchants
and works even with JavaScript disabled. The Sovrn loader adds the *dynamic*
half — its "Convert" scan rewrites merchant links the catalogue doesn't know
about. Sovrn skips links that are already wrapped, so there is no
double-attribution.

**The key never lives in a file.** It sits in the `SOVRN_API_KEY` environment
variable and is injected per request. Rotating it is one field in Vercel, not a
repo-wide find-and-replace, and no backup holds a stale copy. This matters
because the key previously *was* committed across all 70 store URLs and had to
be purged.

**Graceful degradation:** with the key unset, `/api/sovrn.js` returns a comment
rather than a script with an empty key, and `resolveUrl()` falls back to the
merchant's plain URL. The site keeps working; it just stops earning.

### Enable it

```
Vercel → Project → Settings → Environment Variables
SOVRN_API_KEY = <your campaign key>       # Settings → campaign → key icon
SOVRN_CUID    = nipcoupon                 # optional, defaults to nipcoupon
```

Verify by loading `/api/sovrn.js` — you should see `window.vglnk.key` set.
Then use Sovrn's own "Check your installation" tool.

---

## 2. Dynamic keyword automation

| Piece | Where |
|---|---|
| Pure engine | `api/_keywords.js` |
| HTTP endpoint | `api/keywords.js` |
| SSR meta tags | `api/page.js` (calls the engine directly — no HTTP hop) |
| Homepage rotation | `scripts/keyword-sync.js` (commits rotated tags into `index.html`) |
| Scheduler | `.github/workflows/daily-growth.yml` |

Terms are generated from the live catalogue (store names × categories) crossed
with the modifier/qualifier/seasonal bank in `data/keywords.json`, then scored:
brand-bearing, long-tail and in-season terms rank up.

Two design decisions worth knowing:

- **Date-seeded rotation.** The same day always yields the same set, so the
  output is cacheable and the meta tags don't flicker between requests.
- **Quotas per page type.** Without them one family — usually seasonal — takes
  every slot. A store page leads with the brand (50%), a category page with the
  category (45%), the homepage uses a balanced mix.

**On Vercel, `/api/keywords` is always live** — no scheduler required, so it
can never go stale. The homepage's static tags are the only ones that need a
scheduled commit, and that is what the GitHub Action does.

```bash
curl 'localhost:3000/api/keywords?limit=12'
curl 'localhost:3000/api/keywords?store=amazon&limit=12'
curl 'localhost:3000/api/keywords?category=tech&format=csv'
```

---

## 3. Geo-targeting & IP-based localisation

| Piece | Where |
|---|---|
| Rules | `data/geo-rules.json` |
| Engine | `api/_geo.js` |
| API | `api/geo.js` |
| Edge (optional) | `cloudflare/worker.js` + `cloudflare/wrangler.toml` |
| Edge (Vercel, opt-in) | `middleware.js` |
| Client | `index.html` → `clientLocalizeUrl()` |
| Regression test | `scripts/check-geo.js` — `npm run geo:check` |

**Resolution order:** `?country=` → `nc_country` cookie → `x-nc-country` →
`x-vercel-ip-country` → `cf-ipcountry` → IP lookup → `GLOBAL`.

**What gets localised**

| Rule | Example |
|---|---|
| `domainVariants` | `amazon.com` → `amazon.ae` / `amazon.sa` / `amazon.de` |
| `pathVariants` | `noon.com` → `noon.com/saudi-en`; `talabat.com` → `/qatar` |
| `currencyParams` | `booking.com?selected_currency=QAR` |
| `priority` | Qatar sees Namshi and Amazon.ae first; the US sees Amazon and Walmart |
| `substitutes` | A merchant that doesn't ship to the market is swapped for one that does |

**The subtlety that makes this work:** stored URLs are Sovrn wrappers
(`sovrn.co/?key=…&u=<target>`). Localising means rewriting the *inner* `u` and
re-wrapping. Naively swapping the hostname produces `sovrn.ae` — a dead link
with the commission stripped. `scripts/check-geo.js` guards exactly this
across 70 stores × 15 regions (1,050 combinations).

### Why no geo-redirect

The brief says "redirection". We deliberately don't:

- it fragments one canonical URL into N duplicates and splits ranking signals;
- Googlebot egresses from the US, so it would only ever index the US variant;
- it costs a full round trip before first byte for every first-time visitor.

We do **soft localisation** instead: one URL, localised links. A hard-redirect
path exists behind `GEO_REDIRECT=1` in `middleware.js` if you ever want it.

### Cloudflare Worker

```bash
npm i -g wrangler
wrangler deploy --config cloudflare/wrangler.toml
```

It reads `cf-ipcountry`, forwards `x-nc-country`, sets the cookie, and caches
immutable assets at Cloudflare's edge.

### Vercel middleware — READ THIS BEFORE ENABLING

`middleware.js` imports `next/server`. Vercel only guarantees that resolves
when the framework preset is Next.js; on a `framework: null` project it has
been reported to fail the build with *"Edge Function middleware is referencing
unsupported modules"*, which would take down the entire deployment. It is
therefore **excluded from the deploy bundle**, and it is also largely
redundant — Vercel already sends `x-vercel-ip-country` for free, and the
storefront now sets the `nc_country` cookie itself. Enable it only after
switching the preset or confirming a preview build.

---

## 4. Performance

| Piece | Where |
|---|---|
| Minifier | `scripts/minify.js` → `dist/` |
| Image conversion | `og.webp`, `assets/logo.webp` (Pillow) |
| Cache headers | `vercel.json` |
| Connection hints | `index.html` — `preconnect`/`dns-prefetch` for `cdn.viglink.com` |

**Minification:** `npm run minify` writes `dist/`. 144 KB → 101 KB (−29.7%);
inline JS alone drops 44%. Two engines — esbuild when installed, a conservative
built-in minifier otherwise (node_modules is not committed, so the built-in
guarantees the script never hard-fails).

*Safety gate:* the minified script is re-parsed with `new Function()` before
being written. If it doesn't parse, the **original** is written instead. A
smaller broken page is the one outcome that must never ship.

**The honest finding about images:** the page loads **zero raster images**. All
iconography is inline SVG, there are no webfonts, and there are no external
requests beyond the Sovrn loader. So image optimisation cannot move Core Web
Vitals much — the minifier and cache headers are where the win is.

That said, both PNGs were converted and compressed:

| File | Before | After |
|---|---|---|
| `og.png` | 76.8 KB | 34.0 KB (re-quantised PNG, PSNR 44 dB — visually identical) |
| `og.webp` | — | 16.4 KB |
| `assets/logo.png` → `logo.webp` | 92.1 KB | 10.5 KB |

**`og:image` still points at the PNG on purpose.** Link previews (WhatsApp,
iMessage, Slack, LinkedIn) have patchy WebP support, and a broken share preview
costs more than 17 KB. The WebP files are there for anything that sends
`Accept: image/webp`.

**Caching** (`vercel.json`): assets immutable for a year; HTML `s-maxage=3600`
with `stale-while-revalidate=86400`; JSON `s-maxage=3600`; sitemap one hour.

---

## 5. Multilingual & SEO

- **Locales** — `locales/en.json`, `locales/ar.json`, served by `api/i18n.js`.
  Adding a language is: drop in `fr.json`. Everything else (sitemap hreflang,
  `/api/page` alternates) picks it up automatically.
- **hreflang** — every URL declares `en`, `ar` and `x-default`. In
  `sitemap.xml` (258 entries) and on every server-rendered page.
- **`?lang=` wins** over a stored preference, so sharing an Arabic URL gives
  the recipient Arabic.
- **Sitemap** — `scripts/build-sitemap.js`, derived from the catalogue so it
  cannot drift. 86 URLs: 1 home, 5 categories, 40 stores with deals, 40 live
  coupons. Empty stores and expired coupons are excluded *and* marked
  `noindex` — the sitemap keeps crawlers out, the meta tag catches those that
  arrive another way.
- **Crawl budget** — `robots.txt` disallows `/api/`; the rewrites mean
  `/coupon/*` stays crawlable as real HTML.

### Daily automation — `api/cron.js`

One Vercel cron entry at 03:00 UTC (Hobby allows 2 jobs, daily only).

- `sitemap` — verify the deployed sitemap (URL count, hreflang count)
- `ping` — push changed URLs to IndexNow and Bing Webmaster Tools
- `warm` — re-request the homepage and top pages so the first visitor of the
  day hits a warm edge cache

**The old ping endpoints are dead and are not used.** Google retired
`/ping?sitemap=` in 2023 (it returns 404) and Bing moved to IndexNow. The only
remaining automatic discovery route for Google is the `Sitemap:` line in
robots.txt — the cron verifies it on every run and says so in its report.

Set `CRON_SECRET` to lock the endpoint; Vercel sends it automatically as
`Authorization: Bearer …`.

---

## Commands

```bash
npm run preview          # http://localhost:3000
npm run geo:check        # 1,050 store×region assertions
npm run minify:dry       # report size savings
npm run minify           # write dist/
npm run keywords:dry     # preview homepage meta rotation
npm run build:sitemap    # rebuild sitemap.xml
npm run secrets:audit    # must stay clean
npm run validate         # data integrity
```

---

## Deploying

```bash
npm run minify           # produces dist/
cd dist && find . -type f ! -path './data/sovrn-links.json' \
  ! -path './assets/logo.png' ! -path './assets/logo.webp' \
  | sed 's|^\./||' | zip -q -X -@ ../../nipcoupon-vercel-deploy.zip
```

Then drag the zip into the Vercel dashboard. Excluded on purpose:
`data/sovrn-links.json` (local provider snapshot), `assets/logo.png` and
`assets/logo.webp` (unreferenced — the wordmark is inline SVG), and
`middleware.js` (see §3).

**Pushing to GitHub does not deploy.** The two are independent unless the repo
is connected in Vercel — which would also let the daily keyword workflow ship
itself.
