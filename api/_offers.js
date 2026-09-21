/**
 * _offers.js — the source-independent offer layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Offers used to arrive from exactly one place, so "where did this come from"
 * and "is it still good" were implicit. With several possible providers —
 * Sovrn, CJ, a merchant feed, manual entry — those questions have to be
 * answered by the data itself, or the catalogue quietly becomes unauditable.
 *
 * Three jobs, deliberately separated:
 *
 *   canonical()   one internal shape, whatever the provider sent
 *   gate()        PENDING | VERIFIED | EXPIRED | REJECTED | UNKNOWN
 *   reconcile()   several sources, one published list, provenance preserved
 *
 * Design rules that are not negotiable:
 *   • A record is never invented. Absent data stays absent; it does not get a
 *     plausible default. `verifiedAt: null` means nobody checked, and the gate
 *     treats that as UNKNOWN rather than quietly promoting it to VERIFIED.
 *   • Nothing is deleted. An expired or rejected offer is marked, kept for
 *     analytics, and filtered at render time. Losing a real code because a
 *     probe was flaky is worse than showing one fewer offer.
 *   • Only `gate()` may assign VERIFIED, and only from a real timestamp.
 *     offerScore() ranks; it never certifies.
 */
'use strict';

/* Lifecycle. UNKNOWN is a first-class state, not a failure: it means the data
   is structurally fine but unverified, which is the honest default for a feed
   row nobody has re-checked yet. */
const STATUS = {
  PENDING:  'PENDING',    // structurally valid, awaiting its first verification
  VERIFIED: 'VERIFIED',   // confirmed within the freshness window
  EXPIRED:  'EXPIRED',    // confirmed expiry date has passed
  REJECTED: 'REJECTED',   // failed a hard quality rule — never published
  UNKNOWN:  'UNKNOWN'     // valid shape, verification stale or absent
};

/* An offer is only presented as "verified" inside this window. Two days lines
   up with the nightly re-check: anything older has missed at least one run. */
const VERIFY_WINDOW_HOURS = 48;

const iso = d => new Date(d).toISOString();
const nowMs = () => Date.now();

function daysUntil(dateish) {
  if (!dateish) return null;
  const t = Date.parse(String(dateish).length <= 10 ? dateish + 'T23:59:59Z' : dateish);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - nowMs()) / 86400000);
}

function hoursSince(dateish) {
  if (!dateish) return null;
  const t = Date.parse(dateish);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs() - t) / 3600000);
}

/* ── canonical shape ──────────────────────────────────────────────────────────
 * Accepts a row from any adapter plus the source descriptor, and returns the
 * one internal schema. Legacy rows in data/coupons.json predate several of
 * these fields, so they are derived where that is honest (verifiedHoursAgo ->
 * verifiedAt) and left null where it is not (externalOfferId, sovrnEpc).
 */
function canonical(raw, source, store) {
  const src = source || {};
  const s = store || {};
  const r = raw || {};

  /* verifiedHoursAgo is the legacy field. It is a real observation, so it can
     be turned into a real timestamp — unlike, say, inventing a lastSeenAt. */
  let verifiedAt = r.verifiedAt || null;
  if (!verifiedAt && Number(r.verifiedHoursAgo) >= 0) {
    verifiedAt = iso(nowMs() - Number(r.verifiedHoursAgo) * 3600000);
  }

  const type = r.type === 'deal' ? 'deal' : (r.type === 'code' ? 'code' : (r.code ? 'code' : 'deal'));
  /* Keep what the source actually sent, so gate() can see a contradiction that
     canonicalisation would otherwise hide. Blanking `code` for a deal made
     "type=deal with a code" silently pass — the feed is telling us two
     different things and that is exactly what the gate must catch. */
  const rawCode = String(r.code || '').trim();

  return {
    id:                 r.id || null,
    storeId:            r.storeId || null,
    source:             src.id || r.source || 'local',
    sourcePriority:     Number.isFinite(src.priority) ? src.priority : 99,
    externalOfferId:    r.externalOfferId || r.externalId || null,
    code:               type === 'code' ? rawCode : '',
    _rawCode:           rawCode,          // internal: gate() only, never rendered
    title:              String(r.title || '').trim(),
    value:              Number(r.value) || 0,
    badge:              r.badge || '',
    type,
    categoryId:         r.categoryId || null,
    originalUrl:        r.originalUrl || s.originalUrl || '',
    trackingUrl:        r.trackingUrl || r.landingUrl || s.url || '',
    expires:            r.expires || null,
    terms:              Array.isArray(r.terms) ? r.terms.filter(Boolean) : [],
    regions:            Array.isArray(r.regions) && r.regions.length ? r.regions.map(String) : ['GLOBAL'],
    verifiedAt,
    verificationStatus: r.verificationStatus || null,   // gate() decides; never trust the feed's own claim
    lastSeenAt:         r.lastSeenAt || iso(nowMs()),   // honest: we are seeing it right now
    /* Carried through for ranking when a network reports it. Null, not 0 —
       zero would read as "earns nothing" rather than "nobody told us". */
    sovrnEpc:           r.sovrnEpc !== undefined ? r.sovrnEpc : (s.sovrnEpc !== undefined ? s.sovrnEpc : null),
    rating:             Number(r.rating) || 0,
    uses:               Number(r.uses) || 0,
    hot:                !!r.hot
  };
}

/* ── quality gate ─────────────────────────────────────────────────────────────
 * Returns { status, reasons[] }. Reasons are always returned, including for a
 * pass, so a decision can be explained without re-deriving it.
 */
function gate(offer, ctx) {
  const c = ctx || {};
  const storeIds = c.storeIds instanceof Set ? c.storeIds : new Set(c.storeIds || []);
  const reasons = [];

  // Hard rejections — malformed beyond use.
  if (!offer.storeId) reasons.push('no storeId');
  else if (storeIds.size && !storeIds.has(offer.storeId)) reasons.push('unknown store: ' + offer.storeId);
  if (!offer.title) reasons.push('no title');
  if (offer.type === 'code' && !offer.code) reasons.push('type=code with empty code');
  if (offer.type === 'deal' && (offer.code || offer._rawCode)) reasons.push('type=deal carrying a code');
  if (!offer.trackingUrl) reasons.push('no tracking URL');
  else if (!/^https:\/\//i.test(offer.trackingUrl)) reasons.push('tracking URL is not https');
  if (offer.expires && daysUntil(offer.expires) === null) reasons.push('unparseable expiry: ' + offer.expires);
  if (offer.value < 0 || offer.value > 100000) reasons.push('implausible value: ' + offer.value);
  if (offer.rating && (offer.rating < 0 || offer.rating > 5)) reasons.push('rating out of range');

  if (reasons.length) return { status: STATUS.REJECTED, reasons };

  // Expiry beats verification: a confirmed-dead code is never shown, however
  // recently it was checked.
  const d = daysUntil(offer.expires);
  if (d !== null && d < 0) return { status: STATUS.EXPIRED, reasons: ['expired ' + offer.expires] };

  const h = hoursSince(offer.verifiedAt);
  if (h === null) return { status: STATUS.PENDING, reasons: ['never verified'] };
  if (h <= VERIFY_WINDOW_HOURS) {
    return { status: STATUS.VERIFIED, reasons: ['verified ' + Math.round(h) + 'h ago'] };
  }
  return { status: STATUS.UNKNOWN, reasons: ['last verified ' + Math.round(h / 24) + 'd ago — outside the ' + VERIFY_WINDOW_HOURS + 'h window'] };
}

/* ── reconcile several sources ────────────────────────────────────────────────
 * Identity is storeId + code for a code offer, storeId + normalised title for a
 * deal (deals have no code to key on).
 *
 * When two sources describe the same offer, one wins on a deliberate order:
 * a VERIFIED record beats an unverified one, then fresher verification, then
 * lower sourcePriority. The loser is NOT discarded — it is recorded under
 * `alternates` so provenance survives and a bad merge can be unpicked.
 */
function identity(o) {
  const t = String(o.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return o.code
    ? 'c:' + o.storeId + '::' + o.code.toLowerCase()
    : 'd:' + o.storeId + '::' + t;
}

function better(a, b) {
  const av = a.verificationStatus === STATUS.VERIFIED ? 1 : 0;
  const bv = b.verificationStatus === STATUS.VERIFIED ? 1 : 0;
  if (av !== bv) return av > bv ? a : b;
  const ah = hoursSince(a.verifiedAt), bh = hoursSince(b.verifiedAt);
  if (ah !== null && bh !== null && ah !== bh) return ah < bh ? a : b;
  if (ah !== null && bh === null) return a;
  if (bh !== null && ah === null) return b;
  return (a.sourcePriority || 99) <= (b.sourcePriority || 99) ? a : b;
}

function reconcile(offers, ctx) {
  const byId = new Map();
  const stats = { in: offers.length, published: 0, merged: 0, byStatus: {}, bySource: {} };

  offers.forEach(o => {
    const g = gate(o, ctx);
    o.verificationStatus = g.status;
    o.gateReasons = g.reasons;
    stats.byStatus[g.status] = (stats.byStatus[g.status] || 0) + 1;
    stats.bySource[o.source] = (stats.bySource[o.source] || 0) + 1;

    const key = identity(o);
    const prev = byId.get(key);
    if (!prev) { byId.set(key, o); return; }

    stats.merged++;
    const win = better(prev, o);
    const lose = win === prev ? o : prev;
    win.alternates = (win.alternates || prev.alternates || []).concat([{
      source: lose.source, verifiedAt: lose.verifiedAt,
      verificationStatus: lose.verificationStatus, externalOfferId: lose.externalOfferId
    }]);
    byId.set(key, win);
  });

  const all = [...byId.values()];
  /* Public list: only states a shopper can act on. EXPIRED and REJECTED are
     retained in `all` for analytics and never silently dropped from history. */
  const publishable = all.filter(o =>
    o.verificationStatus === STATUS.VERIFIED ||
    o.verificationStatus === STATUS.UNKNOWN ||
    o.verificationStatus === STATUS.PENDING);
  stats.published = publishable.length;
  return { all, publishable, stats };
}

module.exports = {
  STATUS, VERIFY_WINDOW_HOURS,
  canonical, gate, reconcile, identity,
  daysUntil, hoursSince
};
