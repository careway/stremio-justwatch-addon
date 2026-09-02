import { Addon, Option, UserData } from '../db/index.js';
import { CacheKeyRequestOptions, Preset, baseOptions } from './preset.js';
import { constants } from '../utils/index.js';
import { config as appConfig } from '../config/index.js';

// Public instance. Kept as a constant so the preset compiles before the
// matching entry is added to packages/core/src/config — once it exists,
// appConfig.presets.omnicatalog.url takes precedence (self-hosters can point
// this at their own deployment).
const DEFAULT_OMNICATALOG_URL = 'https://5cfe2edf73d5-omnicatalogs.baby-beamup.club';

const presetConfig = (
  appConfig.presets as unknown as Record<
    string,
    { url?: string; defaultTimeout?: number; defaultUserAgent?: string } | undefined
  >
).omnicatalog;

export class OmniCatalogPreset extends Preset {
  // OmniCatalog builds its catalogs from JustWatch, so a "provider" is a
  // JustWatch package shortName. The list below covers the services available
  // in most regions; anything else can be added through the free-text option.
  // Note Prime Video ships under two different shortNames depending on the
  // country (prv in ES/DE/IT/FR, amp in US/GB) — both are offered, and an
  // unknown shortName is simply ignored by the addon rather than failing.
  private static providers = [
    { label: 'Netflix', value: 'nfx' },
    { label: 'Netflix (with ads)', value: 'nfa' },
    { label: 'Netflix Kids', value: 'nfk' },
    { label: 'Disney+', value: 'dnp' },
    { label: 'HBO Max', value: 'mxx' },
    { label: 'Prime Video (ES/DE/FR/IT…)', value: 'prv' },
    { label: 'Prime Video (US/GB…)', value: 'amp' },
    { label: 'Amazon Video (store)', value: 'amz' },
    { label: 'Apple TV+', value: 'atp' },
    { label: 'Apple TV (store)', value: 'itu' },
    { label: 'Paramount+', value: 'pmp' },
    { label: 'SkyShowtime', value: 'sst' },
    { label: 'Crunchyroll', value: 'cru' },
    { label: 'MUBI', value: 'mbi' },
    { label: 'Pluto TV', value: 'ptv' },
    { label: 'YouTube Premium', value: 'ytr' },
    { label: 'Curiosity Stream', value: 'cts' },
    { label: 'MagellanTV', value: 'mgl' },
    { label: 'Hayu', value: 'hay' },
    { label: 'FilmBox+', value: 'flb' },
    { label: 'Shahid VIP', value: 'sha' },
    { label: 'Filmin', value: 'fil' },
    { label: 'Movistar Plus+', value: 'mp9' },
    { label: 'Rakuten TV', value: 'wki' },
    { label: 'Plex', value: 'pxp' },
    { label: 'Sun Nxt', value: 'snx' },
    { label: 'Hoichoi', value: 'hoc' },
  ];

  // Catalog types, one per sort order the addon exposes.
  private static catalogTypes = [
    { label: 'Popular', value: 'pop' },
    { label: 'Trending', value: 'tnd' },
    { label: 'New', value: 'new' },
  ];

  private static readonly ALL_CATALOG_TYPES = ['pop', 'tnd', 'new'];

  private static languages = [
    { label: 'English', value: 'en' },
    { label: 'Español', value: 'es' },
    { label: 'Deutsch', value: 'de' },
    { label: 'Français', value: 'fr' },
    { label: 'Italiano', value: 'it' },
    { label: 'Português', value: 'pt' },
    { label: 'Nederlands', value: 'nl' },
    { label: 'Svenska', value: 'sv' },
    { label: 'Norsk', value: 'no' },
    { label: 'Dansk', value: 'da' },
    { label: 'Suomi', value: 'fi' },
    { label: 'Polski', value: 'pl' },
    { label: '日本語', value: 'ja' },
    { label: '한국어', value: 'ko' },
    { label: 'العربية', value: 'ar' },
    { label: 'हिन्दी', value: 'hi' },
    { label: 'తెలుగు', value: 'te' },
    { label: 'മലയാളം', value: 'ml' },
    { label: 'ಕನ್ನಡ', value: 'kn' },
  ];

  private static countries = [
    { label: 'Albania', value: 'AL' },
    { label: 'Algeria', value: 'DZ' },
    { label: 'Andorra', value: 'AD' },
    { label: 'Angola', value: 'AO' },
    { label: 'Argentina', value: 'AR' },
    { label: 'Australia', value: 'AU' },
    { label: 'Austria', value: 'AT' },
    { label: 'Azerbaijan', value: 'AZ' },
    { label: 'Bahrain', value: 'BH' },
    { label: 'Belarus', value: 'BY' },
    { label: 'Belgium', value: 'BE' },
    { label: 'Belize', value: 'BZ' },
    { label: 'Bermuda', value: 'BM' },
    { label: 'Bolivia', value: 'BO' },
    { label: 'Bosnia & Herzegovina', value: 'BA' },
    { label: 'Brazil', value: 'BR' },
    { label: 'Bulgaria', value: 'BG' },
    { label: 'Burkina Faso', value: 'BF' },
    { label: 'Cameroon', value: 'CM' },
    { label: 'Canada', value: 'CA' },
    { label: 'Cape Verde', value: 'CV' },
    { label: 'Chad', value: 'TD' },
    { label: 'Chile', value: 'CL' },
    { label: 'Colombia', value: 'CO' },
    { label: 'Costa Rica', value: 'CR' },
    { label: 'Croatia', value: 'HR' },
    { label: 'Cyprus', value: 'CY' },
    { label: 'Czechia', value: 'CZ' },
    { label: 'Denmark', value: 'DK' },
    { label: 'Ecuador', value: 'EC' },
    { label: 'Egypt', value: 'EG' },
    { label: 'El Salvador', value: 'SV' },
    { label: 'Estonia', value: 'EE' },
    { label: 'Fiji', value: 'FJ' },
    { label: 'Finland', value: 'FI' },
    { label: 'France', value: 'FR' },
    { label: 'French Guiana', value: 'GF' },
    { label: 'French Polynesia', value: 'PF' },
    { label: 'Germany', value: 'DE' },
    { label: 'Ghana', value: 'GH' },
    { label: 'Gibraltar', value: 'GI' },
    { label: 'Greece', value: 'GR' },
    { label: 'Guatemala', value: 'GT' },
    { label: 'Guernsey', value: 'GG' },
    { label: 'Guyana', value: 'GY' },
    { label: 'Honduras', value: 'HN' },
    { label: 'Hong Kong SAR China', value: 'HK' },
    { label: 'Hungary', value: 'HU' },
    { label: 'Iceland', value: 'IS' },
    { label: 'India', value: 'IN' },
    { label: 'Indonesia', value: 'ID' },
    { label: 'Iraq', value: 'IQ' },
    { label: 'Ireland', value: 'IE' },
    { label: 'Israel', value: 'IL' },
    { label: 'Italy', value: 'IT' },
    { label: 'Japan', value: 'JP' },
    { label: 'Jordan', value: 'JO' },
    { label: 'Kenya', value: 'KE' },
    { label: 'Kosovo', value: 'XK' },
    { label: 'Kuwait', value: 'KW' },
    { label: 'Latvia', value: 'LV' },
    { label: 'Lebanon', value: 'LB' },
    { label: 'Libya', value: 'LY' },
    { label: 'Liechtenstein', value: 'LI' },
    { label: 'Lithuania', value: 'LT' },
    { label: 'Luxembourg', value: 'LU' },
    { label: 'Madagascar', value: 'MG' },
    { label: 'Malawi', value: 'MW' },
    { label: 'Malaysia', value: 'MY' },
    { label: 'Mali', value: 'ML' },
    { label: 'Malta', value: 'MT' },
    { label: 'Mauritius', value: 'MU' },
    { label: 'Mexico', value: 'MX' },
    { label: 'Moldova', value: 'MD' },
    { label: 'Monaco', value: 'MC' },
    { label: 'Montenegro', value: 'ME' },
    { label: 'Morocco', value: 'MA' },
    { label: 'Mozambique', value: 'MZ' },
    { label: 'Netherlands', value: 'NL' },
    { label: 'New Zealand', value: 'NZ' },
    { label: 'Nicaragua', value: 'NI' },
    { label: 'Niger', value: 'NE' },
    { label: 'Nigeria', value: 'NG' },
    { label: 'North Macedonia', value: 'MK' },
    { label: 'Norway', value: 'NO' },
    { label: 'Oman', value: 'OM' },
    { label: 'Pakistan', value: 'PK' },
    { label: 'Palestinian Territories', value: 'PS' },
    { label: 'Panama', value: 'PA' },
    { label: 'Papua New Guinea', value: 'PG' },
    { label: 'Paraguay', value: 'PY' },
    { label: 'Peru', value: 'PE' },
    { label: 'Philippines', value: 'PH' },
    { label: 'Poland', value: 'PL' },
    { label: 'Portugal', value: 'PT' },
    { label: 'Qatar', value: 'QA' },
    { label: 'Romania', value: 'RO' },
    { label: 'Russia', value: 'RU' },
    { label: 'San Marino', value: 'SM' },
    { label: 'Saudi Arabia', value: 'SA' },
    { label: 'Senegal', value: 'SN' },
    { label: 'Serbia', value: 'RS' },
    { label: 'Seychelles', value: 'SC' },
    { label: 'Singapore', value: 'SG' },
    { label: 'Slovakia', value: 'SK' },
    { label: 'Slovenia', value: 'SI' },
    { label: 'South Africa', value: 'ZA' },
    { label: 'South Korea', value: 'KR' },
    { label: 'Spain', value: 'ES' },
    { label: 'Sweden', value: 'SE' },
    { label: 'Switzerland', value: 'CH' },
    { label: 'Taiwan', value: 'TW' },
    { label: 'Tanzania', value: 'TZ' },
    { label: 'Thailand', value: 'TH' },
    { label: 'Tunisia', value: 'TN' },
    { label: 'Turkey', value: 'TR' },
    { label: 'Uganda', value: 'UG' },
    { label: 'Ukraine', value: 'UA' },
    { label: 'United Arab Emirates', value: 'AE' },
    { label: 'United Kingdom', value: 'GB' },
    { label: 'United States', value: 'US' },
    { label: 'Uruguay', value: 'UY' },
    { label: 'Vatican City', value: 'VA' },
    { label: 'Venezuela', value: 'VE' },
    { label: 'Yemen', value: 'YE' },
    { label: 'Zambia', value: 'ZM' },
    { label: 'Zimbabwe', value: 'ZW' },
  ];

  static override get METADATA() {
    const supportedResources = [constants.CATALOG_RESOURCE];

    const options: Option[] = [
      ...baseOptions(
        'OmniCatalog',
        supportedResources,
        presetConfig?.defaultTimeout ?? appConfig.presets.defaultTimeout
      ).filter((option) => option.id !== 'url'),
      {
        id: 'country',
        name: 'Country',
        description:
          'Which country’s streaming availability the catalogs are built from',
        type: 'select',
        required: true,
        options: this.countries,
        default: 'US',
      },
      {
        id: 'language',
        name: 'Language',
        description:
          'Language for titles, descriptions, genres and catalog names',
        type: 'select',
        required: true,
        options: this.languages,
        default: 'en',
      },
      {
        id: 'providers',
        name: 'Streaming services',
        description:
          'One set of catalogs is generated per selected service. Availability varies by country.',
        type: 'multi-select',
        required: false,
        options: this.providers,
        default: ['nfx', 'dnp', 'mxx', 'atp'],
      },
      {
        id: 'extraProviders',
        name: 'Additional services',
        description:
          'Comma-separated JustWatch shortNames for services missing from the list above (e.g. "flx,atr"). Find them on the addon’s own configure page.',
        type: 'string',
        required: false,
      },
      {
        id: 'catalogTypes',
        name: 'Catalog types',
        description: 'Which catalogs to generate for each selected service',
        type: 'multi-select',
        required: false,
        options: this.catalogTypes,
        default: ['pop', 'tnd', 'new'],
      },
      {
        id: 'globalCatalogTypes',
        name: 'Country-wide catalogs',
        description:
          'Catalogs covering every service in the country at once, with no per-service filter. Leave empty to disable.',
        type: 'multi-select',
        required: false,
        options: this.catalogTypes,
        default: [],
      },
      {
        id: 'configString',
        name: 'Configuration string (advanced)',
        description:
          'Paste the segment from a URL generated on the addon’s configure page (e.g. "ES_es_sorts-pop_nfx_dnp") to use it verbatim. Overrides every option above.',
        type: 'string',
        required: false,
      },
      {
        id: 'socials',
        name: '',
        description: '',
        type: 'socials',
        socials: [
          {
            id: 'github',
            url: 'https://github.com/careway/stremio-justwatch-addon',
          },
          { id: 'ko-fi', url: 'https://ko-fi.com/careway' },
        ],
      },
    ];

    return {
      ID: 'omnicatalog',
      NAME: 'OmniCatalog',
      LOGO: `${presetConfig?.url ?? DEFAULT_OMNICATALOG_URL}/static/logo-256.png`,
      URL: presetConfig?.url ?? DEFAULT_OMNICATALOG_URL,
      TIMEOUT: presetConfig?.defaultTimeout ?? appConfig.presets.defaultTimeout,
      USER_AGENT:
        presetConfig?.defaultUserAgent ?? appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        'Catalogs of what is actually available on your streaming services, in your country — powered by JustWatch.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: supportedResources,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    return [this.generateAddon(userData, options)];
  }

  private static generateAddon(
    userData: UserData,
    options: Record<string, any>
  ): Addon {
    const config = this.buildConfigString(options);
    return {
      name: options.name || this.METADATA.NAME,
      manifestUrl: `${this.DEFAULT_URL}/${config}/manifest.json`,
      enabled: true,
      library: false,
      resources: options.resources || this.METADATA.SUPPORTED_RESOURCES,
      timeout: options.timeout || this.METADATA.TIMEOUT,
      preset: {
        id: '',
        type: this.METADATA.ID,
        options: options,
      },
      headers: {
        'User-Agent': this.METADATA.USER_AGENT,
      },
    };
  }

  /**
   * OmniCatalog encodes its whole configuration in one human-readable path
   * segment: {COUNTRY}_{language}[_sorts-…][_gsorts-…]_{service}_{service}…
   * A "sorts-" segment is only emitted for a partial selection — omitting it
   * means "all types", which is what the addon defaults to.
   */
  private static buildConfigString(options: Record<string, any>): string {
    const override = (options.configString || '').trim();
    if (override) return override;

    const extra: string[] = (options.extraProviders || '')
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => /^[a-z0-9-]{1,30}$/.test(s));
    const providers: string[] = [
      ...new Set([...(options.providers || []), ...extra]),
    ];

    const catalogTypes: string[] = options.catalogTypes ?? [
      ...this.ALL_CATALOG_TYPES,
    ];
    const globalTypes: string[] = options.globalCatalogTypes ?? [];

    if (!providers.length && !globalTypes.length) {
      throw new Error(
        `${this.METADATA.NAME} requires at least one streaming service, or at least one country-wide catalog type`
      );
    }
    if (providers.length && !catalogTypes.length) {
      throw new Error(
        `${this.METADATA.NAME} requires at least one catalog type when streaming services are selected`
      );
    }

    const parts: string[] = [options.country, options.language];
    if (providers.length && catalogTypes.length < this.ALL_CATALOG_TYPES.length) {
      parts.push(`sorts-${catalogTypes.join('-')}`);
    }
    if (globalTypes.length && globalTypes.length < this.ALL_CATALOG_TYPES.length) {
      parts.push(`gsorts-${globalTypes.join('-')}`);
    }
    parts.push(...providers);
    if (globalTypes.length) parts.push('global');

    return parts.join('_');
  }

  static override getCacheKey(
    options: CacheKeyRequestOptions
  ): string | undefined {
    const { resource, type, id, options: presetOptions, extras } = options;
    try {
      if (new URL(presetOptions.url).origin !== this.DEFAULT_URL) {
        return undefined;
      }
    } catch {}
    let cacheKey = `${this.METADATA.ID}-${type}-${id}-${extras}`;
    if (resource === 'manifest') {
      cacheKey += `-${this.buildConfigString(presetOptions)}`;
    }
    return cacheKey;
  }
}
