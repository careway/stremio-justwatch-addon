"use strict";
/**
 * Tail `beamup-cli logs` (production) and, for every JustWatch upstream
 * failure it prints, replay that exact query from HERE — a different IP,
 * presumably not DataDome-blocked — and write the fresh payload into the
 * shared Postgres `query_cache` (and this process's own L1/L2).
 *
 * Why this helps even though this process's cache isn't production's: a
 * fresh Postgres row means the *next* time production's own warmer/seedL1
 * looks at that key (on its own tick, or on its next restart), it finds a
 * live payload instead of nothing — so production recovers from a block
 * without needing its own IP to first cool down and succeed on its own.
 *
 *   node --env-file=.env.development.local scripts/watch-and-warm.js
 *
 * Runs forever (follows beamup's log stream). Ctrl+C to stop.
 */
const { spawn } = require("child_process");
const { getPackages, searchTitles } = require("../src/infra/justwatch");

// Space out our own calls to JustWatch so this doesn't become the next IP
// DataDome flags — see ttl.js's UPSTREAM_BLOCK_COOLDOWN_S for why that matters.
const WARM_DELAY_MS = 200;

// Don't re-warm the same failing key more than once per this window — a
// blocked production instance will log the same failure repeatedly.
const REWARM_COOLDOWN_MS = 5 * 60 * 1000;
const lastWarmed = new Map(); // key -> ms

const queue = [];
let draining = false;
const summary = { warmed: 0, failed: 0 };

function keyFor(vars) {
  return vars.kind === "packages"
    ? `packages:${vars.country}`
    : `search::${vars.objectTypes.join(",")}:${vars.packages.join(",")}:${vars.genres.join(",")}:${vars.sortBy}:${vars.country}:${vars.language}:50:${vars.offset}`;
}

function enqueue(vars) {
  const key = keyFor(vars);
  const now = Date.now();
  const last = lastWarmed.get(key);
  if (last && now - last < REWARM_COOLDOWN_MS) return;
  lastWarmed.set(key, now);
  queue.push({ key, vars });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const { key, vars } = queue.shift();
    try {
      if (vars.kind === "packages") {
        await getPackages(vars.country, { force: true });
      } else {
        // Always first:50 regardless of what production's own vars.first
        // said (it may have been mid-block-fetch at 100) — searchTitles's
        // own block logic re-derives the right 100-aligned upstream fetch
        // from a 50-aligned offset, which production's offsets always are.
        await searchTitles({
          objectTypes: vars.objectTypes,
          packages: vars.packages,
          genres: vars.genres,
          sortBy: vars.sortBy,
          country: vars.country,
          language: vars.language,
          first: 50,
          offset: vars.offset,
          force: true,
        });
      }
      summary.warmed++;
      console.log(`[watch-and-warm] warmed ${key}`);
    } catch (err) {
      summary.failed++;
      console.warn(`[watch-and-warm] failed to warm ${key}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, WARM_DELAY_MS));
  }
  draining = false;
}

// One failure line looks like:
//   ERROR [justwatch] HTTP 403 — ... | vars: {"country":"KR",...}
// The vars blob is deliberately truncated to 200 chars by justwatch.js's own
// logging (see its comment on fan-out noise) — it is usually NOT valid,
// complete JSON. So this pulls individual fields out with regexes instead of
// JSON.parse, tolerant of a cut-off tail. Field order in the real object
// (searchQuery?, objectTypes?, packages?, genres?, releaseYear, then country,
// first, offset, sortBy, language...) means country/first/offset/sortBy and,
// for a provider-specific query, packages too, normally survive the cut —
// only trailing fields like `platform` reliably get lost.
const FAILURE_RE = /ERROR \[justwatch\].*\| vars: (\{.*)/;
const arr = (blob, key) => {
  const m = new RegExp(`"${key}":\\[(.*?)\\]`).exec(blob);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
};
const str = (blob, key) => {
  const m = new RegExp(`"${key}":"([^"]*)"`).exec(blob);
  return m ? m[1] : null;
};
const num = (blob, key) => {
  const m = new RegExp(`"${key}":(\\d+)`).exec(blob);
  return m ? Number(m[1]) : null;
};

function parseFailureVars(blob) {
  const country = str(blob, "country");
  if (!country) return null;
  // getPackages' vars are {"country","platform","includeAddons"} — no sort/
  // filter fields at all, unlike every search call.
  const isPackages = /"includeAddons"/.test(blob) && !/"popularTitlesSortBy"|"popularTitlesFilter"/.test(blob);
  if (isPackages) return { kind: "packages", country };
  return {
    kind: "search",
    country,
    objectTypes: arr(blob, "objectTypes"),
    packages: arr(blob, "packages"),
    genres: arr(blob, "genres"),
    sortBy: str(blob, "popularTitlesSortBy") || "POPULAR",
    language: str(blob, "language") || "en",
    first: num(blob, "first") || 50,
    offset: num(blob, "offset") || 0,
  };
}

// beamup-cli logs replays its visible history on every invocation, and the
// lines don't arrive in strict chronological order (confirmed: an old
// historical line can show up interleaved after a newer one) — so skipping
// by "highest timestamp seen so far" is unsafe, it could drop a genuinely
// new failure that happens to arrive out of turn. Dedup instead by the
// failing query's own key, in enqueue() below — that's correct regardless of
// line order, since it's keyed by content and by when *we* process it, not
// by what the log claims its timestamp is. Reprocessing the same historical
// backlog on every reconnect costs a cheap regex pass, nothing more.
function handleLine(line) {
  const m = FAILURE_RE.exec(line);
  if (!m) return;
  const vars = parseFailureVars(m[1]);
  if (!vars) return;
  console.log(`[watch-and-warm] saw failure for ${keyFor(vars)} — queuing rewarm`);
  enqueue(vars);
}

let currentChild = null;

function startTail() {
  console.log("[watch-and-warm] tailing beamup-cli logs…");
  const child = spawn("npx", ["beamup-cli", "logs"], { stdio: ["ignore", "pipe", "pipe"] });
  currentChild = child;

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop(); // keep the last, possibly-incomplete line
    for (const line of lines) handleLine(line);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code) => {
    console.log(`[watch-and-warm] beamup-cli logs exited (${code}) — reconnecting in 5s`);
    setTimeout(startTail, 5000);
  });
}

startTail();

function shutdown() {
  if (currentChild) currentChild.kill();
  console.log(
    `[watch-and-warm] stopping — warmed ${summary.warmed}, failed ${summary.failed}` +
      ` (${lastWarmed.size} distinct quer${lastWarmed.size === 1 ? "y" : "ies"} seen)`,
  );
  process.exit(0);
}

// SIGINT (Ctrl+C) and SIGTERM (plain `kill`/`pkill`, no -9) both need to print
// the summary — a bare pkill sends SIGTERM, not SIGINT.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
