# Secure API & Dynamic Links

How NipCoupon stores credentials, pulls offers from a provider, and decides
which links are allowed onto the site.

---

## 1. Environment variables

**No credential is ever written in source code or a data file.**

Everything flows through `api/_secrets.js`, the single module allowed to read
credentials. It reads `process.env` (Vercel injects these) and falls back to a
local `nipcoupon/.env` in development.

### Setting them on Vercel

Project → Settings → Environment Variables → add each key for **Production**
and **Preview**, then redeploy.

| Variable | Secret? | Purpose |
|---|---|---|
| `OFFERS_API_URL` | no | The authorised endpoint `sync-offers.js` reads offers from |
| `OFFERS_API_KEY` | **yes** | Credential for that endpoint (sent as `Authorization: Bearer …`) |
| `OFFERS_API_HEADER_NAME` | no | Override header name (default `Authorization`) |
| `OFFERS_API_HEADER_STYLE` | no | `Bearer` (default) or `raw` |
| `SOVRN_API_KEY` | **yes** | Sovrn site key — publisher ID used in monetised links |
| `SOVRN_SECRET_KEY` | **yes** | Sovrn API secret — never placed in any URL |
| `SITE_URL` | no | Base domain for canonical URLs (default `https://nipcoupon.vercel.app`) |
| `LINK_GUARD_ALLOWLIST` | no | Comma-separated hosts permitted in published links |
| `CJ_ACCESS_TOKEN` | **yes** | CJ (suspended, retained) |

Full list with comments: `.env.example`.

```bash
cp .env.example .env && chmod 600 .env
```

`.env` is git-ignored and excluded from the deploy zip.

### Why placeholders instead of real keys in `data/`

Store URLs hold `${SOVRN_API_KEY}`, not the key:

```json
"url": "https://sovrn.co/?key=${SOVRN_API_KEY}&u=https%3A%2F%2Fwww.amazon.com&cuid=nipcoupon"
```

`api/_data.js` expands it per request, server-side. One env var change
re-points all 70 links, and no backup keeps a stale copy. If the variable is
missing the store falls back to `originalUrl` — a working, non-monetised link
rather than a 400.

### Auditing and purging

```bash
npm run secrets:audit    # report: any live secret in tracked files? (exit 1 if found)
npm run secrets:purge    # rewrite them as ${VAR} placeholders
```

`purge-secrets.js` also scans `backups/` with `--backups`.

> **Note on the Sovrn key in rendered HTML.** The resolved affiliate link
> contains the Sovrn site key, because that is how click attribution works —
> it is a publisher ID, not the API secret. It appears on exactly one line of
> `/coupon/:id`: the outbound `href`. It is absent from source, data files,
> meta tags, canonical URLs and JSON-LD. The real secret
> (`SOVRN_SECRET_KEY`) appears nowhere.

---

## 2. Verified link generation

```bash
npm run sync:offers        # fetch → validate → publish
npm run sync:offers:dry    # preview changes, write nothing
```

`scripts/sync-offers.js`:

1. **Fetch** — one authorised endpoint (`OFFERS_API_URL`), authenticated with
   `OFFERS_API_KEY`. It refuses to run unauthenticated.
2. **Normalise** — accepts the common provider envelopes (`offers`, `coupons`,
   `deals`, `items`, `data`, `results`, `promotions`, or a bare array).
3. **Map to our domain** — every offer gets a canonical path on
   `nipcoupon.vercel.app`, never the provider's URL:

   | Page | Path |
   |---|---|
   | Coupon | `/coupon/<store>-<code>` |
   | Store | `/store/<store-id>` |
   | Category | `/category/<category-id>` |

4. **Validate** — every link through `link-guard.js`. Rejected offers are
   dropped.
5. **Publish** — merge into `data/coupons.json`, backing up first, and save
   `data/provider-snapshot.json`.

These paths are real server-rendered pages (see `api/page.js` and the
`rewrites` block in `vercel.json`) with title, meta description, canonical,
Open Graph and JSON-LD — so a crawler indexing `/coupon/amazon-save20` gets
real HTML, not an empty JS shell.

---

## 3. Validation and fallback

Four gates. A link is published only if it clears all four.

| Gate | Rejects |
|---|---|
| **Syntax** | empty, unparseable, `javascript:`/`data:`/`file:`, plain `http:`, credentials in URL, unresolved `${…}` |
| **Policy** | host not on the allowlist, localhost / private IP / raw IP |
| **Freshness** | past `expires`, or `verified: false` from the provider |
| **Live** | HEAD probe (GET fallback on 405/501/0) returning 404/410/4xx/5xx |

```bash
npm run links:guard                            # validate the whole catalogue
node scripts/link-guard.js --url=https://…     # validate one URL
```

### Bot walls are not broken links

`403 / 429 / 401` are classified **`blocked`**, not `dead`. Major retailers
bot-wall datacenter IPs; treating that as a dead link would silently delete
good inventory. `blocked` links are published and simply probed less often.

| Status | Verdict | Published? |
|---|---|---|
| 200–3xx | `ok` | yes |
| 401 / 403 / 429 | `blocked` | yes |
| 404 / 410 / other 4xx | `dead` | no |
| 5xx / timeout / DNS | `unknown` | no |

### Fallback: an outage must never wipe the catalogue

Verified behaviours:

- **Provider unreachable** → logs the error, leaves `data/coupons.json`
  untouched, reports the age of the last good snapshot, exits `1`.
- **Provider returns only invalid links** → nothing is published, the file is
  untouched, exits `1`.
- **Some links fail** → only the good ones are published.

In every failure case the site keeps serving yesterday's deals instead of an
empty page, and the non-zero exit lets cron alert you.

---

## Files

| File | Role |
|---|---|
| `api/_secrets.js` | The only module that touches credentials; `${VAR}` expansion, redaction, secret scanning |
| `api/_data.js` | Expands store/coupon URL placeholders per request |
| `api/page.js` | Server-rendered `/coupon/:id`, `/store/:id`, `/category/:id` |
| `scripts/sync-offers.js` | Daily provider sync + canonical mapping + fallback |
| `scripts/link-guard.js` | The four validation gates |
| `scripts/purge-secrets.js` | Audit / purge live secrets from tracked files |
| `vercel.json` | Rewrites mapping the public paths to `api/page.js` |
| `.env.example` | Every variable, documented |
