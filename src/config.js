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

// ─── Countries ────────────────────────────────────────────────────────────────
const COUNTRIES = [
  { code: "ES", name: "España" },
  { code: "US", name: "Estados Unidos" },
  { code: "GB", name: "Reino Unido" },
  { code: "DE", name: "Alemania" },
  { code: "FR", name: "Francia" },
  { code: "IT", name: "Italia" },
  { code: "PT", name: "Portugal" },
  { code: "MX", name: "México" },
  { code: "AR", name: "Argentina" },
  { code: "BR", name: "Brasil" },
  { code: "CL", name: "Chile" },
  { code: "CO", name: "Colombia" },
  { code: "NL", name: "Países Bajos" },
  { code: "BE", name: "Bélgica" },
  { code: "CH", name: "Suiza" },
  { code: "AT", name: "Austria" },
  { code: "SE", name: "Suecia" },
  { code: "NO", name: "Noruega" },
  { code: "DK", name: "Dinamarca" },
  { code: "FI", name: "Finlandia" },
  { code: "PL", name: "Polonia" },
  { code: "CA", name: "Canadá" },
  { code: "AU", name: "Australia" },
  { code: "JP", name: "Japón" },
  { code: "KR", name: "Corea del Sur" },
];

// ─── Config encode / decode ───────────────────────────────────────────────────

/**
 * Encode a config object to a base64url string.
/**
 * Encode config as a human-readable URL segment.
 * Format: {COUNTRY}_{language}_{pkg1}_{pkg2}…
 * e.g. ES_es_nfx_dnp_prv
 */
function encodeConfig(config) {
  const parts = [config.country, config.language || "en", ...config.packages];
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
      .filter((p) => /^[a-z0-9-]{1,30}$/.test(p))
      .slice(0, 30);

    if (!country) return null;

    return { country, language, packages };
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
  encodeConfig,
  decodeConfig,
};
