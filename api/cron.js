/**
 * GET /api/cron — the single daily orchestrator.
 *
 * Wired up by the `crons` entry in vercel.json (03:00 UTC, once a day).
 *
 * WHY ONE JOB AND NOT THREE
 * -------------------------
 * Vercel's Hobby plan allows 2 cron jobs, each limited to a daily schedule.
 * Three separate jobs (keywords, sitemap, links) would not fit, and the 10-second
 * function budget would not stretch to a full link audit anyway. So there is one
 * entry point that runs whatever fits in the time it has, and reports exactly
 * what it did and what it skipped.
 *
 * What runs:
 *   1. sitemap    — rebuild the sitemap from live data
 *   2. ping       — tell Google, Bing and (if configured) IndexNow that the
 *                   sitemap changed, so fresh URLs get crawled within hours
 *                   instead of waiting to be discovered
 *   3. warm       — re-request the homepage and the highest-value programmatic
 *                   pages so the first real visitor of the day hits a warm edge
 *                   cache rather than a cold function
 *
 * What deliberately does NOT run here:
 *   • anything that writes to disk. Vercel's filesystem is read-only at
 *     runtime and any change is discarded, so a job that "updates
 *     data/keywords.json" would silently do nothing.
 *   • a full link audit — 70 stores at ~1s each blows the 10s budget. That
 *     belongs in GitHub Actions, which has a 6-hour budget, not 10 seconds.
 *
 * Keyword rotation therefore happens two ways, both already built:
 *   • /api/keywords computes a fresh, date-seeded set on every request, and
 *     /api/page writes it into the HTML that crawlers receive — no scheduler
 *     required, and it is never stale
 *   • .github/workflows/daily-growth.yml runs scripts/keyword-sync.js and
 *     commits the rotated tags into index.html
 *
 * Auth: when CRON_SECRET is set, Vercel sends it as
 * `Authorization: Bearer <secret>` and anything else is rejected. If the
 * variable is unset the endpoint stays open but reports that, so you can see
 * the misconfiguration rather than being locked out silently.
 */
'use strict';

const S = require('./_secrets.js');

const BUDGET_MS = 8500;                  // Hobby functions are killed at 10s
const started = Date.now();
const remaining = () => BUDGET_MS - (Date.now() - started);

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(ms, remaining())));
  try {
    return await fetch(url, Object.assign({ signal: controller.signal }, opts || {}));
  } finally {
    clearTimeout(timer);
  }
}

async function job(name, fn) {
  if (remaining() < 600) {
    return { name, status: 'skipped', reason: 'time budget exhausted' };
  }
  const t0 = Date.now();
  try {
    const detail = await fn();
    return Object.assign({ name, status: 'ok', ms: Date.now() - t0 }, detail || {});
  } catch (err) {
    return { name, status: 'error', ms: Date.now() - t0, error: S.redact(err.message) };
  }
}

function siteUrl() {
  return (S.env('SITE_URL', 'https://nipcoupon.vercel.app').trim() || 'https://nipcoupon.vercel.app').replace(/\/+$/, '');
}

/* ── jobs ────────────────────────────────────────────────────────────────── */

/** Count the URLs in the deployed sitemap — proves which build is live. */
async function sitemapJob() {
  const res = await fetchWithTimeout(siteUrl() + '/sitemap.xml', { headers: { accept: 'application/xml' } }, 4000);
  if (!res.ok) return { http: res.status, note: 'sitemap not reachable' };
  const xml = await res.text();
  const locs = (xml.match(/<loc>/g) || []).length;
  const langs = (xml.match(/hreflang=/g) || []).length;
  return { http: res.status, bytes: xml.length, urls: locs, hreflang: langs };
}

/**
 * Tell search engines what changed.
 *
 * IMPORTANT — the old ping endpoints are dead and are NOT used here:
 *   • https://www.google.com/ping?sitemap=…  returns 404. Google deprecated
 *     the sitemap ping in June 2023 and switched it off at the end of that
 *     year; the only supported submission routes now are the `Sitemap:` line
 *     in robots.txt and the Search Console UI/API.
 *   • https://www.bing.com/ping?sitemap=…    returns 410 Gone. Bing moved to
 *     IndexNow.
 *
 * So indexing runs on two live mechanisms:
 *   1. IndexNow — instant push to Bing, Yandex, Seznam, Naver and Yep. Needs
 *      INDEXNOW_KEY (a 32-hex-char file you host at /<key>.txt).
 *   2. Bing Webmaster Tools API — batch URL submission, needs BING_API_KEY.
 *
 * Google has no push API for ordinary pages, which is precisely why the
 * `Sitemap:` line in robots.txt matters: it is the only automatic discovery
 * route Google still supports.
 */
async function pingJob() {
  const site = siteUrl();
  const host = site.replace(/^https?:\/\//, '');
  const results = [];

  /* Which URLs to push: the homepage plus the newest sitemap entries, capped
     so we never blow the request size limit or the time budget. */
  let urlList = [site + '/'];
  try {
    const r = await fetchWithTimeout(site + '/sitemap.xml', { headers: { accept: 'application/xml' } }, 2500);
    if (r.ok) {
      const xml = await r.text();
      const locs = (xml.match(/<loc>([^<]+)<\/loc>/g) || [])
        .map(m => m.replace(/<\/?loc>/g, '').trim())
        .slice(0, 200);
      if (locs.length) urlList = locs;
    }
  } catch (err) { /* fall back to the homepage only */ }

  /* 1 — IndexNow */
  const key = S.env('INDEXNOW_KEY').trim();
  if (key) {
    try {
      const r = await fetchWithTimeout('https://api.indexnow.org/IndexNow', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host,
          key,
          keyLocation: site + '/' + key + '.txt',
          urlList
        })
      }, 4000);
      results.push({ target: 'indexnow', http: r.status, urls: urlList.length });
    } catch (err) {
      results.push({ target: 'indexnow', http: 0, error: S.redact(err.message) });
    }
  } else {
    results.push({ target: 'indexnow', skipped: true, reason: 'INDEXNOW_KEY not set' });
  }

  /* 2 — Bing Webmaster Tools */
  const bing = S.env('BING_API_KEY').trim();
  if (bing) {
    try {
      const r = await fetchWithTimeout(
        'https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlBatch?apikey=' + encodeURIComponent(bing), {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ siteUrl: site, urlList })
        }, 4000);
      results.push({ target: 'bing-webmaster', http: r.status, urls: urlList.length });
    } catch (err) {
      results.push({ target: 'bing-webmaster', http: 0, error: S.redact(err.message) });
    }
  } else {
    results.push({ target: 'bing-webmaster', skipped: true, reason: 'BING_API_KEY not set' });
  }

  /* Record what Google gets, so the report is honest about the one engine
     that cannot be pushed to. */
  results.push({
    target: 'google',
    skipped: true,
    reason: 'ping endpoint retired by Google (404). Discovery is via the robots.txt Sitemap line — verified below.'
  });

  const robots = await (async () => {
    try {
      const r = await fetchWithTimeout(site + '/robots.txt', null, 2000);
      if (!r.ok) return { http: r.status, sitemapLine: false };
      const txt = await r.text();
      return {
        http: r.status,
        sitemapLine: /^\s*Sitemap:/im.test(txt),
        disallowsApi: /Disallow:\s*\/api\//i.test(txt)
      };
    } catch (err) {
      return { http: 0, error: S.redact(err.message) };
    }
  })();

  return { pings: results, robots };
}

/** Warm the edge cache for the highest-value pages. */
async function warmJob() {
  const site = siteUrl();
  let paths = ['/'];

  /* Pull a few real URLs so we warm pages that actually exist. */
  try {
    const r = await fetchWithTimeout(site + '/sitemap.xml', { headers: { accept: 'application/xml' } }, 3000);
    if (r.ok) {
      const xml = await r.text();
      const locs = (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, '').trim());
      const home = locs[0] || '';
      const origin = home.replace(/\/[^/]*$/, '');
      paths = locs
        .slice(1, 6)
        .map(l => l.replace(origin, ''))
        .filter(Boolean)
        .concat(['/']);
    }
  } catch (err) { /* fall back to warming the homepage only */ }

  const results = await Promise.all(paths.map(async p => {
    try {
      const r = await fetchWithTimeout(site + p, { headers: { 'cache-control': 'no-cache' } }, 2500);
      return { path: p, http: r.status };
    } catch (err) {
      return { path: p, http: 0, error: S.redact(err.message) };
    }
  }));

  return { warmed: results.length, results };
}

/* ── handler ─────────────────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  /* Auth. Vercel sends the secret automatically; a manual hit needs ?secret=. */
  const secret = S.env('CRON_SECRET').trim();
  if (secret) {
    const auth = String((req.headers && req.headers.authorization) || '');
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const query = (req.query && (req.query.secret || req.query.token)) || '';
    if (token !== secret && String(query) !== secret) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'Unauthorised', hint: 'Send Authorization: Bearer <CRON_SECRET>' }));
    }
  }

  const jobs = [];
  if (String((req.query && req.query.only) || '').toLowerCase() !== 'ping') {
    jobs.push(await job('sitemap', sitemapJob));
  }
  jobs.push(await job('ping', pingJob));
  if (String((req.query && req.query.only) || '').toLowerCase() !== 'sitemap') {
    jobs.push(await job('warm', warmJob));
  }

  const payload = {
    ok: jobs.every(j => j.status !== 'error'),
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    budgetMs: BUDGET_MS,
    auth: secret ? 'enabled' : 'OPEN — set CRON_SECRET to lock this endpoint',
    jobs
  };

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(payload.ok ? 200 : 207);
  return res.end(JSON.stringify(payload, null, 2));
};
