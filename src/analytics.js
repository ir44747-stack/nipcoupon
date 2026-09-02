/**
 * analytics.js — Vercel Web Analytics entry point.
 *
 * WHY A BUNDLED MODULE AND NOT A RAW <script> TAG
 * -----------------------------------------------
 * Vercel's HTML guide says you can paste a script tag and skip the package
 * entirely. That works, but it hard-codes the ingest path into every HTML
 * surface, and this project has two of them: the static index.html shell and
 * the server-rendered pages in api/page.js. Importing the official package
 * and letting it inject means one dependency, one code path, and the ingest
 * URL comes from the package rather than from something we transcribed by
 * hand and have to keep in sync.
 *
 * `inject()` is the package's own vanilla-JS entry — the same primitive the
 * React/Next/Svelte <Analytics /> components wrap. It appends
 * /_vercel/insights/script.js, a FIRST-PARTY path on your own domain, so the
 * request is same-origin: no extra DNS lookup, no third-party CDN hostname,
 * and it survives tracker blockers that filter on known analytics domains.
 *
 * mode: 'production'
 *   Automatic detection reads process.env.NODE_ENV, which does not exist in a
 *   browser with no bundler define. Left on 'auto' the package would resolve
 *   to development, log debug output to the console and send events to a dev
 *   endpoint that never reaches the dashboard. Pinning it is what makes the
 *   data actually arrive. Preview deploys are still separated by Vercel on
 *   the server side, so this does not pollute production numbers.
 *
 * beforeSend
 *   Strips the query string before the URL is reported. NipCoupon's storefront
 *   filters client-side and its outbound links carry utm_* and affiliate
 *   parameters; without this, one logical page would fragment into dozens of
 *   rows in the dashboard. Hashes are dropped for the same reason.
 *
 * Analytics must never be able to break the page: every call is wrapped, and
 * a failure here is silent by design. A coupon site that throws on load
 * because a metrics script hiccuped has traded revenue for telemetry.
 */
import { inject, track } from '@vercel/analytics';

try {
  inject({
    mode: 'production',
    beforeSend: (event) => {
      try {
        const u = new URL(event.url);
        // Keep path only. Query/hash are noise here and can carry affiliate IDs.
        return { ...event, url: u.origin + u.pathname };
      } catch (e) {
        return event;
      }
    }
  });
} catch (e) {
  /* never let telemetry break the storefront */
}

/* Expose the custom-event helper so the existing outbound-click handler in
   index.html can report affiliate clicks to Vercel alongside GA4, without
   importing anything. Guarded so a blocked or failed inject cannot throw. */
try {
  window.vaTrack = function (name, props) {
    try { track(name, props); } catch (e) { /* no-op */ }
  };
} catch (e) {
  /* no-op */
}
