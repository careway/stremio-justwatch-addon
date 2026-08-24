"use strict";

function respond(
  res,
  data,
  status = 200,
  cacheControl = "max-age=300, stale-while-revalidate=600",
) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": cacheControl,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function respondHtml(res, html) {
  const buf = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": buf.length,
    // /configure carries per-user state in its query string (?config=...).
    // With no Cache-Control at all, an intermediary in front of the app
    // (BeamUp's nginx, a CDN) is free to cache it by exact URL with its own
    // default TTL — observed in production: a stale pre-poster-provider
    // page kept being served for one specific ?config= URL, while other
    // query variants hit the app fresh. This page must never be cached by
    // a shared cache regardless of the platform's default.
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

module.exports = { respond, respondHtml, redirect };
