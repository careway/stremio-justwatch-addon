'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const { decodeConfig, encodeConfig } = require('./config');
const { buildManifest }             = require('./manifest');
const { handleCatalog }             = require('./catalog');
const { handleStream }              = require('./stream');
const { getPackages }               = require('./justwatch');

const PORT           = Number(process.env.PORT) || 7000;
const CONFIGURE_HTML = fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8');

// ─── Response helpers ─────────────────────────────────────────────────────────

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

function respondHtml(res, html) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function parseExtra(raw) {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split('&')
      .filter((p) => p.includes('='))
      .map((pair) => {
        const eq = pair.indexOf('=');
        return [decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1))];
      })
  );
}

function getAddonBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host  = req.headers['x-forwarded-host'] || req.headers['host'] || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function router(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }

  const rawPath  = req.url.replace(/\?.*$/, '').replace(/\/$/, '');
  const qs       = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : new URLSearchParams();

  // ── /configure  (config UI) ──────────────────────────────────────────────────
  if (rawPath === '' || rawPath === '/configure') {
    return respondHtml(res, CONFIGURE_HTML);
  }

  // ── /manifest.json  (redirect to configure) ──────────────────────────────────
  if (rawPath === '/manifest.json') {
    return redirect(res, '/configure');
  }

  // ── /api/packages?country=XX ─────────────────────────────────────────────────
  if (rawPath === '/api/packages') {
    const country = (qs.get('country') || 'US').toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(country)) {
      return respond(res, { error: 'Invalid country code' }, 400);
    }
    try {
      return respond(res, await getPackages(country));
    } catch (err) {
      console.error('[api/packages] Error:', err.message);
      return respond(res, []);
    }
  }

  // ── /{config}/* ───────────────────────────────────────────────────────────────
  // Config segment is base64url: [A-Za-z0-9_-]+
  const configMatch = rawPath.match(/^\/([A-Za-z0-9_-]+)\/(.*)/);
  if (!configMatch) {
    return respond(res, { error: 'Not found' }, 404);
  }

  const [, encodedConfig, rest] = configMatch;
  const config = decodeConfig(encodedConfig);
  if (!config) {
    return respond(res, { error: 'Invalid configuration' }, 400);
  }

  // /{config}/manifest.json
  if (rest === 'manifest.json') {
    let pkgInfoMap = {};
    try {
      const pkgs = await getPackages(config.country);
      pkgInfoMap = Object.fromEntries(pkgs.map((p) => [p.technicalName, p]));
    } catch (e) {
      console.error('[manifest] Could not fetch packages:', e.message);
    }
    return respond(res, buildManifest(config, encodedConfig, pkgInfoMap, getAddonBaseUrl(req)));
  }

  // /{config}/catalog/{type}/{id}[/{extra}].json
  const catalogRx = /^catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/;
  const cm        = rest.match(catalogRx);
  if (cm) {
    const [, type, id, extraRaw] = cm;
    return respond(res, await handleCatalog({ type, id, extra: parseExtra(extraRaw) }, config));
  }

  // /{config}/stream/{type}/{id}.json
  const streamRx = /^stream\/([^/]+)\/(.+?)\.json$/;
  const sm       = rest.match(streamRx);
  if (sm) {
    const [, type, id] = sm;
    return respond(res, await handleStream({ type, id: decodeURIComponent(id) }, config));
  }

  return respond(res, { error: 'Not found' }, 404);
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
    console.log(`
╔══════════════════════════════════════════╗
║       Stremio JustWatch Addon            ║
╠══════════════════════════════════════════╣
║  Puerto      : ${String(PORT).padEnd(26)}║
╠══════════════════════════════════════════╣
║  Configurar → http://127.0.0.1:${PORT}/configure
╚══════════════════════════════════════════╝
`);
  });
