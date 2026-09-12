# NIPCOUPON — Progress

Live: https://nipcoupon.vercel.app · Repo: `ir44747-stack/nipcoupon`

**Stack:** static `index.html` (vanilla JS SPA) + serverless functions in `api/`,
deployed on Vercel with `"framework": null`. No React, no Next.js, no TypeScript.
Build is `node scripts/build-analytics.js && node scripts/build-sitemap.js && node scripts/minify.js`.

---

## SEO Engine — ✅ complete

| Area | Status | Where |
|---|---|---|
| Dynamic per-page titles | ✅ | `api/page.js` — 115 unique titles, all ≤62 chars, month+year stamped |
| Dynamic meta descriptions | ✅ | `api/page.js` + `scripts/keyword-sync.js` — 115 unique, ≤155 chars |
| OpenGraph + Twitter cards | ✅ | `api/page.js` — `og:image` 1200×630 on every route |
| Freshness signals | ✅ | "Verified Today" / "Checked 2 hours ago" from `verifiedHoursAgo` |
| Offer schema | ✅ | 40/40 coupon pages — `price`, `priceCurrency`, `validThrough`, `seller` |
| AggregateRating | ✅ | 40/40 via a `Product` node (invalid directly on `Offer`) |
| **AggregateOffer** | ✅ | store pages — `offerCount` + up to 25 nested offers |
| **FAQPage** | ✅ | guide pages — only where the Q&A is visibly rendered |
| **Article** | ✅ | guide pages — `datePublished`, `dateModified`, publisher |
| BreadcrumbList | ✅ | every SSR route, matching the visible crumb trail |
| Organization + WebSite | ✅ | shared `@id` graph across SSR **and** homepage |
| CollectionPage | ✅ | store, category, blog index, homepage |
| robots.txt | ✅ | allows all, disallows `/api/`, lists 4 sitemaps |
| sitemap (generated) | ✅ | `scripts/build-sitemap.js` — 90 URLs, 4-file index, nightly in CI |
| Affiliate compliance | ✅ | `rel="nofollow sponsored noopener"` on every outbound link |
| Click tracking | ✅ | GA4 `click_affiliate` fires before redirect, with acquisition channel |
| Heading hierarchy | ✅ | 115/115 SSR routes + homepage: one H1, zero skipped levels |
| **Blog / guides engine** | ✅ | `/blog` + `/blog/:slug` from `data/posts.json` |

### Not implemented, and why

- **Instant indexing (IndexNow / Indexing API).** Google's Indexing API only accepts
  `JobPosting` and `BroadcastEvent`; submitting coupon pages through it violates the
  terms. IndexNow is supported by Bing and Yandex only. An `INDEXNOW_KEY` secret exists
  in CI but no endpoint is wired — deliberately, pending a decision on Bing-only value.
- **Historical success rate %, estimated total saved.** No redemption-attempt log and no
  basket-value data exist, so any figure shown would be fabricated. The store stat rail
  uses real fields only: live offer count, averaged rating, best discount, last verified.
- **Product imagery on deal cards.** No image pipeline; cards use generated brand-colour
  banners instead of placeholder photography.

---

## Platform

| Area | Status |
|---|---|
| Coupon catalogue | ✅ 70 stores · 40 live offers · 5 categories · 15 regions |
| Geo storefront routing | ✅ edge middleware + `api/_geo.js`, links localised per market |
| i18n (en / ar) | ✅ 223 keys, full RTL |
| Monetisation | ✅ 70/70 stores via Sovrn wrapper with `cuid` attribution |
| Analytics | ✅ GA4 `G-MSF77ECT4G` + Vercel Web Analytics on all surfaces |
| Featured Deals feed | ✅ homepage, 6 ranked cards, brand/category diversified |
| SSR store & coupon pages | ✅ dark design system, click-to-reveal, copy-to-clipboard |
| Favicon set | ✅ ico + png set + apple-touch + manifest |
| Daily automation | ✅ `daily-growth.yml` — keyword rotation + sitemap rebuild, nightly |
| Link health | ✅ `link-guard.js` + `validate.js --links`, bot-wall aware |

## Known issues

- `data/schema.json` drift is now caught by `validate.js` as a warning (error under `--strict`).
- `link-guard` exits 1 on `link-unknown`, which is flaky from any sandboxed network.
  Worth deciding whether timeouts alone should fail CI.
- The `daily-growth.yml` push step has no `set -o pipefail`, so a rejected push inside
  the pipeline still reports success.
