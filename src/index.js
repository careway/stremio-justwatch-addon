"use strict";
const http = require("http");

const { router } = require("./http/router");
const { log, logError, LOG_FILE, rawConsoleLog } = require("./http/logger");
const { respond } = require("./http/responses");
const { PORT } = require("./http/request");
const stats = require("./infra/stats");
const warmCache = require("./infra/warmCache");
const justwatch = require("./infra/justwatch");
const { L1Cache } = require("./infra/cache");

// Hot cache warming. Runs on any host that mounts this handler (BeamUp calls
// the export directly, so this can't wait for the local-dev block below). A
// no-op when DATABASE_URL is unset; never throws out here.
warmCache
  .start({
    L1Cache,
    refetch: justwatch._warmRefetch,
    breaker: justwatch.breaker,
  })
  .catch((err) => logError("[warmCache] start error:", err.stack || err.message));

// ─── Handler (exported so any Node host can mount it) ──────────────────────

async function handler(req, res) {
  const start = Date.now();
  try {
    await router(req, res);
    stats.bump(`responses.${res.statusCode}`);
    log(
      `${req.method} ${req.url} → ${res.statusCode} (${Date.now() - start}ms)`,
    );
  } catch (err) {
    logError(
      `[server] Unhandled error on ${req.method} ${req.url}:`,
      err.stack || err.message,
    );
    stats.bump("responses.500");
    if (!res.headersSent) respond(res, { error: "Internal server error" }, 500);
  }
}

module.exports = handler;

// ─── Local dev server ─────────────────────────────────────────────────────────

if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    log(`Addon listening on port ${PORT} — log: ${LOG_FILE}`);
    rawConsoleLog(`
╔══════════════════════════════════════════╗
║       Stremio JustWatch Addon            ║
╠══════════════════════════════════════════╣
║  Puerto      : ${String(PORT).padEnd(26)}║
╠══════════════════════════════════════════╣
║  Configurar → http://127.0.0.1:${PORT}/configure
║  Log         : addon.log
╚══════════════════════════════════════════╝
`);
  });
}
