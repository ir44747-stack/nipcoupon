# NIPCOUPON — Agent Log

Chronological record of automated changes. Newest first.

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
