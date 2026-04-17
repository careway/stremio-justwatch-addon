"use strict";

// ─── Multilingual genre definitions ──────────────────────────────────────────
// Each entry: { code: JustWatch shortName, names: { [lang]: displayName } }
// Falls back to 'en' for any language not listed.
const GENRES = [
  {
    code: "act",
    names: {
      es: "Acción",
      en: "Action",
      de: "Action",
      fr: "Action",
      it: "Azione",
      pt: "Ação",
      nl: "Actie",
      sv: "Action",
      no: "Action",
      da: "Action",
      fi: "Toiminta",
      pl: "Akcja",
      ja: "アクション",
      ko: "액션",
      ar: "حركة",
    },
  },
  {
    code: "ani",
    names: {
      es: "Animación",
      en: "Animation",
      de: "Animation",
      fr: "Animation",
      it: "Animazione",
      pt: "Animação",
      nl: "Animatie",
      sv: "Animation",
      no: "Animasjon",
      da: "Animation",
      fi: "Animaatio",
      pl: "Animacja",
      ja: "アニメーション",
      ko: "애니메이션",
      ar: "رسوم متحركة",
    },
  },
  {
    code: "cmy",
    names: {
      es: "Comedia",
      en: "Comedy",
      de: "Komödie",
      fr: "Comédie",
      it: "Commedia",
      pt: "Comédia",
      nl: "Komedie",
      sv: "Komedi",
      no: "Komedie",
      da: "Komedie",
      fi: "Komedia",
      pl: "Komedia",
      ja: "コメディ",
      ko: "코미디",
      ar: "كوميديا",
    },
  },
  {
    code: "crm",
    names: {
      es: "Crimen",
      en: "Crime",
      de: "Krimi",
      fr: "Crime",
      it: "Crimine",
      pt: "Crime",
      nl: "Misdaad",
      sv: "Brott",
      no: "Krim",
      da: "Krimi",
      fi: "Rikos",
      pl: "Kryminał",
      ja: "犯罪",
      ko: "범죄",
      ar: "جريمة",
    },
  },
  {
    code: "doc",
    names: {
      es: "Documental",
      en: "Documentary",
      de: "Dokumentarfilm",
      fr: "Documentaire",
      it: "Documentario",
      pt: "Documentário",
      nl: "Documentaire",
      sv: "Dokumentär",
      no: "Dokumentar",
      da: "Dokumentar",
      fi: "Dokumentti",
      pl: "Dokument",
      ja: "ドキュメンタリー",
      ko: "다큐멘터리",
      ar: "وثائقي",
    },
  },
  {
    code: "drm",
    names: {
      es: "Drama",
      en: "Drama",
      de: "Drama",
      fr: "Drame",
      it: "Dramma",
      pt: "Drama",
      nl: "Drama",
      sv: "Drama",
      no: "Drama",
      da: "Drama",
      fi: "Draama",
      pl: "Dramat",
      ja: "ドラマ",
      ko: "드라마",
      ar: "دراما",
    },
  },
  {
    code: "fml",
    names: {
      es: "Familia",
      en: "Family",
      de: "Familie",
      fr: "Famille",
      it: "Famiglia",
      pt: "Família",
      nl: "Familie",
      sv: "Familj",
      no: "Familie",
      da: "Familie",
      fi: "Perhe",
      pl: "Rodzina",
      ja: "ファミリー",
      ko: "가족",
      ar: "عائلي",
    },
  },
  {
    code: "fnt",
    names: {
      es: "Fantasía",
      en: "Fantasy",
      de: "Fantasy",
      fr: "Fantastique",
      it: "Fantasy",
      pt: "Fantasia",
      nl: "Fantasy",
      sv: "Fantasy",
      no: "Fantasy",
      da: "Fantasy",
      fi: "Fantasia",
      pl: "Fantasy",
      ja: "ファンタジー",
      ko: "판타지",
      ar: "خيال",
    },
  },
  {
    code: "hrr",
    names: {
      es: "Terror",
      en: "Horror",
      de: "Horror",
      fr: "Horreur",
      it: "Horror",
      pt: "Terror",
      nl: "Horror",
      sv: "Skräck",
      no: "Gru",
      da: "Gyser",
      fi: "Kauhu",
      pl: "Horror",
      ja: "ホラー",
      ko: "공포",
      ar: "رعب",
    },
  },
  {
    code: "hst",
    names: {
      es: "Historia",
      en: "History",
      de: "Geschichte",
      fr: "Histoire",
      it: "Storia",
      pt: "História",
      nl: "Geschiedenis",
      sv: "Historia",
      no: "Historie",
      da: "Historie",
      fi: "Historia",
      pl: "Historia",
      ja: "歴史",
      ko: "역사",
      ar: "تاريخ",
    },
  },
  {
    code: "msc",
    names: {
      es: "Música",
      en: "Music",
      de: "Musik",
      fr: "Musique",
      it: "Musica",
      pt: "Música",
      nl: "Muziek",
      sv: "Musik",
      no: "Musikk",
      da: "Musik",
      fi: "Musiikki",
      pl: "Muzyka",
      ja: "音楽",
      ko: "음악",
      ar: "موسيقى",
    },
  },
  {
    code: "rma",
    names: {
      es: "Romance",
      en: "Romance",
      de: "Romantik",
      fr: "Romance",
      it: "Romantico",
      pt: "Romance",
      nl: "Romantiek",
      sv: "Romantik",
      no: "Romantikk",
      da: "Romantik",
      fi: "Romantiikka",
      pl: "Romans",
      ja: "ロマンス",
      ko: "로맨스",
      ar: "رومانسي",
    },
  },
  {
    code: "scf",
    names: {
      es: "Ciencia ficción",
      en: "Science Fiction",
      de: "Science-Fiction",
      fr: "Sci-fi",
      it: "Fantascienza",
      pt: "Ficção Científica",
      nl: "Sci-fi",
      sv: "Sci-fi",
      no: "Sci-fi",
      da: "Sci-fi",
      fi: "Tieteisviihde",
      pl: "Sci-fi",
      ja: "SF",
      ko: "SF",
      ar: "خيال علمي",
    },
  },
  {
    code: "spt",
    names: {
      es: "Deporte",
      en: "Sport",
      de: "Sport",
      fr: "Sport",
      it: "Sport",
      pt: "Esporte",
      nl: "Sport",
      sv: "Sport",
      no: "Sport",
      da: "Sport",
      fi: "Urheilu",
      pl: "Sport",
      ja: "スポーツ",
      ko: "스포츠",
      ar: "رياضة",
    },
  },
  {
    code: "trl",
    names: {
      es: "Thriller",
      en: "Thriller",
      de: "Thriller",
      fr: "Thriller",
      it: "Thriller",
      pt: "Thriller",
      nl: "Thriller",
      sv: "Thriller",
      no: "Thriller",
      da: "Thriller",
      fi: "Trilleri",
      pl: "Thriller",
      ja: "スリラー",
      ko: "스릴러",
      ar: "إثارة",
    },
  },
  {
    code: "wsn",
    names: {
      es: "Western",
      en: "Western",
      de: "Western",
      fr: "Western",
      it: "Western",
      pt: "Faroeste",
      nl: "Western",
      sv: "Western",
      no: "Western",
      da: "Western",
      fi: "Western",
      pl: "Western",
      ja: "西部劇",
      ko: "서부극",
      ar: "غربي",
    },
  },
  {
    code: "war",
    names: {
      es: "Guerra",
      en: "War",
      de: "Krieg",
      fr: "Guerre",
      it: "Guerra",
      pt: "Guerra",
      nl: "Oorlog",
      sv: "Krig",
      no: "Krig",
      da: "Krig",
      fi: "Sota",
      pl: "Wojenny",
      ja: "戦争",
      ko: "전쟁",
      ar: "حرب",
    },
  },
];

/**
 * Returns the list of genre display names for the given language.
 * Falls back to English for any unknown language.
 * @param {string} lang - BCP47 primary language tag (e.g. 'es', 'en', 'de')
 * @returns {string[]}
 */
function getGenreNames(lang) {
  const l = (lang || "en").toLowerCase().split("-")[0];
  return GENRES.map((g) => g.names[l] || g.names.en);
}

/**
 * Resolves a localised genre display name back to its JustWatch code.
 * @param {string} name - Display name as sent by Stremio (from extra.genre)
 * @param {string} lang - Language of the request
 * @returns {string|null} JustWatch genre shortName or null
 */
function getGenreCode(name, lang) {
  if (!name) return null;
  const l = (lang || "en").toLowerCase().split("-")[0];
  const genre = GENRES.find((g) => (g.names[l] || g.names.en) === name);
  return genre ? genre.code : null;
}

// ─── Sort map: catalog sort key → JustWatch sorting enum ─────────────────────
const SORT_MAP = {
  pop: "POPULAR",
  tnd: "TRENDING",
  new: "RELEASE_YEAR",
};

// ─── Language mapping ──────────────────────────────────────────────────────────
const LANGUAGE_NAMES = {
  es: "Español",
  en: "English",
  de: "Deutsch",
  fr: "Français",
  it: "Italiano",
  pt: "Português",
  nl: "Nederlands",
  sv: "Svenska",
  no: "Norsk",
  da: "Dansk",
  fi: "Suomi",
  pl: "Polski",
  ja: "日本語",
  ko: "한국어",
  ar: "العربية",
};

/**
 * Get all supported languages extracted from GENRES translations.
 * Returns a sorted list with language code and display name.
 */
function getSupportedLanguages() {
  // Extract unique language codes from GENRES
  const langCodes = new Set();
  GENRES.forEach((genre) => {
    Object.keys(genre.names).forEach((code) => langCodes.add(code));
  });

  // Convert to array with display names
  return Array.from(langCodes)
    .map((code) => ({
      code,
      name: LANGUAGE_NAMES[code] || code,
    }))
    .sort((a, b) => {
      // Sort: Spanish first, then English, then alphabetically
      if (a.code === "es") return -1;
      if (b.code === "es") return 1;
      if (a.code === "en") return -1;
      if (b.code === "en") return 1;
      return a.name.localeCompare(b.name);
    });
}

// ─── Countries ────────────────────────────────────────────────────────────────
// Fallback countries (used if dynamic fetch fails)
const FALLBACK_COUNTRIES = [
  { code: "AD", name: "Andorra" },
  { code: "AE", name: "Emiratos Árabes Unidos" },
  { code: "AL", name: "Albania" },
  { code: "AO", name: "Angola" },
  { code: "AR", name: "Argentina" },
  { code: "AT", name: "Austria" },
  { code: "AU", name: "Australia" },
  { code: "AZ", name: "Azerbaiyán" },
  { code: "BA", name: "Bosnia-Herzegovina" },
  { code: "BE", name: "Bélgica" },
  { code: "BF", name: "Burkina Faso" },
  { code: "BG", name: "Bulgaria" },
  { code: "BH", name: "Bahréin" },
  { code: "BM", name: "Islas Bermudas" },
  { code: "BO", name: "Bolivia" },
  { code: "BR", name: "Brasil" },
  { code: "BY", name: "Bielorrusia" },
  { code: "BZ", name: "Belice" },
  { code: "CA", name: "Canadá" },
  { code: "CH", name: "Suiza" },
  { code: "CL", name: "Chile" },
  { code: "CM", name: "Camerún" },
  { code: "CO", name: "Colombia" },
  { code: "CR", name: "Costa Rica" },
  { code: "CV", name: "Cabo Verde" },
  { code: "CY", name: "Chipre" },
  { code: "CZ", name: "República Checa" },
  { code: "DE", name: "Alemania" },
  { code: "DK", name: "Dinamarca" },
  { code: "DZ", name: "Argelia" },
  { code: "EC", name: "Ecuador" },
  { code: "EE", name: "Estonia" },
  { code: "EG", name: "Egipto" },
  { code: "ES", name: "España" },
  { code: "FI", name: "Finlandia" },
  { code: "FJ", name: "Fiyi" },
  { code: "FR", name: "Francia" },
  { code: "GF", name: "Guayana Francesa" },
  { code: "GG", name: "Guernsey" },
  { code: "GH", name: "Ghana" },
  { code: "GI", name: "Gibraltar" },
  { code: "GR", name: "Grecia" },
  { code: "GT", name: "Guatemala" },
  { code: "GY", name: "Guyana" },
  { code: "HK", name: "Hong Kong" },
  { code: "HN", name: "Honduras" },
  { code: "HR", name: "Croacia" },
  { code: "HU", name: "Hungría" },
  { code: "ID", name: "Indonesia" },
  { code: "IE", name: "Irlanda" },
  { code: "IL", name: "Israel" },
  { code: "IN", name: "India" },
  { code: "IQ", name: "Irak" },
  { code: "IS", name: "Islandia" },
  { code: "IT", name: "Italia" },
  { code: "JO", name: "Jordania" },
  { code: "JP", name: "Japón" },
  { code: "KE", name: "Kenia" },
  { code: "KR", name: "Corea del Sur" },
  { code: "KW", name: "Kuwait" },
  { code: "LB", name: "Líbano" },
  { code: "LI", name: "Liechtenstein" },
  { code: "LT", name: "Lituania" },
  { code: "LU", name: "Luxemburgo" },
  { code: "LV", name: "Letonia" },
  { code: "LY", name: "Libia" },
  { code: "MA", name: "Marruecos" },
  { code: "MC", name: "Mónaco" },
  { code: "MD", name: "Moldavia" },
  { code: "ME", name: "Montenegro" },
  { code: "MG", name: "Madagascar" },
  { code: "MK", name: "Macedonia" },
  { code: "ML", name: "Mali" },
  { code: "MT", name: "Malta" },
  { code: "MU", name: "Mauricio" },
  { code: "MW", name: "Malaui" },
  { code: "MX", name: "México" },
  { code: "MY", name: "Malasia" },
  { code: "MZ", name: "Mozambique" },
  { code: "NE", name: "Níger" },
  { code: "NG", name: "Nigeria" },
  { code: "NI", name: "Nicaragua" },
  { code: "NL", name: "Países Bajos" },
  { code: "NO", name: "Noruega" },
  { code: "NZ", name: "Nueva Zelanda" },
  { code: "OM", name: "Omán" },
  { code: "PA", name: "Panamá" },
  { code: "PE", name: "Perú" },
  { code: "PF", name: "Polinesia Francesa" },
  { code: "PG", name: "Papúa Nueva Guinea" },
  { code: "PH", name: "Filipinas" },
  { code: "PK", name: "Pakistán" },
  { code: "PL", name: "Polonia" },
  { code: "PS", name: "Palestina" },
  { code: "PT", name: "Portugal" },
  { code: "PY", name: "Paraguay" },
  { code: "QA", name: "Catar" },
  { code: "RO", name: "Rumania" },
  { code: "RS", name: "Serbia" },
  { code: "RU", name: "Rusia" },
  { code: "SA", name: "Arabia Saudita" },
  { code: "SC", name: "Seychelles" },
  { code: "SE", name: "Suecia" },
  { code: "SG", name: "Singapur" },
  { code: "SI", name: "Eslovenia" },
  { code: "SK", name: "Eslovaquia" },
  { code: "SM", name: "San Marino" },
  { code: "SN", name: "Senegal" },
  { code: "SV", name: "El Salvador" },
  { code: "TD", name: "Chad" },
  { code: "TH", name: "Tailandia" },
  { code: "TN", name: "Túnez" },
  { code: "TR", name: "Turquía" },
  { code: "TW", name: "Taiwán" },
  { code: "TZ", name: "Tanzania" },
  { code: "UA", name: "Ucrania" },
  { code: "UG", name: "Uganda" },
  { code: "GB", name: "Reino Unido" },
  { code: "US", name: "Estados Unidos" },
  { code: "UY", name: "Uruguay" },
  { code: "VA", name: "Ciudad del Vaticano" },
  { code: "VE", name: "Venezuela" },
  { code: "XK", name: "Kosovo" },
  { code: "YE", name: "Yemen" },
  { code: "ZA", name: "Sudáfrica" },
  { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "zimbabue" },
];

// Map from country code to localized name (Spanish)
const COUNTRY_NAMES = {
  AD: "Andorra",
  AE: "Emiratos Árabes Unidos",
  AL: "Albania",
  AO: "Angola",
  AR: "Argentina",
  AT: "Austria",
  AU: "Australia",
  AZ: "Azerbaiyán",
  BA: "Bosnia-Herzegovina",
  BE: "Bélgica",
  BF: "Burkina Faso",
  BG: "Bulgaria",
  BH: "Bahréin",
  BM: "Islas Bermudas",
  BO: "Bolivia",
  BR: "Brasil",
  BY: "Bielorrusia",
  BZ: "Belice",
  CA: "Canadá",
  CH: "Suiza",
  CL: "Chile",
  CM: "Camerún",
  CO: "Colombia",
  CR: "Costa Rica",
  CV: "Cabo Verde",
  CY: "Chipre",
  CZ: "República Checa",
  DE: "Alemania",
  DK: "Dinamarca",
  DZ: "Argelia",
  EC: "Ecuador",
  EE: "Estonia",
  EG: "Egipto",
  ES: "España",
  FI: "Finlandia",
  FJ: "Fiyi",
  FR: "Francia",
  GF: "Guayana Francesa",
  GG: "Guernsey",
  GH: "Ghana",
  GI: "Gibraltar",
  GR: "Grecia",
  GT: "Guatemala",
  GY: "Guyana",
  HK: "Hong Kong",
  HN: "Honduras",
  HR: "Croacia",
  HU: "Hungría",
  ID: "Indonesia",
  IE: "Irlanda",
  IL: "Israel",
  IN: "India",
  IQ: "Irak",
  IS: "Islandia",
  IT: "Italia",
  JO: "Jordania",
  JP: "Japón",
  KE: "Kenia",
  KR: "Corea del Sur",
  KW: "Kuwait",
  LB: "Líbano",
  LI: "Liechtenstein",
  LT: "Lituania",
  LU: "Luxemburgo",
  LV: "Letonia",
  LY: "Libia",
  MA: "Marruecos",
  MC: "Mónaco",
  MD: "Moldavia",
  ME: "Montenegro",
  MG: "Madagascar",
  MK: "Macedonia",
  ML: "Mali",
  MT: "Malta",
  MU: "Mauricio",
  MW: "Malaui",
  MX: "México",
  MY: "Malasia",
  MZ: "Mozambique",
  NE: "Níger",
  NG: "Nigeria",
  NI: "Nicaragua",
  NL: "Países Bajos",
  NO: "Noruega",
  NZ: "Nueva Zelanda",
  OM: "Omán",
  PA: "Panamá",
  PE: "Perú",
  PF: "Polinesia Francesa",
  PG: "Papúa Nueva Guinea",
  PH: "Filipinas",
  PK: "Pakistán",
  PL: "Polonia",
  PS: "Palestina",
  PT: "Portugal",
  PY: "Paraguay",
  QA: "Catar",
  RO: "Rumania",
  RS: "Serbia",
  RU: "Rusia",
  SA: "Arabia Saudita",
  SC: "Seychelles",
  SE: "Suecia",
  SG: "Singapur",
  SI: "Eslovenia",
  SK: "Eslovaquia",
  SM: "San Marino",
  SN: "Senegal",
  SV: "El Salvador",
  TD: "Chad",
  TH: "Tailandia",
  TN: "Túnez",
  TR: "Turquía",
  TW: "Taiwán",
  TZ: "Tanzania",
  UA: "Ucrania",
  UG: "Uganda",
  GB: "Reino Unido",
  US: "Estados Unidos",
  UY: "Uruguay",
  VA: "Ciudad del Vaticano",
  VE: "Venezuela",
  XK: "Kosovo",
  YE: "Yemen",
  ZA: "Sudáfrica",
  ZM: "Zambia",
  ZW: "zimbabue",
};

let cachedCountries = null;

/**
 * Get supported countries list.
 * Returns countries sorted by Spanish name.
 * Note: JustWatch API has introspection disabled, so we use a hardcoded list.
 */
async function fetchCountriesFromJustWatch() {
  if (cachedCountries) return cachedCountries;

  cachedCountries = FALLBACK_COUNTRIES.sort((a, b) =>
    a.name.localeCompare(b.name, "es"),
  );
  return cachedCountries;
}

const COUNTRIES = FALLBACK_COUNTRIES;

// ─── Config encode / decode ───────────────────────────────────────────────────

/**
 * Encode a config object to a base64url string.
/**
 * Encode config as a human-readable URL segment.
 * Format: {COUNTRY}_{language}_{pkg1}_{pkg2}…
 * e.g. ES_es_nfx_dnp_prv
 */
function encodeConfig(config) {
  const parts = [config.country, config.language || "en"];
  if (config.rpdbKey) parts.push(`rpdb-${config.rpdbKey}`);
  parts.push(...config.packages);
  return parts.join("_");
}

/**
 * Decode a plain config string back to a config object.
 * Format: {COUNTRY}_{language}_{pkg1}_{pkg2}…
 * Returns null if the string is missing required fields.
 */
function decodeConfig(encoded) {
  try {
    const parts = encoded.split("_");
    if (parts.length < 2) return null;

    const country =
      parts[0]
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 4) || null;
    const language =
      parts[1]
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .slice(0, 5) || "en";
    const packages = parts
      .slice(2)
      .filter((p) => /^[a-z0-9-]{1,30}$/.test(p) && !p.startsWith("rpdb-"))
      .slice(0, 200);

    const rpdbSegment = parts.slice(2).find((p) => p.startsWith("rpdb-"));
    const rpdbKey = rpdbSegment ? rpdbSegment.slice(5) : null;

    if (!country) return null;

    return { country, language, packages, rpdbKey };
  } catch {
    return null;
  }
}

module.exports = {
  GENRES,
  getGenreNames,
  getGenreCode,
  SORT_MAP,
  COUNTRIES,
  fetchCountriesFromJustWatch,
  getSupportedLanguages,
  encodeConfig,
  decodeConfig,
};
