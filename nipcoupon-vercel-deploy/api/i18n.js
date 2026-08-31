/**
 * GET /api/i18n
 *
 * Serves the UI translation bundles in `locales/*.json`.
 *
 *   GET /api/i18n            → { locales: ["ar","en"], default: "en", translations: { ar:{…}, en:{…} } }
 *   GET /api/i18n?lang=ar    → { lang:"ar", dir:"rtl", translations: {…} }
 *
 * The storefront asks for a single language so phones only download what they
 * need. Supported languages are derived from the files present in `locales/`,
 * so dropping in `fr.json` is enough to add French.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { json, methodNotAllowed } = require('./_http');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const DEFAULT_LANG = 'en';
const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);

function available() {
  try {
    return fs.readdirSync(LOCALES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort();
  } catch (err) {
    return [];
  }
}

function readBundle(lang) {
  try {
    const raw = fs.readFileSync(path.join(LOCALES_DIR, lang + '.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch (err) {
    return null;
  }
}

module.exports = function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); return res.status(204).end(); }
  if (req.method !== 'GET') return methodNotAllowed(res);

  const query = (req && req.query) || {};
  const langs = available();

  if (!langs.length) {
    return json(res, 200, { locales: [], default: DEFAULT_LANG, translations: {} }, 'public, max-age=60');
  }

  const asked = String(query.lang || '').toLowerCase();
  if (asked) {
    if (langs.indexOf(asked) === -1) {
      return json(res, 404, { error: 'Unknown language "' + asked + '"', locales: langs }, 'no-store');
    }
    return json(res, 200, {
      lang: asked,
      dir: RTL_LANGS.has(asked) ? 'rtl' : 'ltr',
      translations: readBundle(asked) || {}
    }, 'public, max-age=3600, stale-while-revalidate=86400');
  }

  // no lang → every bundle (handy for a static build or a translation tool)
  const all = {};
  langs.forEach(l => { all[l] = readBundle(l) || {}; });
  return json(res, 200, {
    locales: langs,
    default: langs.indexOf(DEFAULT_LANG) !== -1 ? DEFAULT_LANG : langs[0],
    rtl: langs.filter(l => RTL_LANGS.has(l)),
    translations: all
  }, 'public, max-age=3600, stale-while-revalidate=86400');
};
