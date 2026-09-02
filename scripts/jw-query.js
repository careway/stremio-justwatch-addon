#!/usr/bin/env node
"use strict";

// Run one of the addon's JustWatch queries by hand.
//
// Talks straight to the API: no L1/L2 cache, no concurrency queue, no
// dedupe/unreleased filtering. What you see is what JustWatch actually
// returned, which is the point when you're checking whether it's rate-limiting
// or erroring. To exercise the *cached* path instead, call searchTitles:
//   node -e "require('./src/infra/justwatch').searchTitles({country:'ES',packages:['nfx'],first:5}).then(n=>console.log(n.length))"
//
// Uses the built-in fetch (Node >= 18), so it has no dependencies and can be
// copied out of the repo as-is.
//
//   node scripts/jw-query.js --country ES --package nfx --type movie
//   node scripts/jw-query.js --country ES --sort new --offset 50 --raw
//   node scripts/jw-query.js --list-packages --country ES
//   node scripts/jw-query.js --country ES --package nfx --repeat 5

const GRAPHQL_URL = "https://apis.justwatch.com/graphql";

// Kept byte-identical to src/infra/justwatch.js — if you change one, change
// both, or this stops telling you anything about production.
const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

const POPULAR_TITLES_QUERY = `
  query GetPopularTitles(
    $country: Country!
    $first: Int! = 70
    $popularTitlesFilter: TitleFilter
    $popularTitlesSortBy: PopularTitlesSorting! = POPULAR
    $language: Language!
    $sortRandomSeed: Int! = 0
    $offset: Int = 0
  ) {
    popularTitles(
      country: $country
      filter: $popularTitlesFilter
      first: $first
      sortBy: $popularTitlesSortBy
      sortRandomSeed: $sortRandomSeed
      offset: $offset
    ) {
      edges {
        node {
          objectType
          content(country: $country, language: $language) {
            title
            shortDescription
            originalReleaseDate
            genres { shortName }
            externalIds { imdbId }
            posterUrl(profile: S718, format: JPG)
          }
        }
      }
    }
  }
`;

const PACKAGES_QUERY = `
  query GetPackages($country: Country!, $platform: Platform! = WEB) {
    packages(country: $country, platform: $platform) {
      id
      packageId
      clearName
      technicalName
      shortName
      monetizationTypes
      hasTitles(country: $country, platform: $platform)
      hasSport(country: $country, platform: $platform)
      icon(profile: S100)
    }
  }
`;

// The addon's sort keys; a raw JustWatch value is passed through untouched.
const SORT_MAP = { pop: "POPULAR", tnd: "TRENDING", new: "RELEASE_YEAR" };
const TYPE_MAP = { movie: "MOVIE", series: "SHOW", show: "SHOW" };

function parseArgs(argv) {
  const opts = {
    country: "ES",
    language: "es",
    packages: [],
    genres: [],
    type: null,
    sort: "pop",
    first: 50,
    offset: 0,
    query: "",
    yearFilter: true,
    raw: false,
    listPackages: false,
    repeat: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--country": case "-c": opts.country = next().toUpperCase(); break;
      case "--language": case "-l": opts.language = next(); break;
      case "--package": case "-p": opts.packages.push(next()); break;
      case "--genre": case "-g": opts.genres.push(next()); break;
      case "--type": case "-t": opts.type = next(); break;
      case "--sort": case "-s": opts.sort = next(); break;
      case "--first": case "-n": opts.first = Number(next()); break;
      case "--offset": case "-o": opts.offset = Number(next()); break;
      case "--query": case "-q": opts.query = next(); break;
      case "--repeat": opts.repeat = Number(next()); break;
      case "--no-year-filter": opts.yearFilter = false; break;
      case "--raw": opts.raw = true; break;
      case "--list-packages": opts.listPackages = true; break;
      case "--help": case "-h": usage(); process.exit(0);
      default:
        console.error(`Unknown option: ${a}\n`);
        usage();
        process.exit(2);
    }
  }
  return opts;
}

function usage() {
  console.log(`Run one of the addon's JustWatch queries directly.

  -c, --country <XX>     ISO country          (default ES)
  -l, --language <xx>    Title language       (default es)
  -p, --package <sn>     Provider shortName, repeatable (e.g. nfx)
  -g, --genre <sn>       Genre shortName, repeatable (e.g. act)
  -t, --type <t>         movie | series       (default: both)
  -s, --sort <s>         pop | tnd | new, or a raw JW value (default pop)
  -n, --first <n>        Page size, max 50    (default 50)
  -o, --offset <n>       Pagination offset    (default 0)
  -q, --query <text>     Text search          (default: browse)
      --repeat <n>       Fire the same query n times, report each timing
      --no-year-filter   Drop the releaseYear<=thisYear pre-filter
      --raw              Print the raw JSON response instead of a table
      --list-packages    Run the packages query instead
`);
}

async function post(query, variables) {
  const started = Date.now();
  let res, bodyText;
  try {
    res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
    bodyText = await res.text();
  } catch (err) {
    return { ms: Date.now() - started, netError: err };
  }
  const ms = Date.now() - started;

  // Anything rate-limit-shaped is worth surfacing loudly.
  const interesting = {};
  for (const h of ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset", "cf-ray", "server"]) {
    const v = res.headers.get(h);
    if (v) interesting[h] = v;
  }

  let json = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    // leave json null; bodyText is shown below
  }
  return { ms, status: res.status, ok: res.ok, headers: interesting, json, bodyText };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const query = opts.listPackages ? PACKAGES_QUERY : POPULAR_TITLES_QUERY;
  let variables;

  if (opts.listPackages) {
    variables = { country: opts.country, platform: "WEB" };
  } else {
    const filter = {};
    if (opts.query) filter.searchQuery = opts.query;
    const jwType = opts.type ? TYPE_MAP[opts.type.toLowerCase()] : null;
    if (opts.type && !jwType) {
      console.error(`Unknown --type "${opts.type}" (use movie or series)`);
      process.exit(2);
    }
    if (jwType) filter.objectTypes = [jwType];
    if (opts.packages.length) filter.packages = opts.packages;
    if (opts.genres.length) filter.genres = opts.genres;
    if (opts.yearFilter) filter.releaseYear = { max: new Date().getFullYear() };

    variables = {
      popularTitlesFilter: filter,
      country: opts.country,
      first: Math.min(opts.first, 50),
      offset: opts.offset,
      popularTitlesSortBy: SORT_MAP[opts.sort] || opts.sort.toUpperCase(),
      language: opts.language,
      sortRandomSeed: 0,
      platform: "WEB",
    };
  }

  console.error("→ variables:", JSON.stringify(variables));

  for (let attempt = 1; attempt <= opts.repeat; attempt++) {
    const r = await post(query, variables);
    const tag = opts.repeat > 1 ? `[${attempt}/${opts.repeat}] ` : "";

    if (r.netError) {
      console.error(`${tag}✗ network/timeout after ${r.ms}ms: ${r.netError.message}`);
      process.exitCode = 1;
      continue;
    }

    const hdr = Object.entries(r.headers).map(([k, v]) => `${k}=${v}`).join(" ");
    console.error(`${tag}HTTP ${r.status} in ${r.ms}ms${hdr ? "  " + hdr : ""}`);

    if (!r.ok || !r.json) {
      console.error(r.bodyText.slice(0, 2000));
      process.exitCode = 1;
      continue;
    }
    if (r.json.errors) {
      console.error(`${tag}✗ GraphQL errors:`);
      console.error(JSON.stringify(r.json.errors, null, 2));
      process.exitCode = 1;
      continue;
    }

    if (opts.raw) {
      console.log(JSON.stringify(r.json.data, null, 2));
      continue;
    }

    if (opts.listPackages) {
      const pkgs = r.json.data?.packages || [];
      console.error(`${tag}${pkgs.length} packages`);
      for (const p of pkgs) {
        console.log(`${String(p.shortName).padEnd(5)} ${String(p.technicalName).padEnd(22)} ${p.clearName}`);
      }
      continue;
    }

    const nodes = (r.json.data?.popularTitles?.edges || []).map((e) => e.node);
    const noImdb = nodes.filter((n) => !n.content?.externalIds?.imdbId).length;
    console.error(`${tag}${nodes.length} nodes  (${noImdb} without imdbId — the addon drops those)`);
    nodes.forEach((n, i) => {
      const c = n.content || {};
      console.log(
        [
          String(opts.offset + i).padStart(4),
          (c.externalIds?.imdbId || "—").padEnd(11),
          (n.objectType || "?").padEnd(6),
          (c.originalReleaseDate || "—").padEnd(11),
          c.title || "—",
        ].join("  "),
      );
    });
  }
}

main().catch((err) => {
  console.error("unexpected:", err);
  process.exit(1);
});
