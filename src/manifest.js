'use strict';

const COUNTRY = process.env.JUSTWATCH_COUNTRY || 'ES';

module.exports = {
  id: 'community.justwatch.stremio.addon',
  version: '1.0.0',
  name: 'JustWatch',
  description: `Encuentra dónde ver películas y series usando JustWatch. País configurado: ${COUNTRY}.`,
  logo: 'https://widget.justwatch.com/assets/JW_logo_color_10px.svg',
  background: 'https://images.justwatch.com/backdrop/305764650/s1920/the-substance.jpg',
  resources: [
    'catalog',
    // Stream handler: only for IMDB IDs (tt prefix), so Stremio knows when to call us
    { resource: 'stream', type: 'movie', idPrefixes: ['tt'] },
    { resource: 'stream', type: 'series', idPrefixes: ['tt'] },
  ],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'jw-popular-movies',
      name: 'JustWatch Popular',
      extra: [
        { name: 'search' },
        { name: 'skip' },
      ],
    },
    {
      type: 'series',
      id: 'jw-popular-series',
      name: 'JustWatch Popular',
      extra: [
        { name: 'search' },
        { name: 'skip' },
      ],
    },
  ],
  behaviorHints: {
    configurable: false,
    adult: false,
  },
};
