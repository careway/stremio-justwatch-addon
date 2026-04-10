'use strict';

// ─── Genre mapping: display name (ES) → JustWatch shortName ──────────────────
const GENRE_MAP = {
  'Acción':          'act',
  'Animación':       'ani',
  'Comedia':         'cmy',
  'Crimen':          'crm',
  'Documental':      'doc',
  'Drama':           'drm',
  'Familia':         'fam',
  'Fantasía':        'fan',
  'Terror':          'hrr',
  'Historia':        'his',
  'Música':          'msc',
  'Misterio':        'mys',
  'Romance':         'rma',
  'Ciencia ficción': 'scf',
  'Deporte':         'spt',
  'Thriller':        'trl',
  'Western':         'wst',
  'Guerra':          'war',
};

// Reverse: shortName → display name
const GENRE_SHORT_TO_NAME = Object.fromEntries(
  Object.entries(GENRE_MAP).map(([name, code]) => [code, name])
);

const GENRE_NAMES = Object.keys(GENRE_MAP);

// ─── Sort map: catalog sort key → JustWatch sorting enum ─────────────────────
const SORT_MAP = {
  pop: 'POPULAR',
  new: 'RELEASE_YEAR',
};

// ─── Countries ────────────────────────────────────────────────────────────────
const COUNTRIES = [
  { code: 'ES', name: 'España' },
  { code: 'US', name: 'Estados Unidos' },
  { code: 'GB', name: 'Reino Unido' },
  { code: 'DE', name: 'Alemania' },
  { code: 'FR', name: 'Francia' },
  { code: 'IT', name: 'Italia' },
  { code: 'PT', name: 'Portugal' },
  { code: 'MX', name: 'México' },
  { code: 'AR', name: 'Argentina' },
  { code: 'BR', name: 'Brasil' },
  { code: 'CL', name: 'Chile' },
  { code: 'CO', name: 'Colombia' },
  { code: 'NL', name: 'Países Bajos' },
  { code: 'BE', name: 'Bélgica' },
  { code: 'CH', name: 'Suiza' },
  { code: 'AT', name: 'Austria' },
  { code: 'SE', name: 'Suecia' },
  { code: 'NO', name: 'Noruega' },
  { code: 'DK', name: 'Dinamarca' },
  { code: 'FI', name: 'Finlandia' },
  { code: 'PL', name: 'Polonia' },
  { code: 'CA', name: 'Canadá' },
  { code: 'AU', name: 'Australia' },
  { code: 'JP', name: 'Japón' },
  { code: 'KR', name: 'Corea del Sur' },
];

// ─── Languages ────────────────────────────────────────────────────────────────
const LANGUAGES = [
  { code: 'es', name: 'Español' },
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'sv', name: 'Svenska' },
  { code: 'no', name: 'Norsk' },
  { code: 'da', name: 'Dansk' },
  { code: 'fi', name: 'Suomi' },
  { code: 'pl', name: 'Polski' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
];

// ─── Config encode / decode ───────────────────────────────────────────────────

/**
 * Encode a config object to a base64url string.
 * Config: { country: string, language: string, packages: string[] }
 */
function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64url');
}

/**
 * Decode a base64url string back to a config object.
 * Returns null if the string is invalid or has wrong structure.
 */
function decodeConfig(encoded) {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    const config = JSON.parse(json);
    if (
      typeof config.country !== 'string' ||
      typeof config.language !== 'string' ||
      !Array.isArray(config.packages)
    ) {
      return null;
    }
    // Sanitize: only accept well-formed values
    config.country = config.country.toUpperCase().slice(0, 4).replace(/[^A-Z]/g, '') || 'US';
    config.language = config.language.toLowerCase().slice(0, 5).replace(/[^a-z-]/g, '') || 'en';
    config.packages = config.packages
      .filter((p) => typeof p === 'string' && /^[a-z0-9_-]{1,30}$/.test(p))
      .slice(0, 30);
    return config;
  } catch {
    return null;
  }
}

module.exports = {
  GENRE_MAP,
  GENRE_SHORT_TO_NAME,
  GENRE_NAMES,
  SORT_MAP,
  COUNTRIES,
  LANGUAGES,
  encodeConfig,
  decodeConfig,
};
