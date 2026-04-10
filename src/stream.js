'use strict';

const axios = require('axios');
const { searchTitles, getTitleOffers } = require('./justwatch');

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';

const MONETIZATION_LABEL = {
  FLATRATE: 'Suscripción',
  FREE: 'Gratis',
  ADS: 'Gratis (con anuncios)',
  RENT: 'Alquiler',
  BUY: 'Compra',
};

const MONETIZATION_ORDER = ['FLATRATE', 'FREE', 'ADS', 'RENT', 'BUY'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTitleFromCinemeta(type, imdbId) {
  const { data } = await axios.get(
    `${CINEMETA_URL}/meta/${type}/${encodeURIComponent(imdbId)}.json`,
    { timeout: 6_000 }
  );
  return data?.meta?.name || null;
}

async function findJustWatchNode(title, imdbId, jwObjectType, country, language) {
  const results = await searchTitles({
    query: title,
    objectTypes: [jwObjectType],
    country,
    language,
    first: 10,
  });
  return results.find((n) => n?.content?.externalIds?.imdbId === imdbId) || null;
}

function offerToStream(offer) {
  const service = offer.package?.clearName || 'JustWatch';
  const label   = MONETIZATION_LABEL[offer.monetizationType] || offer.monetizationType;
  const quality = offer.presentationType ? offer.presentationType.replace(/_/g, ' ') : '';
  const price   = offer.retailPrice || '';
  const parts   = [label, quality, price].filter(Boolean).join(' · ');
  return {
    name: service,
    title: parts,
    externalUrl: offer.standardWebURL,
    behaviorHints: { notWebReady: true },
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * @param {object} args    - { type, id }
 * @param {object} config  - { country, language, packages }
 */
async function handleStream({ type, id }, config) {
  const imdbId  = id.split(':')[0];
  const country = config?.country  || process.env.JUSTWATCH_COUNTRY || 'US';
  const language = config?.language || 'en';

  try {
    let title;
    try {
      title = await fetchTitleFromCinemeta(type, imdbId);
    } catch (e) {
      console.error(`[stream] Cinemeta error for ${imdbId}:`, e.message);
    }

    if (!title) {
      console.warn(`[stream] Could not resolve title for ${imdbId}`);
      return { streams: [] };
    }

    const jwType = type === 'movie' ? 'MOVIE' : 'SHOW';
    const node   = await findJustWatchNode(title, imdbId, jwType, country, language);

    if (!node) {
      console.warn(`[stream] JustWatch: no match for "${title}" (${imdbId})`);
      return { streams: [] };
    }

    const offers = await getTitleOffers(node.id, country, language);
    if (!offers.length) return { streams: [] };

    const sorted = [...offers].sort((a, b) => {
      const ai = MONETIZATION_ORDER.indexOf(a.monetizationType);
      const bi = MONETIZATION_ORDER.indexOf(b.monetizationType);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const streams = sorted.filter((o) => o.standardWebURL).map(offerToStream);
    console.log(`[stream] ${imdbId} → ${streams.length} offers in ${country}`);
    return { streams };
  } catch (err) {
    console.error(`[stream] Unhandled error for ${imdbId}:`, err.message);
    return { streams: [] };
  }
}

module.exports = { handleStream };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch the title name from Cinemeta by IMDB ID.
 * Used to query JustWatch (which only supports text search, not IMDB ID lookup).
 */
async function fetchTitleFromCinemeta(type, imdbId) {
  const { data } = await axios.get(
    `${CINEMETA_URL}/meta/${type}/${encodeURIComponent(imdbId)}.json`,
    { timeout: 6_000 }
  );
  return data?.meta?.name || null;
}

/**
 * Search JustWatch for a title and return the node whose IMDB ID matches.
 */
async function findJustWatchNode(title, imdbId, jwObjectType) {
  const results = await searchTitles({
    query: title,
    objectTypes: [jwObjectType],
    country: COUNTRY,
    first: 10,
  });

  return results.find((n) => n?.content?.externalIds?.imdbId === imdbId) || null;
}

/**
 * Convert a JustWatch offer to a Stremio stream object (external URL).
 */
function offerToStream(offer) {
  const service = offer.package?.clearName || 'JustWatch';
  const label = MONETIZATION_LABEL[offer.monetizationType] || offer.monetizationType;
  const quality = offer.presentationType ? offer.presentationType.replace(/_/g, ' ') : '';
  const price = offer.retailPrice || '';

  const parts = [label, quality, price].filter(Boolean).join(' · ');

  return {
    name: service,
    title: parts,
    externalUrl: offer.standardWebURL,
    behaviorHints: { notWebReady: true },
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Stream handler for stremio-addon-sdk.
 *
 * The ID for a movie is "tt1234567".
 * The ID for a series episode is "tt1234567:1:1" (imdbId:season:episode).
 * We always use the IMDB ID part (before the first colon) so JustWatch
 * returns the series/movie page link rather than a specific episode.
 */
async function handleStream({ type, id }) {
  // Extract bare IMDB ID (handle tt1234567:1:1 episode format for series)
  const imdbId = id.split(':')[0];

  try {
    // 1. Get the human-readable title from Cinemeta
    let title;
    try {
      title = await fetchTitleFromCinemeta(type, imdbId);
    } catch (e) {
      console.error(`[stream] Cinemeta error for ${imdbId}:`, e.message);
    }

    if (!title) {
      console.warn(`[stream] Could not resolve title for ${imdbId}`);
      return { streams: [] };
    }

    // 2. Find the matching JustWatch node using the title + IMDB ID
    const jwType = type === 'movie' ? 'MOVIE' : 'SHOW';
    const node = await findJustWatchNode(title, imdbId, jwType);

    if (!node) {
      console.warn(`[stream] JustWatch: no match for "${title}" (${imdbId})`);
      return { streams: [] };
    }

    // 3. Fetch streaming offers for this node
    const offers = await getTitleOffers(node.id, COUNTRY);

    if (!offers.length) {
      return { streams: [] };
    }

    // 4. Sort by monetization priority, then build stream objects
    const sorted = [...offers].sort((a, b) => {
      const ai = MONETIZATION_ORDER.indexOf(a.monetizationType);
      const bi = MONETIZATION_ORDER.indexOf(b.monetizationType);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const streams = sorted
      .filter((o) => o.standardWebURL)
      .map(offerToStream);

    console.log(`[stream] ${imdbId} → ${streams.length} offers in ${COUNTRY}`);
    return { streams };
  } catch (err) {
    console.error(`[stream] Unhandled error for ${imdbId}:`, err.message);
    return { streams: [] };
  }
}

module.exports = { handleStream };
