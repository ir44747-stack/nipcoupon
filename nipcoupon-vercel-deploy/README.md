# NipCoupon — Global Deals. Sniper Precision.

A complete, mobile-first, dark-mode coupon aggregator in a single self-contained file.
No build step, no CDN, no dependencies — open `index.html` and it runs.

## Deploy to Vercel (dashboard, no CLI)

1. Download **`nipcoupon-vercel-deploy.zip`** from the workspace (or grab the `deploy-nipcoupon/` folder).
2. Go to <https://vercel.com/new> and sign in.
3. Drag the extracted folder (or the zip) onto the upload area.
4. Set **Project Name** to `nipcoupon`, leave Framework Preset on **Other** and the build command empty —
   it is a pure static site, nothing to compile.
5. Hit **Deploy**. Your live URL will be **https://nipcoupon.vercel.app**.

That's it — `vercel.json` is already in the package, so clean URLs, security headers and
asset caching are configured for you.

### If you'd rather use the CLI

```bash
cd nipcoupon
npx vercel login      # one-time browser login
npx vercel --prod     # deploys to production
```

### After deploy

* Add the custom domain under **Settings → Domains**, if you have one.
* Update the `https://nipcoupon.vercel.app/` occurrences in `index.html` (canonical + OG tags),
  `sitemap.xml` and `robots.txt` if you use a different domain.
* Redeploy any time by re-uploading the folder — Vercel keeps each deploy immutable and
  previewable, and production only moves when you promote it.

## Files

| File | What it is |
|---|---|
| `index.html` | The UI: markup + design-system CSS + vanilla JS + inline vector logo. Loads all content from `data/` at runtime. |
| `data/` | Modular JSON content — stores, categories, coupons, config (+ JSON Schema). |
| `api/` | Serverless API handlers (Vercel Functions) that expose the same data over HTTP. |
| `scripts/validate.js` | Data validator — schema, expiry, affiliate-link health, expired-deal pruning. |
| `scripts/predeploy.js` | Pre-deploy audit — affiliate parameters + Vercel free-tier readiness. |
| `og.png` | 1200×630 social share card (ticket mark + wordmark + tagline). |
| `vercel.json` | Vercel config: static (no build), clean URLs, security headers, immutable asset caching. |
| `robots.txt` / `sitemap.xml` | SEO basics, pre-filled for `https://nipcoupon.vercel.app`. |
| `assets/logo.png` | The originally uploaded raster logo, kept as an asset (not used by default). |

## Run it

```bash
cd nipcoupon && python3 -m http.server 3000
# → http://localhost:3000
```

(Opening `index.html` directly from disk works too.)

## The logo

The header logo is an inline **vector SVG** (class `.logo-mark`, `viewBox="0 0 64 44"`), drawn to match
the official mark:

* a **sleek ticket outline** — rounded rectangle with punch-out notches left and right, stroked in neon
  green `#10b981` with a green→blue gradient fill;
* an **integrated letter "N"** in crisp white on the left panel;
* a **blue sniper crosshair target** on the right (`#3b82f6`): outer ring, inner ring, four reticle ticks
  and a centre dot;
* a dashed perforation line separating the two panels, for the coupon-ticket feel.

It scales cleanly at any size and never pixelates. It appears twice — navbar and footer — each with its
own gradient id (`ncTicketNav`, `ncTicketFoot`).

### Lockup sizing

| Element | Rule |
|---|---|
| Logo icon slot | `min-height: 42px; min-width: 42px; height: 44px` (42px on ≤760px), `flex: none`, `padding: 5px 9px` — the mark is never squeezed or clipped |
| `.logo-mark` | `height: 32px; width: auto` (28px on ≤760px) |
| `.brand-name` | `font-weight: 900`, `text-transform: uppercase` — `NIP` `#ffffff`, `COUPON` `#10b981` |
| `.brand-tag` | `GLOBAL DEALS • SNIPER PRECISION` at 9.5px, `letter-spacing: .18em`, `#94a3b8` (scales down to 8px / `.1em` on phones, always visible) |
| `.brand` | the whole lockup is one `<a href="#">` — a 305×44px click target to the homepage |

### Using a raster file instead

Replace the `<svg class="logo-mark">` inside either `.logo-slot` with
`<img src="assets/logo.png" alt="NipCoupon logo">` — the slot styles (`width: auto; height: 100%`,
`object-fit: contain`) keep it correctly proportioned.

## Brand system

| Token | Value | Used for |
|---|---|---|
| `--bg` / `--bg-2` | `#090d16` / `#0f172a` | Page + section backgrounds |
| `--card` | `#1e293b` | Cards, store tiles, panels |
| `--green` | `#10b981` | Savings, discounts, verified state, primary CTA |
| `--blue` | `#3b82f6` | Precision/target highlights, focus rings, search |
| `--text` / `--muted` | `#e8eef7` / `#94a3b8` | Body + secondary copy |

## Structure

1. **Live ticker** — rotating redemption activity.
2. **Navbar** — logo slot + wordmark, search (`/` focuses it), Categories dropdown,
   Trending Deals, Top Stores, saved-coupons toggle, Submit Coupon CTA, burger (≤1080px).
3. **Hero** — headline, real-time store search with keyboard-navigable autocomplete
   (↑ ↓ Enter Esc), popular-target chips, animated stats.
4. **Store grid** — 40 global brands with live deal counts; click to filter.
5. **Deals** — sticky toolbar (category chips, type, sort), result count, removable
   filter pills, 9-per-page grid with Load more.
6. **Coupon card** — store logo, discount badge, verification status, expiry, uses, rating,
   masked promo code, `Get Code` (reveals + copies + toast), save (♥), details modal, report.
7. **Categories** — Tech & Electronics, Fashion, Travel, Gaming, Software.
8. **Newsletter + footer** — quick links, category links, Terms, Privacy Policy,
   Affiliate Disclosure, `Copyright © 2026 NipCoupon`.

## Behaviour notes

* **Get Code** reveals the code on the card and writes it to the clipboard, then fires a toast.
  `navigator.clipboard` is used when available; otherwise it falls back to `execCommand('copy')`,
  and if even that is blocked (e.g. inside a sandboxed iframe) the toast tells the user to copy manually.
* **Deals** (no code) open a details modal with activation steps instead.
* Filters are orthogonal: picking a store clears the category filter and vice versa, so you
  never land on an empty grid by accident.
* Saved coupons persist in `localStorage` under `nipcoupon:favs`.
* `prefers-reduced-motion` disables all animation; everything is keyboard reachable and labelled.

## Outbound / affiliate links

Every **Get Code** and **Get Deal** button does three things, in order:

1. **Copies the promo code** to the clipboard (`navigator.clipboard`, with an `execCommand` fallback
   and a manual-copy message if the browser blocks it) and reveals the code on the card;
2. **Opens the store link in a new tab** — the page itself never navigates away;
3. **Shows a success toast** naming the store and the code.

### Configuring your affiliate IDs

Two objects at the top of the `<script>` block control every outbound link:

```js
const STORE_LINKS = { 'Amazon': 'https://www.amazon.com', ... };   // destination per store

const AFFILIATE = {
  tags:   { 'Amazon': 'tag=your-id-20', 'NordVPN': 'aff_id=1234' },  // per-network query strings
  params: { utm_source: 'nipcoupon', utm_medium: 'affiliate' }        // added to every link
};
```

`buildStoreUrl()` composes them into the final URL, adding `utm_campaign=<promo code>` and
`utm_content=<coupon id>` so you can see exactly which code drove each conversion:

```
https://www.shein.com/?utm_source=nipcoupon&utm_medium=affiliate&utm_campaign=shein20&utm_content=c8
```

Leave a tag empty and only the attribution params are appended. All 40 stores have a destination,
so no button is ever a dead end.

### Safety

* only `http(s)` destinations can be opened — `javascript:`, `data:` and anything else are refused
  with a warning toast;
* the new tab's `window.opener` is nulled (the same reverse-tabnabbing protection as
  `rel="noopener"`), and the modal CTA is a real anchor with `rel="noopener noreferrer"`;
* the referrer is deliberately kept, because affiliate networks rely on it for attribution;
* if the browser blocks the pop-up, the code is still copied and the user is told to allow pop-ups.

## Sovrn Commerce (primary monetisation)

`scripts/fetch-sovrn.js` has two jobs, because they really are two different jobs:

```bash
npm run fetch:sovrn:dry    # preview
npm run fetch:sovrn        # wrap every store URL and verify each one
npm run sovrn:revert       # undo — restores every original URL
```

**1. `monetize` (default) — works today with just the API key.** Sovrn wraps any destination
URL and pays you for the click:

```
https://sovrn.co?key=<API_KEY>&u=<encoded destination>&cuid=nipcoupon
```

Every store URL is wrapped, so **all 40 deals monetise at once** and the app keeps appending your
UTMs on top. Each link is then probed live: a valid key returns `302` plus Sovrn's tracking cookie,
an invalid key returns `400` — so a broken key fails loudly instead of silently shipping dead links.
The original URL is preserved in `originalUrl`, and `--revert` puts everything back.

**2. `offers`** — two sources, in priority order:

* **`SOVRN_OFFERS_URL`** — any JSON deal feed. Rows run through `mapFeedItem` and land in
  `data/coupons.json` (this is the only path that produces *coupon codes*).
* **Sovrn Approved Merchants** — with `SOVRN_SECRET_KEY`, the script resolves your campaign via the
  Campaigns API and pulls `POST viglink.io/merchants/rates/summaries?campaignId=…`, registering the
  brands as stores. The merchant list is unsorted long-tail, so rows are **ranked by EPC**
  (earnings per click) and filtered:

```bash
node scripts/fetch-sovrn.js --mode=offers --limit=30 --min-epc=0.05
```

  Each merchant becomes a store with a preferred bare-`.com` domain, a deterministic brand colour,
  a category mapped from Sovrn's vertical codes, and its EPC recorded. **It adds no coupons** —
  this endpoint returns merchant records, not promo codes. Rate limit: 1 request / 10s, so the
  script pools 250 merchants in one call and ranks locally.

> Sovrn's **Product Promo Codes** API (`viglink.io/coupons/product`) — the one endpoint that does
> return codes — answers **401** for this account: it is registration-gated, and the campaign's
> `approvalStatus` is still `PENDING`. Once Sovrn approves the site and enables it, that endpoint
> needs no new code on our side.

| Environment variable | Purpose |
|---|---|
| `SOVRN_API_KEY` | **Required.** Site API key — builds monetised links. |
| `SOVRN_SECRET_KEY` | Optional. Enables Sovrn's own coupon APIs. |
| `SOVRN_OFFERS_URL` | Optional. Any JSON deal feed to ingest in `--mode=offers`. |
| `SOVRN_LINK_BASE` | Default `https://sovrn.co`. |
| `SOVRN_CUID` | Click identifier, default `nipcoupon`. |

Offer mode reuses the same normalisation pipeline as everything else (`api/_data.js`
`makeFeedContext` + `mapFeedItem`), so incoming deals are auto-categorised, new brands are
auto-registered into `data/stores.json`, and `data/coupons.json` is merged behind a timestamped backup.

> **About the key in your data files.** The Sovrn *site* API key appears inside the wrapper URLs in
> `data/stores.json`. That is Sovrn's own design — the same key ships in the `vglnk` JavaScript tag on
> every publisher's page — and `predeploy` reports it as an informational note rather than a failure.
> The **Secret Key** must never appear anywhere in the repo.

## CJ Affiliate sync (automated coupon import)

`scripts/fetch-cj.js` pulls your CJ Affiliate links and merges them into the site.

```bash
cp .env.example .env          # then paste your Personal Access Token into .env
npm run fetch:cj:dry          # fetch and report, write nothing
npm run fetch:cj              # fetch + merge into data/coupons.json
```

| Environment variable | Default | Purpose |
|---|---|---|
| `CJ_ACCESS_TOKEN` | — | **Required.** Personal Access Token (keep it in `.env`, never in git). |
| `CJ_PUBLISHER_ID` | `8058000` | Publisher CID. |
| `CJ_PROPERTY_ID` | `101873115` | Promotional property / PID. |
| `CJ_SOURCE` | `auto` | `auto` (GraphQL, then REST) · `graphql` · `rest`. |
| `CJ_DEFAULT_REGIONS` | `GLOBAL` | Region tag for offers CJ doesn't localise. |
| `CJ_DEFAULT_DAYS` | `30` | Rolling expiry for open-ended offers (the schema needs a date). |

Flags: `--dry-run` · `--replace` · `--no-merge` · `--source=` · `--regions=` · `--default-days=` ·
`--max-pages=` · `--json` (cron/CI) · `--verbose`.

**What it writes**

* `data/cj-links.json` — the clean array: `id, store, title, description, code, affiliateUrl, startDate, endDate`;
* `data/cj-feed.json` — the same rows in NipCoupon's feed shape, so you can point `DEALS_FEED_URL`
  at the deployed file and merge CJ offers **live on every request** (no cron needed);
* `data/coupons.json` — merged into the app's schema, with a timestamped backup in `backups/` first.
  New advertisers are registered in `data/stores.json` and auto-categorised by the same
  normaliser the feed engine uses.

**Two ways to schedule it**

```bash
# 1. cron (every 6 hours)
0 */6 * * * /home/user/nipcoupon/scripts/cj-cron.sh >> /home/user/nipcoupon/logs/cj-cron.log 2>&1
```

The wrapper takes a lock (no overlapping runs), treats "connected but zero links" as a non-failure,
and runs `validate --strict` + `predeploy` before finishing.

```bash
# 2. GitHub Actions — free, and it commits the refreshed data
#    (add CJ_ACCESS_TOKEN as a repo secret): .github/workflows/cj-sync.yml
```

> **Current CJ API status (verified against the live API with your token).**
> `ads.api.cj.com/query` has **no `links` query** — introspection returns only
> `products`, `shoppingProducts`, `travelExperienceProducts`, `financeProducts` and feed queries —
> so the GraphQL path answers `Cannot query field 'links' on type 'Query'`.
> The only CJ API that carries **coupon codes and click URLs** is the REST **Link Search** API
> (`link-search.api.cj.com/v2/link-search`), and it currently rejects this token with
> *"Website id specified does not match your account: 101873115"*, because Personal Access Tokens
> are not enabled for CJ's legacy REST APIs.
> The script tries both, reports the exact reason, and writes nothing when there is no data —
> so it starts producing deals the moment CJ enables REST for your token (or you add the legacy
> API key from **CJ → Account → Web Services**). No code changes needed.

## Before you deploy

```bash
npm run validate           # data health: schema, cross-refs, regions, expiry, i18n parity
npm run validate:links     # + probes every affiliate URL over HTTP
npm run predeploy          # affiliate parameter audit + Vercel free-tier build check
```

`predeploy` exits non-zero if anything would break the deploy: a missing file, a lost or tampered
tracking parameter, a CDN reference, a build command, a secret, or too many serverless functions
for the Hobby tier. Wire it into CI with `--json`.

### What the validator does with expired deals and dead links

```bash
node scripts/validate.js                # report only — never writes
node scripts/validate.js --prune        # also delete expired deals (backed up first)
node scripts/validate.js --links        # probe every affiliate URL over HTTP
node scripts/validate.js --strict       # treat warnings as failures (CI)
node scripts/validate.js --json         # machine-readable summary
LINK_TIMEOUT_MS=15000 node scripts/validate.js --links
```

* **Expired deals** — anything whose `expires` date has passed is reported; with `--prune` it is
  removed and `data/coupons.json` is rewritten only after a timestamped copy is written to
  `backups/coupons-<ISO>.json`.
* **Affiliate links** — `--links` probes the real outbound URL (the one with the tracking
  parameters, not just the store homepage) plus the store's own URL. Verdicts are `ok`, `dead`,
  `suspect` or `unknown`.
* **A non-200 is never treated as a dead link.** Most retailers block datacenter bots, so
  401/403/405/429/451 are *bot walls* (reported `unknown`), 5xx is *transient* (`unknown`), and a
  `HEAD`/`GET` disagreement is re-probed with a second HTTP stack before any verdict is reached.
  Only a **confirmed 404/410 or a dead hostname** counts as `dead`, and even then it is re-checked
  once more before anything is deleted. A coupon is pruned only when its own link *and* its store's
  link are both dead — so a flaky network can never delete a deal that still earns.

## Verified

* `node scripts/validate.js` — schema, cross-references, region codes, i18n parity, expiry.
* 283 automated checks: geo-targeting (58) + storefront regression (43) + i18n (56) + RTL (18) +
  feed integration (55) + validator fault injection (30) + pre-deploy audit (23).
* 175 of those are browser/API checks covering IP detection, the timezone fallback,
  `localStorage` persistence, region filtering, language switching, mirrored RTL geometry,
  in-place re-rendering, and the previously fixed search-clear path.
* Responsive runs at 360 / 390 / 768 / 1024 / 1280 / 1440 px: zero horizontal overflow and zero
  JS console errors, including with the country selector in the header.
* 31/31 interaction checks (clipboard copy, toasts, modals, search, autocomplete, filters, sort,
  pagination, favourites persistence, empty + reset states, forms, mobile menu).

## Project structure

```
nipcoupon/
├── index.html          # the UI (no data in here — it loads everything at runtime)
├── data/               # ← the source of truth. Edit these, never the HTML.
│   ├── stores.json     # 40 brands: colours, logo abbr/glyph, url, affiliate tag
│   ├── categories.json # 5 categories: id, name, icon, blurb
│   ├── coupons.json    # 40 deals: storeId + categoryId + code/badge/terms… + regions
│   ├── regions.json    # 15 markets: code, name, flag, name_ar, default
│   ├── categories.json # also carries name_ar + blurb_ar
│   ├── config.json     # attribution params, page size
│   └── schema.json     # JSON Schema for editor autocomplete/validation
├── locales/            # ← every piece of UI copy (Task 2)
│   ├── en.json         # English (the fallback for missing keys)
│   └── ar.json         # العربية — 217 keys, mirrored 1:1
├── api/                # serverless API (Vercel Functions, zero config)
│   ├── _data.js        # shared loader: JSON + optional remote feed + filter/sort/page
│   ├── _http.js        # CORS + JSON response helpers
│   ├── catalog.js      # GET /api/catalog   — everything in one call
│   ├── deals.js        # GET /api/deals     — filter, sort, paginate
│   ├── stores.js       # GET /api/stores    — brands + live deal counts
│   ├── categories.js   # GET /api/categories
│   ├── regions.js      # GET /api/regions   — markets + deals visible in each
│   ├── geo.js          # GET /api/geo       — IP → country, always falls back to GLOBAL
│   ├── i18n.js         # GET /api/i18n      — translation bundles (one or all)
│   └── deals/
│       └── [id].js     # GET /api/deals/:id — single coupon
└── scripts/
    ├── validate.js     # node scripts/validate.js — catch data mistakes before shipping
    └── preview-server.js  # node scripts/preview-server.js — local static + API server
```

## Data model

Coupons reference stores and categories **by id**, so renaming a brand never breaks a deal.

**`data/stores.json`**
```json
{ "stores": [
  { "id": "amazon", "name": "Amazon", "abbr": "amz", "color": "#ff9900", "fg": "#1a1200",
    "url": "https://www.amazon.com", "affiliateTag": "", "regions": ["GLOBAL"] }
]}
```
`abbr` is the 1–4 characters drawn in the logo tile; supply `glyph` (inline SVG) instead for
logo marks like Apple. `affiliateTag` is a raw query string, e.g. `"tag=your-id-20"`.

**`data/categories.json`**
```json
{ "categories": [
  { "id": "tech", "name": "Tech & Electronics", "icon": "cpu", "blurb": "Laptops, phones, gadgets, home tech." }
]}
```
`icon` must be a key from the `ICONS` map in `index.html` (`cpu`, `shirt`, `plane`, `game`, `code`).

**`data/coupons.json`**
```json
{ "coupons": [
  { "id": "c41", "storeId": "nike", "categoryId": "fashion", "type": "code", "code": "NEW15",
    "badge": "15% OFF", "value": 15, "title": "15% off new arrivals",
    "verifiedHoursAgo": 1, "expires": "2026-12-31", "uses": 120, "rating": 4.5,
    "addedDaysAgo": 1, "hot": true, "terms": ["New customers only"], "landingUrl": "",
    "regions": ["GLOBAL"] }
]}
```
* `type` — `code` (needs `code`) or `deal` (applied automatically, no code).
* `value` — numeric discount, used by the "highest discount" sort.
* `verifiedHoursAgo` — drives the *Verified Today / Xh ago* badge.
* `expires` — `YYYY-MM-DD`; the card shows a live countdown.
* `landingUrl` — optional deep link; overrides the store url for that one coupon.

**`data/regions.json`** — the markets the storefront targets. Exactly one region carries
`"default": true` (the fallback when a visitor cannot be located).
```json
{ "regions": [
  { "code": "GLOBAL", "name": "Worldwide",  "flag": "\u{1F310}", "default": true },
  { "code": "QA",     "name": "Qatar",     "flag": "\u{1F1F6}\u{1F1E6}" }
]}
```

**`data/config.json`** — `attribution` params appended to every outbound link, and `pageSize`.

### Geo-targeting (`regions`)

Every store **and** every coupon carries a `regions` array:

```json
{ "id": "noon", "name": "Noon", "regions": ["SA", "AE", "EG"] }
{ "id": "c7",   "storeId": "noon", "regions": ["SA", "AE", "EG"] }
{ "id": "c8",   "storeId": "shein", "regions": ["GLOBAL"] }
```

A deal is shown to a shopper when its `regions` contains **the selected region OR `"GLOBAL"`**:

| Selected region | Deals shown |
|---|---|
| `GLOBAL` | worldwide deals only (35) |
| `QA` | deals tagged `QA` **plus** every `GLOBAL` deal (39) |
| `AE` | deals tagged `AE` **plus** every `GLOBAL` deal (40) |

Add a market: append `{ "code", "name", "flag" }` to `data/regions.json`, then tag coupons and
brands with that code. Nothing else changes — the picker, the counts and the API all pick it up.
`node scripts/validate.js` rejects unknown region codes and reminds you when a coupon's regions
are missing from its store.

### Adding or updating a deal

Edit `data/coupons.json` (add an object to the array), then run the validator and deploy:

```bash
node scripts/validate.js     # catches bad ids, missing codes, wrong dates…
npx vercel --prod            # or re-upload the folder in the dashboard
```

No HTML or JavaScript changes are ever required.

## API

| Endpoint | What it returns |
|---|---|
| `GET /api/catalog` | config + categories + stores + paginated coupons + meta — one call for the homepage |
| `GET /api/deals` | coupons with `q`, `category`, `store`, `type`, `hot`, `sort`, `page`, `limit` |
| `GET /api/deals/:id` | a single coupon, 404 if unknown |
| `GET /api/stores` | every brand with its live deal count |
| `GET /api/categories` | every category with its live deal count |
| `GET /api/regions` | the region list with how many deals each one sees, plus the default |
| `GET /api/geo` | best-effort country detection for the current visitor (`{ country, source }`) |
| `GET /api/i18n` | every translation bundle + the list of locales · `?lang=ar` returns just one |

`region` is accepted by `/api/catalog` and `/api/deals`. Omit it (or pass `region=ALL`) for no
region filtering at all — which is what the storefront does, so switching country is instant.

```bash
curl 'https://nipcoupon.vercel.app/api/deals?category=gaming&sort=discount&limit=3'
```

Responses are JSON with `Access-Control-Allow-Origin: *` and a 60s shared cache
(`stale-while-revalidate=300`), so other clients can consume the same catalogue.

### Country detection — `GET /api/geo`

```json
{ "country": "QA", "supported": true, "source": "edge-header", "detected": "QA",
  "regions": ["GLOBAL","QA","SA","AE", ...] }
```

| `source` | Meaning |
|---|---|
| `edge-header` | `x-vercel-ip-country` (or `cf-ipcountry`) — free, instant, no network call |
| `ip-lookup` | public IP lookup, used when no edge header is present (local dev, other hosts) |
| `unsupported-country` / `lookup-unavailable` | visitor is in a market we don't cover, or the lookup failed |
| `fallback` | → `GLOBAL` |

Unsupported countries are mapped to `GLOBAL`, never to an empty storefront.

### Translations — `GET /api/i18n`

```json
GET /api/i18n?lang=ar
{ "lang": "ar", "dir": "rtl", "translations": { "nav.categories": "الفئات", … } }

GET /api/i18n
{ "locales": ["ar","en"], "default": "en", "rtl": ["ar"], "translations": { "ar": {…}, "en": {…} } }
```

Supported languages come from the files in `locales/`, so **dropping in `fr.json` adds French** —
no code change. `rtl` is computed from a built-in list (`ar`, `he`, `fa`, `ur`).

### Auto-fetching deals from a remote feed

Set the **`DEALS_FEED_URL`** environment variable (Vercel → Settings → Environment Variables) to any
URL that returns a JSON array of coupon objects, or a wrapper object
(`{ "coupons" | "deals" | "offers" | "items" | "data" | "results": [...] }`). The API merges it with
`data/coupons.json` at request time. **None of these variables are required** — without them the site
is a pure static deployment and every response reports `feed: { "status": "disabled" }`.

| Variable | Default | Purpose |
|---|---|---|
| `DEALS_FEED_URL` | — | Feed endpoint. Enables the merge. |
| `FEED_TOKEN` | — | Optional `Authorization: Bearer <token>`. |
| `FEED_TIMEOUT_MS` | `4000` | Per-request timeout. |
| `FEED_MAX_ITEMS` | `300` | Hard cap on rows parsed per pull. |

What the merge does, in order:

1. **Normalises** each row — field aliases are generous (`merchant`/`brand`/`advertiserName`/…,
   `deeplink`/`url`, `voucherCode`/`code`, `endDate`/`expiresAt`/`validUntil`, `discountValue`/`discount`).
2. **Categorises** it automatically: keyword scoring across the 5 categories, then a built-in
   brand→vertical table (`Ubisoft → gaming`, `NordVPN → software`, `Expedia → travel`, …), then the
   store's own lane as a last resort. A brand new to the site is **registered as a store on the fly**
   (deterministic colour, `fromFeed: true`) so it shows up in the store grid immediately.
3. **Drops** junk rows — expired, no store, no title, no link, duplicate `id`, duplicate code — and
   counts the reason for each.
4. **Never loses local data**: if the feed errors, times out or returns an unsupported shape, the
   local catalogue is served untouched. The last successful pull is also cached in-process and
   replayed as a *feed snapshot* for 5 minutes, so a flaky network can't empty your deals page.

`/api/deals` reports exactly what happened on every call:

```jsonc
"feed": {
  "status": "ok",              // or "disabled" | "error: HTTP 500" | "error: timeout after 4000ms" | …
  "fetched": 14, "merged": 7, "skipped": { "duplicate-id": 1, "expired": 1, "no-store": 2 },
  "storesAdded": 4, "autoCategorised": 4, "durationMs": 231
}
```

`?source=local` and `?source=feed` post-filter the merged result for debugging.

Ideal for wiring up a network API (Awin, Rakuten, Impact, CJ) or your own scraper on a cron.

## Loading strategy in the browser

`index.html` asks `api/catalog` first, and if that route does not exist (plain static hosting,
local `file://`-style previews) it falls back to fetching `data/*.json` directly — including
`data/regions.json`. Both paths feed the same normaliser, so the UI behaves identically.

**Region flow on page load**

1. A previously saved choice (`localStorage` key `nipcoupon:region`) is applied immediately — no
   network wait, no flash of the wrong country.
2. Otherwise the visitor's country is detected in the background, in this order:
   `GET /api/geo` → browser timezone → `GLOBAL`.
3. Switching region **re-renders in place** — the grid, store tiles, category counts, hero chips
   and result caption all update without a page reload, and the choice is saved for next time.

Phones get the same list as a `<select>` inside the burger menu; the header picker is hidden below
760px. Keyboard: the menu closes with `Escape` or an outside click, and `aria-expanded` /
`aria-selected` are kept in sync.

## Multi-language (i18n) & RTL

Every string lives in `locales/en.json` and `locales/ar.json`. The UI never hard-codes copy:

* **static markup** — `<span data-i18n="nav.categories">`, plus `data-i18n-html` (trusted
  inline HTML), `data-i18n-ph` (placeholders), `data-i18n-aria` and `data-i18n-title`;
* **rendered markup** — `t('card.get_code', 'Get Code', { vars })`.

`t()` resolves **active language → English → the inline fallback**, so a missing or broken
bundle can never blank the page out. The first translation pass stores the original English in
`data-i18n-fb`, which is what the fallback reads.

**Language flow on page load**

1. `localStorage['nipcoupon:lang']` if the visitor chose one before — applied before the first
   paint, so there is no flash of the wrong language.
2. Otherwise the browser's `navigator.languages` is matched against the available bundles
   (an `ar-*` browser gets Arabic), and that choice is saved.
3. Anything else → English.

**Switching** (`#langPicker` in the header, `#mpLang` in the burger menu) calls `applyLang()`,
which sets `<html lang>` + `<html dir>`, re-translates the static markup and re-renders every
dynamic list — grid, store tiles, category chips, pills, modals, ticker, toasts — **in place**.
No reload, and the preference is saved for next time.

**RTL**: `dir="rtl"` is set on `<html>`, and flex/grid rows mirror on their own. A small
`[dir="rtl"]` block in the stylesheet flips the handful of physical properties (toasts and
back-to-top to the left, dropdown `right → left`, the hot ribbon to the left corner, arrow and
chevron transforms, and the shimmer/toast keyframes). Arabic gets Arabic-capable fonts, no
letter-spacing on uppercase eyebrows, and Latin digits with locale grouping
(`Intl.NumberFormat('ar-EG-u-nu-latn')`) so codes and prices stay readable.

Data carries its own translations: `categories.json` has `name_ar` / `blurb_ar`, and
`regions.json` has `name_ar`. Brand names, coupon titles and codes stay as-is — they are the
merchant's own words.

### Adding a language

1. Copy `locales/en.json` → `locales/<code>.json` and translate the values (keep the keys).
2. Add the language to `LANG_META` in `index.html` (`{ en, ar, fr: { name, native } }`).
3. Register it as RTL in `RTL_LANGS` if it reads right-to-left.

`node scripts/validate.js` fails the build if a bundle is missing keys, if a key the UI asks for
does not exist, or if a value was left in English.

> Note: on static-only hosting you will see one harmless `404 /api/catalog` in the console — that
> is the probe before the fallback kicks in.
