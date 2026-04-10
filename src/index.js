'use strict';

const http = require('http');
const manifest = require('./manifest');
const { handleCatalog } = require('./catalog');
const { handleStream } = require('./stream');

const PORT = Number(process.env.PORT) || 7000;

// ─── CORS + JSON response helper ─────────────────────────────────────────────
function respond(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'max-age=300, stale-while-revalidate=600',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ─── Parse Stremio extra params (key=value&key2=value2 embedded in path) ─────
function parseExtra(raw) {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split('&')
      .filter((p) => p.includes('='))
      .map((pair) => {
        const eq = pair.indexOf('=');
        return [
          decodeURIComponent(pair.slice(0, eq)),
          decodeURIComponent(pair.slice(eq + 1)),
        ];
      })
  );
}

// ─── Request router ───────────────────────────────────────────────────────────
async function router(req, res) {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }

  const path = req.url.replace(/\?.*$/, '').replace(/\/$/, '');

  // GET /manifest.json
  if (path === '/manifest.json') {
    return respond(res, manifest);
  }

  // GET /catalog/{type}/{id}.json  (no extra params)
  // GET /catalog/{type}/{id}/{extra}.json
  const catalogRx = /^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/;
  const cm = path.match(catalogRx);
  if (cm) {
    const [, type, id, extraRaw] = cm;
    const extra = parseExtra(extraRaw);
    const result = await handleCatalog({ type, id, extra });
    return respond(res, result);
  }

  // GET /stream/{type}/{id}.json
  const streamRx = /^\/stream\/([^/]+)\/(.+?)\.json$/;
  const sm = path.match(streamRx);
  if (sm) {
    const [, type, id] = sm;
    const result = await handleStream({ type, id: decodeURIComponent(id) });
    return respond(res, result);
  }

  respond(res, { error: 'Not found' }, 404);
}

// ─── Server ───────────────────────────────────────────────────────────────────
http
  .createServer(async (req, res) => {
    try {
      await router(req, res);
    } catch (err) {
      console.error('[server] Unhandled error:', err.message);
      if (!res.headersSent) respond(res, { error: 'Internal server error' }, 500);
    }
  })
  .listen(PORT, () => {
    const country = process.env.JUSTWATCH_COUNTRY || 'ES';
    console.log(`
╔══════════════════════════════════════════╗
║       Stremio JustWatch Addon            ║
╠══════════════════════════════════════════╣
║  Puerto  : ${String(PORT).padEnd(31)}║
║  País    : ${country.padEnd(31)}║
╠══════════════════════════════════════════╣
║  Instalar en Stremio (local):            ║
║  http://127.0.0.1:${String(PORT).padEnd(22)}║
║  /manifest.json                          ║
╚══════════════════════════════════════════╝
`);
  });
