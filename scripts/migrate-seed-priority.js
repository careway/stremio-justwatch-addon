"use strict";
/**
 * One-time repair for `query_cache.request_count` (see src/infra/warmCache.js).
 *
 * Until now, scripts/seed-warm-cache.js's register() wrote its synthetic
 * backfill priority (countryBase + providerRank, tens/hundreds of thousands)
 * into request_count via GREATEST — the same column warmCache.touch() bumps
 * by 1 per real live request. That made request_count useless as a "did a
 * real user ask for this" signal: a single seed run inflates it to ~6
 * figures for every provider in a country alike.
 *
 * seed-warm-cache.js now writes its priority to a separate `seed_priority`
 * column instead, but rows touched by a *previous* seed run still carry the
 * old inflated value in request_count. This migration moves it: any row
 * whose request_count looks seed-inflated (above THRESHOLD — no plausible
 * organic count gets there given the 5-minute touch() debounce) has that
 * value moved to seed_priority (so the backfill ordering isn't lost) and
 * request_count reset to 0, so it starts counting real traffic honestly from
 * here.
 *
 *   node --env-file=.env.development.local scripts/migrate-seed-priority.js [--dry-run]
 *
 * Idempotent — rows already below THRESHOLD are left untouched, safe to
 * re-run, safe to run while the addon is live.
 */
const { Pool } = require("pg");

// Organic request_count is bumped at most once per 5-minute window per key
// (TOUCH_DEBOUNCE_MS). Even nonstop traffic for a week caps out in the
// thousands; seed priorities observed in production start at ~20,000.
const THRESHOLD = 10000;

const DRY = process.argv.includes("--dry-run");

async function main() {
  const conn = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
  if (!conn) {
    console.error("DATABASE_URL(_POOLED) not set — run with --env-file=.env.development.local");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: conn.replace(/[?].*/, ""),
    ssl: { rejectUnauthorized: false },
    max: 2,
  });

  await pool.query(
    `ALTER TABLE query_cache ADD COLUMN IF NOT EXISTS seed_priority bigint NOT NULL DEFAULT 0`,
  );

  const { rows: hits } = await pool.query(
    `SELECT key, request_count FROM query_cache WHERE request_count > $1 ORDER BY request_count DESC`,
    [THRESHOLD],
  );

  if (!hits.length) {
    console.log(`Nothing above ${THRESHOLD} — no seed-inflated rows found.`);
    await pool.end();
    return;
  }

  console.log(`${hits.length} row(s) look seed-inflated (request_count > ${THRESHOLD}):`);
  for (const h of hits.slice(0, 10)) console.log(`    ${h.key}  request_count=${h.request_count}`);
  if (hits.length > 10) console.log(`    …and ${hits.length - 10} more`);

  if (DRY) {
    console.log("\n(dry run — nothing written)");
    await pool.end();
    return;
  }

  const { rowCount } = await pool.query(
    `UPDATE query_cache
        SET seed_priority = GREATEST(seed_priority, request_count),
            request_count = 0
      WHERE request_count > $1`,
    [THRESHOLD],
  );
  console.log(`\nRepaired ${rowCount} row(s): priority moved to seed_priority, request_count reset to 0.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
