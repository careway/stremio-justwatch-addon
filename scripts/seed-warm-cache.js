"use strict";
/**
 * Seed the `query_cache` table (see src/infra/warmCache.js) for a set of
 * countries, most-requested first, so the running addon's warmer has a
 * priority-ordered backlog to work through.
 *
 *   node --env-file=.env.development.local scripts/seed-warm-cache.js [options]
 *
 * By default it only REGISTERS the query keys (rows with a NULL payload and a
 * seeded request_count). The addon's background warmer then fills them at its
 * own trickle — nothing here hammers JustWatch.
 *
 * Options
 *   --countries ES,US,DE   explicit priority order (highest first).
 *                          Omitted → rank by request_count already in the
 *                          table, then fall back to a built-in list.
 *   --providers-limit N    only the first N providers per country (JustWatch
 *                          returns them roughly by relevance). Default: all.
 *   --sorts pop,tnd,new    which sorts to seed. Default: all three.
 *   --types movie,series   which content types. Default: both.
 *   --fetch                also call JustWatch now, spaced by --delay, and
 *                          write payloads. Skips entries still fresh.
 *   --delay MS             gap between JustWatch calls in --fetch (default 3000,
 *                          ±50% jitter). On a 403 it backs off 10×delay and
 *                          doubles, giving up after three.
 *   --dry-run              print what would be inserted, touch nothing.
 *
 * One provider-catalog costs sorts × types keys (default 6), plus one "global"
 * set and one packages entry per country. ES ≈ 125 providers ≈ 756 keys.
 */
const { Pool } = require("pg");
const { getPackages, _warmRefetch, breaker } = require("../src/infra/justwatch");
const { getLanguageFromRequest } = require("../src/http/request");
const { SORT_MAP, GLOBAL_PACKAGE_ID } = require("../src/data/catalogMeta");
const { TTL_S, PACKAGES_TTL_S } = require("../src/ttl");

// ─── args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    countries: null,
    providersLimit: Infinity,
    sorts: ["pop", "tnd", "new"],
    types: ["movie", "series"],
    fetch: false,
    delay: 3000,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fetch") o.fetch = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--countries") o.countries = argv[++i].split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--providers-limit") o.providersLimit = Number(argv[++i]);
    else if (a === "--sorts") o.sorts = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--types") o.types = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--delay") o.delay = Number(argv[++i]);
    else {
      console.error(`unknown option: ${a}`);
      process.exit(1);
    }
  }
  return o;
}

// Rough "big Stremio markets" order, used only when the table has nothing to
// rank and --countries wasn't given.
const DEFAULT_COUNTRIES = [
  "US", "GB", "DE", "ES", "FR", "IT", "CA", "BR", "NL", "AU",
  "MX", "PT", "SE", "PL", "AR", "BE", "AT", "CH", "IE", "DK",
  "NO", "FI", "CO", "CL", "JP",
];

const TYPE_TO_JW = { movie: "MOVIE", series: "SHOW" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const langFor = (country) => getLanguageFromRequest({ headers: {} }, country);

// ─── key/vars builders — must match src/infra/justwatch.js exactly ──────────

function searchEntry({ shortName, type, sortKey, country, language }) {
  const objectTypes = [TYPE_TO_JW[type]];
  const packages = shortName === GLOBAL_PACKAGE_ID ? [] : [shortName];
  const sortBy = SORT_MAP[sortKey];
  const vars = {
    query: "",
    objectTypes,
    packages,
    genres: [],
    sortBy,
    country,
    language,
    first: 50,
    offset: 0,
  };
  const key = `search:${vars.query}:${objectTypes.join(",")}:${packages.join(",")}:${vars.genres.join(",")}:${sortBy}:${country}:${language}:${vars.first}:${vars.offset}`;
  return { key, vars };
}

// ─── plan ───────────────────────────────────────────────────────────────────

async function rankCountries(pool, explicit) {
  if (explicit) return explicit;
  const { rows } = await pool.query(
    `SELECT vars->>'country' AS c, sum(request_count) AS n
       FROM query_cache
      WHERE vars ? 'country'
      GROUP BY 1 ORDER BY n DESC`,
  );
  const ranked = rows.map((r) => r.c).filter(Boolean);
  const seen = new Set(ranked);
  return [...ranked, ...DEFAULT_COUNTRIES.filter((c) => !seen.has(c))];
}

async function buildPlan(pool, opt) {
  const countries = await rankCountries(pool, opt.countries);
  const plan = []; // { key, vars, priority, label, kind }
  for (let ci = 0; ci < countries.length; ci++) {
    const country = countries[ci];
    const language = langFor(country);
    const countryBase = (countries.length - ci) * 10000;

    // packages entry
    plan.push({
      key: `packages:${country}`,
      vars: { country },
      priority: countryBase + 9999,
      label: `${country} packages`,
      kind: "packages",
    });

    let providers;
    try {
      providers = await getPackages(country);
    } catch (err) {
      console.warn(`  ${country}: getPackages failed (${err.message}) — skipping providers`);
      providers = [];
    }
    const shortNames = [
      GLOBAL_PACKAGE_ID,
      ...providers
        .map((p) => p.shortName)
        .filter(Boolean)
        .slice(0, opt.providersLimit),
    ];

    shortNames.forEach((shortName, pi) => {
      // global first, then providers in JustWatch's own order
      const providerRank = shortName === GLOBAL_PACKAGE_ID ? 5000 : 4000 - pi;
      for (const sortKey of opt.sorts) {
        for (const type of opt.types) {
          const { key, vars } = searchEntry({ shortName, type, sortKey, country, language });
          plan.push({
            key,
            vars,
            priority: countryBase + providerRank,
            label: `${country}/${language} ${shortName} ${sortKey} ${type}`,
            kind: "search",
          });
        }
      }
    });
    console.log(`  planned ${country}: ${shortNames.length} catalog sets (${language})`);
  }
  return plan;
}

// ─── apply ──────────────────────────────────────────────────────────────────

async function register(pool, entry) {
  await pool.query(
    `INSERT INTO query_cache (key, vars, last_requested_at, request_count)
     VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET
       request_count     = GREATEST(query_cache.request_count, EXCLUDED.request_count),
       last_requested_at = now(),
       vars              = EXCLUDED.vars`,
    [entry.key, JSON.stringify(entry.vars), entry.priority],
  );
}

async function isFresh(pool, key) {
  const ttl = key.startsWith("packages:") ? PACKAGES_TTL_S : TTL_S;
  const { rows } = await pool.query(
    `SELECT payload_at IS NOT NULL
        AND payload_at > now() - ($2 || ' seconds')::interval AS fresh
       FROM query_cache WHERE key = $1`,
    [key, ttl],
  );
  return rows[0]?.fresh === true;
}

async function fillPayload(pool, entry) {
  const payload = await _warmRefetch(entry.key, entry.vars);
  await pool.query(
    `UPDATE query_cache SET payload = $2::jsonb, payload_at = now() WHERE key = $1`,
    [entry.key, JSON.stringify(payload)],
  );
  return Array.isArray(payload) ? payload.length : 0;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opt = parseArgs(process.argv);
  const conn = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
  if (!conn) {
    console.error("DATABASE_URL(_POOLED) not set — run with --env-file=.env.development.local");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: conn.replace(/[?].*/, ""),
    ssl: { rejectUnauthorized: false },
    max: 3,
  });

  console.log("Building plan…");
  const plan = await buildPlan(pool, opt);
  plan.sort((a, b) => b.priority - a.priority);
  console.log(`\n${plan.length} entries planned.\n`);

  if (opt.dryRun) {
    for (const e of plan) console.log(`  [${String(e.priority).padStart(6)}] ${e.label}  →  ${e.key}`);
    await pool.end();
    return;
  }

  // Phase 1: register every key (fast, no upstream).
  let n = 0;
  for (const e of plan) {
    await register(pool, e);
    if (++n % 100 === 0) console.log(`  registered ${n}/${plan.length}`);
  }
  console.log(`Registered ${plan.length} keys.`);

  if (!opt.fetch) {
    console.log("Done — the addon's warmer will fill the payloads from here.");
    await pool.end();
    return;
  }

  // Phase 2: fill payloads now, spaced, resumable.
  // ±50% jitter on the gap so the cadence isn't a fixed tick, and a growing
  // pause on 403 (DataDome) specifically — that's an IP-reputation block, not
  // a transient error, so digging in makes it worse.
  console.log(`\nFetching payloads, ~${opt.delay}ms apart (±50%)…\n`);
  const jitter = (ms) => Math.round(ms * (0.5 + Math.random()));
  const MAX_BACKOFF = 5 * 60_000;
  let ok = 0;
  let skipped = 0;
  let fails = 0;
  let blocks = 0;
  let backoff = opt.delay * 10;
  for (let i = 0; i < plan.length; i++) {
    const e = plan[i];
    const tag = `[${String(i + 1).padStart(4)}/${plan.length}] ${e.label}`;
    if (await isFresh(pool, e.key)) {
      skipped++;
      continue;
    }
    if (breaker.isOpen()) {
      console.log(`${tag} — breaker open, waiting ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
    try {
      const count = await fillPayload(pool, e);
      ok++;
      fails = 0;
      blocks = 0;
      backoff = opt.delay * 10;
      console.log(`${tag} — ok (${count})`);
    } catch (err) {
      const status = err.response?.status;
      if (status === 403) {
        blocks++;
        console.warn(`${tag} — 403 (DataDome). backing off ${Math.round(backoff / 1000)}s`);
        if (blocks >= 3) {
          console.error(
            "\n3 × 403 — this IP is blocked. Wait, or run the backfill from " +
              "another network (home/dev). Re-run to resume where it left off.",
          );
          break;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
        continue; // don't also sleep the normal gap
      }
      fails++;
      console.warn(`${tag} — FAIL: ${err.message}`);
      if (fails >= 8) {
        console.error("8 consecutive failures — aborting. Re-run to resume.");
        break;
      }
      await sleep(jitter(opt.delay * 3));
    }
    await sleep(jitter(opt.delay));
  }
  console.log(
    `\nDone. filled ${ok}, skipped ${skipped} (already fresh)` +
      (blocks ? `, stopped on 403` : "") + ".",
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
