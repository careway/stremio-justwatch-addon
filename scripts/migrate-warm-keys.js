"use strict";
/**
 * Rewrite `query_cache` keys after a key-format change (see src/infra/warmCache.js).
 *
 *   node --env-file=.env.development.local scripts/migrate-warm-keys.js [--dry-run]
 *
 * Each rule maps an old key pattern to a new one. Rows are folded onto the new
 * key (payload/timestamps kept from whichever side is newer, request_count
 * summed), then the old rows are deleted. Idempotent — safe to re-run, and safe
 * to run while the addon is live.
 *
 * Current rules:
 *   packages:v2:XX          → packages:XX     (dropped the "v2" schema tag)
 *
 * The `search:*` keys are unchanged by the country-in-catalog-id work: they are
 * built from searchTitles() arguments, not from the catalog id, so nothing to
 * migrate there.
 */
const { Pool } = require("pg");

const RULES = [
  {
    name: "drop packages v2 tag",
    // POSIX regex for the WHERE clause + regexp_replace
    match: "^packages:v2:",
    replace: "packages:",
  },
];

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

  for (const rule of RULES) {
    const { rows: hits } = await pool.query(
      `SELECT key, regexp_replace(key, $1, $2) AS new_key
         FROM query_cache
        WHERE key ~ $1`,
      [rule.match, rule.replace],
    );
    if (!hits.length) {
      console.log(`· ${rule.name}: nothing to do`);
      continue;
    }
    console.log(`· ${rule.name}: ${hits.length} row(s)`);
    for (const h of hits.slice(0, 10)) console.log(`    ${h.key}  →  ${h.new_key}`);
    if (hits.length > 10) console.log(`    …and ${hits.length - 10} more`);
    if (DRY) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Fold old rows onto the new key.
      await client.query(
        `INSERT INTO query_cache (key, vars, payload, payload_at, last_requested_at, request_count)
         SELECT regexp_replace(key, $1, $2), vars, payload, payload_at, last_requested_at, request_count
           FROM query_cache
          WHERE key ~ $1
         ON CONFLICT (key) DO UPDATE SET
           payload = CASE
             WHEN query_cache.payload IS NULL
               OR EXCLUDED.payload_at > query_cache.payload_at
             THEN EXCLUDED.payload ELSE query_cache.payload END,
           payload_at        = GREATEST(query_cache.payload_at, EXCLUDED.payload_at),
           last_requested_at  = GREATEST(query_cache.last_requested_at, EXCLUDED.last_requested_at),
           request_count      = query_cache.request_count + EXCLUDED.request_count,
           vars               = EXCLUDED.vars`,
        [rule.match, rule.replace],
      );
      const { rowCount } = await client.query(
        `DELETE FROM query_cache WHERE key ~ $1`,
        [rule.match],
      );
      await client.query("COMMIT");
      console.log(`    migrated, removed ${rowCount} old row(s)`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`    FAILED: ${err.message}`);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log(DRY ? "\n(dry run — nothing written)" : "\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
