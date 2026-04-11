'use strict';

const { GENRE_NAMES, SORT_MAP } = require('./config');

// Human-readable sort labels shown in Stremio's catalog header
const SORT_LABELS = {
  pop: 'Popular',
  new: 'Nuevo',
};

/**
 * Build a Stremio manifest dynamically for a given user config.
 *
 * Catalog ID format: jw_{sortKey}_{shortName}
 *   sortKey   = 'pop' | 'new'
 *   shortName = JustWatch package shortName (e.g. nfx, dnp, prv)
 *
 * 4 catalogs are generated per selected provider (2 sorts × 2 types).
 *
 * @param {object}  config          - { country, language, packages: string[] }
 * @param {string}  encodedConfig   - base64url-encoded config (for URLs)
 * @param {object}  pkgInfoMap      - technicalName → { clearName, iconUrl, ... }
 * @param {string}  addonBaseUrl    - Full origin e.g. https://my-addon.onrender.com
 */
function buildManifest(config, encodedConfig, pkgInfoMap, addonBaseUrl) {
  const { country, language, packages } = config;

  const catalogs = [];

  for (const shortName of packages) {
    const info = pkgInfoMap[shortName] || { clearName: shortName };

    for (const [sortKey, sortLabel] of Object.entries(SORT_LABELS)) {
      for (const type of ['movie', 'series']) {
        catalogs.push({
          type,
          id: `jw_${sortKey}_${shortName}`,
          name: `${info.clearName} · ${sortLabel}`,
          extra: [
            { name: 'genre', options: GENRE_NAMES },
            { name: 'search' },
            { name: 'skip' },
          ],
        });
      }
    }
  }

  return {
    id: 'community.justwatch.stremio.addon',
    version: '1.0.0',
    name: 'JustWatch',
    description: `Descubre dónde ver el contenido vía JustWatch. País: ${country}.`,
    logo: 'https://www.justwatch.com/appassets/img/logo/JustWatch-logo-large.webp',
    background: 'https://images.justwatch.com/backdrop/305764650/s1920/the-substance.jpg',
    resources: [
      'catalog',
      { resource: 'stream', type: 'movie',  idPrefixes: ['tt'] },
      { resource: 'stream', type: 'series', idPrefixes: ['tt'] },
    ],
    types: ['movie', 'series'],
    catalogs,
    behaviorHints: {
      configurable: true,
      adult: false,
    },
    // Points back to this exact configuration so the Stremio gear button pre-fills the form
    configurationURL: `${addonBaseUrl}/configure?config=${encodedConfig}`,
  };
}

module.exports = { buildManifest };
