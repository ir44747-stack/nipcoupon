# NIPCOUPON — Agent Log

Chronological record of automated changes. Newest first.

---

## 2026-09-21 — Multi-source offer architecture

Made inventory source-independent so a new provider can be attached without
touching the rest of the site. No new provider was connected — none has
credentials — and no offer was invented.

### Discovery that changed the picture
The 30 stores with ZERO offers are exactly the 30 carrying a real `sovrnEpc`
(0.08-0.63) plus `sovrnGroupId` and `sovrnVerified: true`. They came from a
Sovrn **merchant** feed. So Sovrn ingestion is not blocked in general — only
coupon syndication is. We are already being paid per click on the stores we
have the least to show for. moo-com (0.628), rocketlanguages (0.538) and
lightsonline (0.465) are the clearest examples: highest EPC, nothing to click.

That also means `offerScore()`'s EPC term is not dead code — it activates the
moment any of those 30 stores receives an offer.

### Added
- `data/sources.json` — source registry. Each entry carries adapter, priority,
  trust, enabled flag, required credential and status. Sovrn coupon API is
  recorded as `not-entitled` with the probe evidence and an explicit
  "do not re-probe on a schedule" note.
- `api/_offers.js` — the source-independent layer:
  - `canonical()` maps any adapter's row to one internal schema (storeId,
    source, externalOfferId, code, title, value, type, originalUrl,
    trackingUrl, expires, terms, verifiedAt, verificationStatus, lastSeenAt,
    sourcePriority, sovrnEpc). Absent data stays null — `sovrnEpc: null` means
    "nobody told us", not "earns nothing".
  - `gate()` returns PENDING / VERIFIED / EXPIRED / REJECTED / UNKNOWN with
    reasons. Only gate() may assign VERIFIED, and only from a real timestamp
    inside a 48h window. A feed claiming its own offer is verified is ignored.
  - `reconcile()` dedupes by storeId+code (case-insensitive) or storeId+title
    for deals, prefers VERIFIED then fresher then lower sourcePriority, and
    keeps the losing record under `alternates` so provenance survives. Nothing
    is deleted; EXPIRED and REJECTED are retained for analytics and filtered at
    render.
- `scripts/inventory.js` — per-store dashboard and alerts. CRITICAL exits 1 and
  opens an incident through the existing health-check path.
- `data/offers-manual.json` — the only hand-entry point, with instructions.
  Manual records pass the same gate; nothing is published for being typed in.

### Bug found in my own gate before it shipped
"type=deal carrying a code" passed as VERIFIED. `canonical()` blanks `code` for
a deal, so the gate never saw the contradiction — the feed was saying two
different things and the normalisation hid it. Now the raw value is retained
internally for the check. Verified across 13 adversarial cases: 13/13 correct.

### Not changed
Sovrn monetisation stays exactly as it was and is still verified working.
Store index state is unchanged at 40/30, so no indexing instability was
introduced.

---

## 2026-09-21 — Phase 3: store-page value, offer scoring, index gating

Goal was inventory growth and breaking the 93% overlap. Inventory turned out to
be blocked upstream; the overlap was not, so that is where the work went.

### Sovrn coupon syndication — investigated, BLOCKED
Probed the Product Promo Codes API (viglink.io/coupons/product) with the site
key and the secret key across six auth methods: query param, secret_key param,
Bearer, `secret`, X-Secret-Key, and HTTP basic. Every one returns **401**. The
endpoint itself is reachable — omitting params returns a descriptive 400 naming
`product_url` and `api_key` — so this is an entitlement decision on Sovrn's
side, not a wiring bug. Monetisation is unaffected and still verified working
(valid key -> 302, invalid -> 400).

Conclusion: **offer inventory cannot grow from Sovrn today.** No offer was
invented to compensate. Needs Sovrn to enable coupon-API access on the account,
or a separate feed via SOVRN_OFFERS_URL, which fetch-sovrn.js already supports.

### Store-specific troubleshooting — implemented
The 40 live offers carry **117 distinct condition strings** that already differ
per store and were being rendered only as a terms list on the coupon page.
`troubleshootReasons()` classifies them against 8 patterns (minimum spend,
exclusions, new-customer, usage limit, account required, non-stackable, region,
discount cap) and renders a "Why isn't my [Store] code working?" section.

Each bullet prints the verbatim term it was derived from, so every claim is
auditable against the data. 25 of 40 stocked stores produce at least one
reason; the other 15 get an explicit statement that no conditions are published
rather than generic filler. Nothing is inferred about a merchant.

Measured: median unique tokens per indexed store page **17 -> 34**, median
unique share **9.2% -> 16.6%**, Amazon-vs-Nike token overlap **93% -> 84%**.

### scripts/content-quality.js — new
Renders all 70 store pages, derives the shared boilerplate as tokens appearing
on more than half of them, and reports per page: word count, unique tokens,
unique %, offers, published conditions, FAQ count, troubleshooting reasons, and
index state. `--min=N` can fail CI, but it is wired into the 6-hourly workflow
non-blocking: a low score means "add real facts", not "break the build".

### offerScore() — internal ranking only
Blends verification freshness, discount, engagement, rating, code-vs-deal,
editorial flag, documented conditions and genuine urgency; expired offers score
-1000 so they can never rank. Reads `sovrnEpc` when present — absent for every
store today, so it contributes nothing yet and will improve the ordering
automatically if affiliate performance data ever lands.

Explicitly **not** a verification claim. The only verification signal shown to
users remains the `verifiedHoursAgo` timestamp from the automated re-check.

### storeIndexable() — one gate, auditable
Indexing now requires a live offer AND something store-specific to say, and
returns the reason rather than a bare boolean. Both the page's robots tag and
the sitemap read the same function, so they cannot drift. Inputs change only
when the catalogue changes, so pages cannot flip index state on crawl noise.
Verified: 40 index / 30 noindex — identical to before, so no instability was
introduced.

---

## 2026-09-21 — Full A-to-Z audit

Audited code, data, links, icons, automation, security, SEO, performance and the
end-to-end user journey. Four real defects found and fixed; everything else was
already healthy and was left alone.

### Fixed
1. **21 store URLs wasted a redirect hop** (39 of 70 redirected; 21 were safely
   canonicalisable). Mostly a missing `www`. Every hop is latency on a monetised
   click and a weaker affiliate handoff. Rewrote `originalUrl` and kept the
   `?u=` payload inside the Sovrn wrapper in sync, preserving the
   `${SOVRN_API_KEY}` placeholder. Re-probed: 21/21 now resolve in 0 hops.
   Deliberately skipped cross-domain, query-adding and path-deepening redirects
   (e.g. `spotify.com` -> `open.spotify.com`, `norton.com` -> `us.norton.com`)
   because those change the destination, not just its canonical form.
2. **Apple rendered as the text "APPL".** `logoTile()` fell back to slicing the
   store name whenever `abbr` was empty, ignoring the `glyph` SVG the record
   actually carries — the SPA honoured it, the SSR pages did not, so the two
   surfaces disagreed on the brand's identity. Now renders the SVG, with an
   `^<svg` guard so a data file cannot inject markup.
3. **Expired offers were never removed.** `build-sitemap` hid them from the
   sitemap but the pages stayed live and the homepage kept listing them, so a
   shopper could reach a code that cannot work. Added `prune` +
   `validate` + sitemap-rebuild steps to `daily-growth.yml`. Prune keys off a
   confirmed expiry date only, never a link probe, so a flaky network can never
   delete live revenue. Removes 0 today; acts when offers genuinely lapse.
4. **A failed nightly push reported success.** The commit step used
   `... || (git commit && git push)` with no `pipefail`, so a rejected push
   exited 0 and the sync silently persisted nothing. Now fails loudly with
   `::error::`.
5. **No clickjacking protection.** Added `X-Frame-Options: SAMEORIGIN` and
   `Cross-Origin-Opener-Policy` — the site could be framed and an attacker could
   overlay the affiliate CTA.

### Verified healthy, no change made
- 34 JS files + 3 inline scripts parse; 16 JSON files valid; i18n 223/223.
- Data: 0 duplicate ids/names/URLs/codes/titles, 0 orphans, 0 bad category or
  region refs, 0 expired, 0 type/code mismatches, 0 ratings out of range.
- 119 routes render, 0 errors, 0 bad JSON-LD, 0 missing canonical, 0 thin pages,
  97 internal links all resolving.
- Security: no secret reachable from the browser, no 32-hex key in the client
  bundle, `api/_*.js` unroutable, `npm audit` 0 vulnerabilities, all 26
  `innerHTML` writes escaped.
- Journey tested in a real browser, desktop and mobile: search (incl. typo and
  empty states), filters, reveal, copy-to-clipboard, and the affiliate open —
  tracking fires before the redirect.

### Flagged, not "fixed"
- **7 merchant URLs returned curl status 000** (TLS handshake, exit 35).
  Investigated rather than pruned: DNS resolves, a direct `openssl s_client`
  handshake succeeds, and the same merchants return 302 through the Sovrn
  wrapper. This is sandbox egress, not dead merchants. No data touched.
- **SSR routes are never CDN-cached** (`x-vercel-cache: MISS` on every hit,
  `max-age=0` overriding the function's `s-maxage=3600`). Cause: every SSR path
  passes through `middleware.js` for geo routing, and Vercel disables the CDN
  for middleware-handled responses. Platform behaviour, not a code bug. TTFB is
  still 0.14-0.29s, so this is a cost/scale concern rather than a user-facing
  one. Fixing it means dropping geo routing or moving it client-side — a product
  decision, not a safe unilateral change.

---

## 2026-09-13 — Supervisor routine: automated health check

Full audit run against the directive's three monitoring areas. **No defects
found in the platform** — nothing needed fixing, so nothing was changed in the
site itself. What was missing was the monitoring apparatus, which is what this
commit adds.

### Audit result (all green)
- 34 JS files + 3 inline scripts parse; 16 JSON files valid; i18n parity 223/223.
- 119 routes render, 0 errors, 0 bad JSON-LD, 0 dangling `@id`.
- `AggregateOffer` on 40/70 stores — correct, the other 30 have no live offers
  and are already `noindex,follow` as thin content.
- `FAQPage` on 70/70 stores + 3/3 guides, `Article` on 3/3 guides,
  `Offer.price` and `aggregateRating` 40/40.
- 0 FAQ items present in schema but missing from the visible page.
- 150/150 outbound links carry `nofollow sponsored noopener noreferrer`.
- 119/119 exactly one H1, zero skipped heading levels, zero over-length meta.
- 183 sitemap lastmod values, 0 in the future. 14/14 live routes correct,
  homepage 200 in 0.20s. Link guard: 0 dead, 7 sandbox timeouts.
- Both nightly workflows green (`Daily Growth` #17, `Sync coupons` #15).

### Added
- `scripts/health-check.js` — one command covering syntax, JSON, every rendered
  route, schema validity, FAQ visibility, affiliate `rel` compliance, heading
  hierarchy, meta length, duplicate titles, sitemap sanity, and optional live
  probes. Exit 0/1, `--json` for machine consumption.
- `.github/workflows/health-check.yml` — runs it every 6 hours and on every push
  to `main`. On failure it opens a `health-check` issue, reuses it while the
  failure persists, and auto-closes when green again.
- `npm run health`, `health:live`, `health:json`.

### Bug found in my own check, before it shipped
The first version matched affiliate links with `/sovrn\.co/`. In CI there is no
`SOVRN_API_KEY`, so `store.url` keeps its `${SOVRN_API_KEY}` placeholder and
resolves to the bare merchant domain — the literal string `sovrn.co` never
appears, and the check reported a cheerful `0/0 compliant` while inspecting
nothing. It now matches any external anchor and skips internal links, so it sees
all 150. Verified by deliberately stripping the `rel` tokens from `api/page.js`
and confirming the check fails with named routes, then restoring.

A check that silently passes is worse than no check, because it is trusted.

### Note on the hourly cadence
Set to every 6 hours, not hourly. The catalogue only changes when
`daily-growth` (00:00) or `sync-coupons` (02:00) runs, so hourly checks would
re-verify an unchanged repo 22 times a day; and the same failure re-notified
every hour is one incident, not twenty-four. Easy to raise if the data ever
starts updating intra-day.

---

## 2026-09-12 — SEO plan adapted to the vanilla stack (round 2)

Second pass on the same plan, this time closing the gaps that remained after the
first adaptation. Stack unchanged: vanilla JS + serverless. No Next.js, no
migration, trax50-sneakers untouched.

### Step 1 — store title & description patterns
- Titles now follow the requested pattern:
  `[Store] Coupon Code [Month Year] — Exclusive [N]% Off | NIPCOUPON`.
  `clampTitle()` trims on a word boundary at ~62 chars, so on long store names the
  ` | NIPCOUPON` suffix is dropped rather than the keyword being cut mid-phrase.
- **Only percentage badges feed the `[N]%` slot.** AliExpress' best offer is
  "$8 OFF" — a cash amount. Rendering that as "8% Off" would be a false claim in
  the single string every searcher reads, so those stores get the plain title.
- Descriptions follow: "Get the latest verified [Store] promo codes and discount
  deals for [Year]. N codes tested [Month Year] — save money today on NipCoupon!"
- Verified: 70/70 unique titles, 0 over 62 chars, 0 descriptions over 155.

### Step 1 — freshness signals
- "Verified Today" pill when the freshest offer was checked within 24h.
- "Last checked [today's date]" on store and coupon pages. Honest because
  `daily-growth.yml` re-verifies nightly; if that automation is removed, this
  must be removed with it.

### Step 2 — FAQPage on store pages
- `storeFaqs()` generates four questions per store from that store's real
  catalogue — offer count, code-vs-deal split, verification recency, cost — so the
  text is specific rather than the same boilerplate across 70 pages.
- Rendered into visible `<details>` **and** into JSON-LD from one array.
  Verified across all 70 stores: 0 questions and 0 answers missing from the
  rendered HTML.

### Step 4 — affiliate link compliance
- Added `noreferrer` to the SSR affiliate links (previously
  `nofollow sponsored noopener`).
- The SPA's coupon-modal anchor carried only `noopener noreferrer` — it has a real
  `href`, so crawlers were free to follow a monetised link. Now
  `nofollow sponsored noopener noreferrer`.
- Verified: 150/150 outbound sovrn.co anchors carry all four tokens.

### Verification
119 routes render, 0 errors, 0 bad JSON-LD · 119/119 exactly one H1, zero skipped
heading levels · store schema now
`WebSite, Organization, CollectionPage, AggregateOffer, FAQPage, BreadcrumbList` ·
coupon price and aggregateRating 40/40 · build exit 0, verify gate passed, −26.1% ·
validate --strict and check-geo green · i18n parity 223/223.

---

## 2026-09-12 — SEO engine: blog, FAQPage, AggregateOffer

**Context.** The requested plan specified Next.js 15 paths (`app/stores/[slug]/page.tsx`,
`components/seo/coupon-schema.tsx`, `app/sitemap.ts`, `app/robots.ts`). NIPCOUPON is not a
Next.js project — no `app/`, no `components/`, zero `.tsx` files, `"framework": null`, and
its only dependency is `@vercel/analytics`. Those paths belong to a different repository in
the same account (`trax50-sneakers`). Creating a parallel Next.js tree here would have
installed a second framework beside a working site and broken `npm run build`, which Vercel
runs on every deploy. The plan was therefore implemented against the real stack, and only
where a genuine gap existed.

**Audited as already complete — not touched:** per-page titles and descriptions, OG/Twitter
cards, freshness badges, `Offer`, `AggregateRating`, `BreadcrumbList`, `Organization`,
`WebSite`, `robots.txt`, the generated sitemap, and affiliate `rel` + click tracking.

### Files created
- `data/posts.json` — three saving guides. Body is a block list (`p`, `h2`, `h3`, `ul`,
  `faq`); `faq` entries render into the page **and** into `FAQPage` JSON-LD.
- `PROGRESS.md` — this project's status board.
- `AGENT_LOG.md` — this file.

### Files modified
- `api/page.js`
  - `loadPosts()`, `readableDate()`, `renderBlocks()`, `faqSection()` helpers.
  - `/blog` index route: `CollectionPage` + `ItemList` + `BreadcrumbList`.
  - `/blog/:slug` route: `Article` + `FAQPage` + `BreadcrumbList`.
  - `AggregateOffer` on store pages — `offerCount` plus up to 25 nested `Offer` nodes.
  - Guide and FAQ accordion CSS, reusing the existing design tokens.
- `vercel.json` — rewrites for `/blog` and `/blog/:id`.
- `scripts/preview-server.js` — same two routes locally, so the preview matches production.
- `scripts/build-sitemap.js` — guides added to the URL set and to `sitemap-pages.xml`.
  Their `lastmod` comes from the post's own `updated` field rather than a content hash.
- `index.html` — "Saving Guides" link in the footer, so `/blog` is reachable by crawl.
- `locales/en.json`, `locales/ar.json` — `foot.guides`. Parity 223/223.

### Decisions worth recording
- **`FAQPage` is emitted only where the Q&A is visibly rendered.** Google requires the
  answer to be on the page; emitting FAQ markup for hidden content is a structured-data
  violation, not a free SERP upgrade. A visible `<details>` accordion is generated from the
  same source array the schema reads, so the two cannot diverge.
- **`AggregateOffer` prices are 0, not the discount percentage.** A percentage is not a
  price. A coupon costs nothing to claim, so `lowPrice`/`highPrice` of 0 is the honest
  value; the saving applies to the merchant's basket.
- **Guide `lastmod` is author-set, not hashed.** Editorial content changes when the author
  says it does. Hashing would move the date on cosmetic edits and teach crawlers to
  distrust it.

### Verification
`/blog` 200 · 3 guides 200 · unknown slug 404 · schema per route confirmed
(`Article, FAQPage, BreadcrumbList` on posts; `AggregateOffer` on stores) · all 10 FAQ
questions and answers present in the visible HTML, 0 missing · sitemap 86 → 90 URLs ·
`npm run build` exit 0, verify gate passed, −26% · i18n parity 223/223 · one H1 and zero
skipped heading levels on guide pages.

---

## 2026-09-12 — Homepage JSON-LD, heading hierarchy, minify gate

- Added `WebSite` / `Organization` / `CollectionPage` / `ItemList` to `index.html`; the root
  URL previously had no structured data at all. `@id` values match `siteSchema()` so all
  surfaces share one entity graph. `ItemList` is written at runtime from the rendered
  featured picks, so the markup can never advertise offers the page does not show.
- Footer headings `h4` → `h3`; the document had been skipping h2 → h4.
- **Fixed a latent bug in `scripts/minify.js`:** the final safety gate ran every inline
  `<script>` through `new Function()` without checking `type`, so the new `ld+json` block
  threw on its first `:` and the build silently shipped unminified HTML at 0% reduction.
  Data blocks are now validated as JSON. Minification restored to −26%.

## 2026-09-07 — Featured Deals feed

Six-card marketplace section between the hero and the brand grid, ranked by discount,
freshness, popularity, rating and urgency, with one offer per brand and max two per
category. Fixed along the way: `hot` over-weighted (ribbon on 5 of 6 cards), ribbon
overlapping the store logo, RTL discount slab covering the logo, and `toggleFav` not
syncing hearts outside `.card`.

## 2026-09-05 — Favicon set

`favicon.ico` (16/32/48), PNG set, 180×180 apple-touch icon flattened onto `#0f172a`,
192/512 manifest icons, SVG, and `site.webmanifest`. Previously the homepage declared a
`data:` URI favicon, which is not fetchable and so never indexed, and the ~110 SSR routes
declared none at all.

## 2026-09-05 — SSR store & coupon page redesign

Rebuilt both page types on the dark design system: logo tile, stat rail, glassmorphism
cards, click-to-reveal with copy-to-clipboard, affiliate disclosure. Fixed a `Verified` tag
that never rendered (`_data.js` strips the `verified` boolean), a stranded "OFF" label, and
`$8 OFF` being reported as "8%".

## 2026-09-02 — Technical SEO pass

Soft-404 fix (404s were `index,follow` with a homepage canonical), `og:image` on SSR routes,
acquisition-channel dimensions on the affiliate click event, `data/schema.json` drift guard
in `validate.js`, and seasonal keyword coverage extended from 166 to 231 days a year.
