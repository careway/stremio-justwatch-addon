"use strict";

const assert = require("node:assert/strict");
const { test, describe, before, after } = require("node:test");
const http = require("node:http");

// Only the network edges are faked (JustWatch, email); everything between —
// router, cookies, plan limits, store logic — is the real code, against the
// in-memory store.
// The operator's own TMDb key exists in this process on purpose: an account
// must never end up using it (see the tmdb tests below).
const OPERATOR_KEY = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
process.env.TMDB_API_KEY = OPERATOR_KEY;

const sent = []; // { email, link }
const mailerPath = require.resolve("../src/infra/mailer");
require.cache[mailerPath] = {
  id: mailerPath,
  filename: mailerPath,
  loaded: true,
  exports: { sendMagicLink: async (email, link) => void sent.push({ email, link }) },
};

// TMDb, faked at fetch(); anything else goes to the real one (the test client
// itself uses http, so nothing else in this file depends on it).
const tmdbCalls = []; // full URLs
let tmdbAuth = "ok"; // "ok" | "rejected" | "down" — what /authentication answers
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.includes("api.themoviedb.org")) return realFetch(url, opts);
  tmdbCalls.push(u);
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (u.includes("/authentication")) {
    if (tmdbAuth === "down") throw new Error("network down");
    return tmdbAuth === "rejected" ? reply({}, 401) : reply({ success: true });
  }
  if (u.includes("/search/movie")) return reply({ results: [{ id: 77, title: "T" }] });
  if (u.includes("/external_ids")) return reply({ imdb_id: "tt7777777" });
  return reply({}, 404);
};

let jwHasImdb = true; // false → JustWatch hasn't linked an IMDb id yet
const searchCalls = [];
const jwPath = require.resolve("../src/infra/justwatch");
const realJw = require(jwPath);
require.cache[jwPath] = {
  id: jwPath,
  filename: jwPath,
  loaded: true,
  exports: {
    ...realJw,
    getPackages: async () => [{ shortName: "nfx", clearName: "Netflix" }],
    buildSearchKey: () => "k",
    searchTitles: async (args) => {
      searchCalls.push(args);
      return [
        {
          objectType: args.objectTypes?.[0] || "MOVIE",
          content: {
            title: "T",
            shortDescription: "",
            originalReleaseDate: "2000-01-01",
            genres: [],
            externalIds: { imdbId: jwHasImdb ? "tt0000001" : null },
            posterUrl: null,
          },
        },
      ];
    },
  },
};

const handler = require("../src/index");
const { setStore, createMemoryStore } = require("../src/infra/userStore");
const accounts = require("../src/domain/accounts");

let server;
let base;
before(async () => {
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function call(method, path, { body, cookie, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      base + path,
      {
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    r.on("error", reject);
    r.end(raw ?? payload);
  });
}

// Each simulated client gets its own address, as real clients behind the proxy
// do; otherwise every test would share 127.0.0.1's login throttle.
let clientSeq = 0;
const fromNewClient = () => ({ "X-Forwarded-For": `10.1.${Math.floor(clientSeq / 250)}.${(clientSeq++ % 250) + 1}` });

async function signIn(email = "a@example.com") {
  sent.length = 0;
  const headers = fromNewClient();
  const req = await call("POST", "/api/auth/request", { body: { email }, headers });
  assert.equal(req.status, 200, req.text);
  const token = sent.at(-1).link.split("#login=")[1];
  const v = await call("POST", "/api/auth/verify", { body: { token }, headers });
  assert.equal(v.status, 200, v.text);
  const cookie = v.headers["set-cookie"][0].split(";")[0];
  return { cookie, me: v.json.me };
}

const SPAIN = { country: "ES", language: "es", packages: ["nfx"], sorts: ["pop"] };

describe("accounts disabled (no database configured)", () => {
  test("account endpoints answer 404 and the anonymous flow is untouched", async () => {
    assert.equal((await call("GET", "/api/me")).status, 404);
    assert.equal((await call("POST", "/api/auth/request", { body: { email: "a@b.co" } })).status, 404);
    // A 22-char segment falls through to the legacy matcher, as before.
    const r = await call("GET", "/api/AbCdEfGhIjKlMnOpQrStUv/manifest.json");
    assert.equal(r.status, 400);
    assert.equal((await call("GET", "/ES_es_nfx/manifest.json")).status, 200);
  });
});

describe("accounts enabled", () => {
  before(() => setStore(createMemoryStore()));

  describe("login", () => {
    test("a link is mailed with the token in the fragment, never a query string", async () => {
      sent.length = 0;
      const r = await call("POST", "/api/auth/request", { body: { email: "Login@Example.com" }, headers: fromNewClient() });
      assert.equal(r.status, 200);
      assert.equal(sent[0].email, "login@example.com");
      assert.match(sent[0].link, /\/configure#login=[A-Za-z0-9_-]{40,}$/);
    });

    test("an invalid email is a 400", async () => {
      const headers = fromNewClient();
      assert.equal((await call("POST", "/api/auth/request", { body: { email: "nope" }, headers })).status, 400);
      assert.equal((await call("POST", "/api/auth/request", { body: {}, headers })).status, 400);
    });

    test("the token signs in once and sets an HttpOnly SameSite cookie", async () => {
      sent.length = 0;
      const headers = fromNewClient();
      await call("POST", "/api/auth/request", { body: { email: "once@example.com" }, headers });
      const token = sent[0].link.split("#login=")[1];

      const first = await call("POST", "/api/auth/verify", { body: { token }, headers });
      assert.equal(first.status, 200);
      const cookie = first.headers["set-cookie"][0];
      assert.match(cookie, /^oc_session=[A-Za-z0-9_-]+/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.doesNotMatch(cookie, /Secure/, "plain http in this test");

      const second = await call("POST", "/api/auth/verify", { body: { token }, headers });
      assert.equal(second.status, 401, "a used link must not work again");
    });

    test("a made-up token is refused", async () => {
      assert.equal((await call("POST", "/api/auth/verify", { body: { token: "x".repeat(43) }, headers: fromNewClient() })).status, 401);
    });

    test("the same email signs into the same account", async () => {
      const a = await signIn("same@example.com");
      const b = await signIn("same@example.com");
      assert.equal(a.me.uid, b.me.uid);
    });

    test("requests are throttled per email", async () => {
      const codes = [];
      for (let i = 0; i < 5; i++) {
        // Different addresses each time: only the per-email limit can trip.
        codes.push((await call("POST", "/api/auth/request", { body: { email: "flood@example.com" }, headers: fromNewClient() })).status);
      }
      assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
      assert.equal(codes[4], 429);
    });

    test("requests are throttled per address, whatever the email", async () => {
      const headers = { "X-Forwarded-For": "10.9.9.9" };
      const codes = [];
      for (let i = 0; i < 7; i++) {
        codes.push((await call("POST", "/api/auth/request", { body: { email: `n${i}@example.com` }, headers })).status);
      }
      assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
      assert.equal(codes[6], 429);
    });

    test("logout ends the session", async () => {
      const { cookie } = await signIn("bye@example.com");
      assert.equal((await call("GET", "/api/me", { cookie })).status, 200);
      const out = await call("POST", "/api/auth/logout", { cookie, body: {} });
      assert.equal(out.status, 200);
      assert.equal((await call("GET", "/api/me", { cookie })).status, 401);
    });
  });

  describe("request hygiene", () => {
    test("no session → 401", async () => {
      assert.equal((await call("GET", "/api/me")).status, 401);
      assert.equal((await call("PUT", "/api/me/config", { body: {} })).status, 401);
    });

    test("a write must be JSON (the CSRF gate)", async () => {
      const r = await call("POST", "/api/auth/request", {
        raw: "email=a@b.co",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      assert.equal(r.status, 415);
    });

    test("a write from another origin is refused", async () => {
      const r = await call("POST", "/api/auth/request", {
        body: { email: "a@b.co" },
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(r.status, 403);
    });

    test("oversized and malformed bodies are refused", async () => {
      assert.equal((await call("POST", "/api/auth/request", { raw: "{nope", headers: { "Content-Type": "application/json" } })).status, 400);
      const big = await call("POST", "/api/auth/request", {
        raw: JSON.stringify({ email: "a@b.co", pad: "x".repeat(10_000) }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(big.status, 413);
    });

    test("account endpoints don't advertise open CORS or cacheability", async () => {
      const r = await call("GET", "/api/me");
      assert.equal(r.headers["access-control-allow-origin"], undefined);
      assert.equal(r.headers["cache-control"], "no-store");
    });

    test("the wrong method is a 405 naming the right one", async () => {
      const { cookie } = await signIn("m@example.com");
      const r = await call("GET", "/api/me/config", { cookie });
      assert.equal(r.status, 405);
      assert.match(r.headers.allow, /PUT/);
    });
  });

  describe("configuration and the plan", () => {
    test("saving returns the profile with a stremio:// install URL", async () => {
      const { cookie, me } = await signIn("cfg@example.com");
      const r = await call("PUT", "/api/me/config", { cookie, body: { sources: [SPAIN] } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.plan, "free");
      assert.equal(r.json.installUrl, `stremio://127.0.0.1:${server.address().port}/api/${me.uid}/manifest.json`);
      assert.deepEqual(r.json.config.sources[0].packages, ["nfx"]);
    });

    test("a config beyond the plan is a 400 with a stable code", async () => {
      const { cookie } = await signIn("cap@example.com");
      const three = { sources: [SPAIN, { ...SPAIN, country: "MY", language: "en" }, { ...SPAIN, country: "US", language: "en" }] };
      const r = await call("PUT", "/api/me/config", { cookie, body: three });
      assert.equal(r.status, 400);
      assert.equal(r.json.code, "plan_countries");
    });

    test("free holds two selections in ONE install URL", async () => {
      const { cookie, me } = await signIn("two@example.com");
      const two = { sources: [SPAIN, { ...SPAIN, country: "MY", language: "en" }] };
      const r = await call("PUT", "/api/me/config", { cookie, body: two });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.limits.maxCountries, 2);
      const manifest = await call("GET", `/api/${me.uid}/manifest.json`);
      const ids = manifest.json.catalogs.map((c) => c.id);
      assert.ok(ids.some((i) => i.startsWith("ES_")) && ids.some((i) => i.startsWith("MY_")), "both selections' catalogs, one manifest");
      assert.equal(new Set(r.json.sources.map((s) => s.country)).size, 2);
    });
  });

  describe("the install URL — /api/{uid}", () => {
    let uid;
    let cookie;
    before(async () => {
      ({ cookie, me: { uid } } = await signIn("install@example.com"));
      const r = await call("PUT", "/api/me/config", { cookie, body: { sources: [SPAIN] } });
      assert.equal(r.status, 200, r.text);
    });

    test("serves a manifest with the account's catalogs", async () => {
      const r = await call("GET", `/api/${uid}/manifest.json`);
      assert.equal(r.status, 200);
      assert.equal(r.json.name, "OmniCatalogs · ES");
      assert.deepEqual(r.json.catalogs.map((c) => c.id), ["ES_es_jw_pop_nfx", "ES_es_jw_pop_nfx"]);
      assert.equal(r.json.catalogs[0].name, "Netflix · Popular · ES");
      assert.equal(r.headers["access-control-allow-origin"], "*", "Stremio needs CORS here");
    });

    test("an unknown uid is a 404, not a config error", async () => {
      const r = await call("GET", "/api/AbCdEfGhIjKlMnOpQrStUv/manifest.json");
      assert.equal(r.status, 404);
    });

    test("serves a declared catalog", async () => {
      const r = await call("GET", `/api/${uid}/catalog/movie/ES_es_jw_pop_nfx.json`);
      assert.equal(r.status, 200);
      assert.equal(r.json.metas[0].id, "tt0000001");
    });

    test("refuses a catalog the manifest doesn't declare — no reaching other countries by hand", async () => {
      searchCalls.length = 0;
      for (const id of ["MY_en_jw_pop_nfx", "ES_es_jw_tnd_nfx", "ES_es_jw_pop_dnp", "r_ES_es_jw_pop_nfx"]) {
        const r = await call("GET", `/api/${uid}/catalog/movie/${id}.json`);
        assert.equal(r.status, 404, id);
      }
      assert.equal(searchCalls.length, 0, "must not reach the upstream for these");
    });

    test("the plan's depth applies: the free plan stops after maxOffset", async () => {
      searchCalls.length = 0;
      const within = await call("GET", `/api/${uid}/catalog/movie/ES_es_jw_pop_nfx/skip=100.json`);
      assert.equal(within.json.metas.length > 0, true);
      searchCalls.length = 0;
      const beyond = await call("GET", `/api/${uid}/catalog/movie/ES_es_jw_pop_nfx/skip=150.json`);
      assert.deepEqual(beyond.json.metas, []);
      assert.equal(searchCalls.length, 0);
    });

    test("/configure sends the user to the configure page", async () => {
      const r = await call("GET", `/api/${uid}/configure`);
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, "/configure");
    });

    test("rotating the uid kills the old URL and the new one works", async () => {
      const { cookie: c2, me } = await signIn("rotate@example.com");
      await call("PUT", "/api/me/config", { cookie: c2, body: { sources: [SPAIN] } });
      const r = await call("POST", "/api/me/rotate-uid", { cookie: c2, body: {} });
      assert.equal(r.status, 200);
      assert.notEqual(r.json.uid, me.uid);
      assert.equal((await call("GET", `/api/${me.uid}/manifest.json`)).status, 404);
      assert.equal((await call("GET", `/api/${r.json.uid}/manifest.json`)).status, 200);
    });

    test("deleting the account deletes the install URL", async () => {
      const { cookie: c2, me } = await signIn("gone@example.com");
      await call("PUT", "/api/me/config", { cookie: c2, body: { sources: [SPAIN] } });
      assert.equal((await call("DELETE", "/api/me", { cookie: c2, body: {} })).status, 200);
      assert.equal((await call("GET", `/api/${me.uid}/manifest.json`)).status, 404);
    });
  });

  describe("building it one country at a time (the configure page's flow)", () => {
    test("the page's own config segment becomes a source, and the profile lists it", async () => {
      const { cookie } = await signIn("legacy@example.com");
      const r = await call("PUT", "/api/me/config", { cookie, body: { legacy: "ES_es_nfx_dnp" } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.config.sources[0].packages.sort(), ["dnp", "nfx"]);
      assert.equal(r.json.sources[0].country, "ES");
      assert.equal(r.json.sources[0].providers, 2);
      // "edit" is just the configure page pre-filled from this segment.
      assert.match(r.json.sources[0].legacy, /^ES_es_/);
    });

    test("saving a country again replaces it rather than duplicating it", async () => {
      const { cookie } = await signIn("replace@example.com");
      await call("PUT", "/api/me/config", { cookie, body: { legacy: "ES_es_nfx" } });
      const r = await call("PUT", "/api/me/config", { cookie, body: { legacy: "ES_es_dnp" } });
      assert.equal(r.json.config.sources.length, 1);
      assert.deepEqual(r.json.config.sources[0].packages, ["dnp"]);
    });

    test("a third selection needs a paid plan, and a merge keeps the others", async () => {
      const store = createMemoryStore();
      setStore(store);
      const { cookie, me } = await signIn("merge@example.com");
      await call("PUT", "/api/me/config", { cookie, body: { legacy: "ES_es_nfx" } });
      const second = await call("PUT", "/api/me/config", { cookie, body: { legacy: "MY_en_nfx" } });
      assert.equal(second.status, 200, "the second one is within free");
      assert.deepEqual(second.json.config.sources.map((s) => s.country), ["ES", "MY"]);

      const blocked = await call("PUT", "/api/me/config", { cookie, body: { legacy: "US_en_nfx" } });
      assert.equal(blocked.status, 400);
      assert.equal(blocked.json.code, "plan_countries");
      // ...but editing one you already have is not "adding" one.
      const edit = await call("PUT", "/api/me/config", { cookie, body: { legacy: "MY_en_dnp" } });
      assert.equal(edit.status, 200, edit.text);
      assert.deepEqual(edit.json.config.sources.map((s) => s.country), ["ES", "MY"]);

      await store.setPlan((await store.findByEmail("merge@example.com")).id, "plus", null);
      accounts.invalidate(me.uid);
      const ok = await call("PUT", "/api/me/config", { cookie, body: { legacy: "US_en_nfx" } });
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(ok.json.config.sources.map((s) => s.country), ["ES", "MY", "US"]);

      // merge:false starts over with just this country.
      const fresh = await call("PUT", "/api/me/config", { cookie, body: { legacy: "MY_en_nfx", merge: false } });
      assert.deepEqual(fresh.json.config.sources.map((s) => s.country), ["MY"]);
    });

    test("paid plans are unlimited: many selections, all in the one manifest", async () => {
      const store = createMemoryStore();
      setStore(store);
      const { cookie, me } = await signIn("many@example.com");
      await store.setPlan((await store.findByEmail("many@example.com")).id, "pro", null);
      accounts.invalidate(me.uid);
      for (const cc of ["ES", "MY", "US", "FR", "DE", "IT"]) {
        const r = await call("PUT", "/api/me/config", { cookie, body: { legacy: `${cc}_en_nfx` } });
        assert.equal(r.status, 200, `${cc}: ${r.text}`);
      }
      const profile = (await call("GET", "/api/me", { cookie })).json;
      assert.equal(profile.sources.length, 6);
      assert.equal(profile.limits.maxCountries, null, "null = unlimited");
      const manifest = await call("GET", `/api/${me.uid}/manifest.json`);
      assert.equal(new Set(manifest.json.catalogs.map((c) => c.id.slice(0, 2))).size, 6);
    });

    test("a country can be removed; removing one that isn't there is a 404", async () => {
      const store = createMemoryStore();
      setStore(store);
      const { cookie } = await signIn("remove@example.com");
      await call("PUT", "/api/me/config", { cookie, body: { legacy: "ES_es_nfx" } });
      await call("PUT", "/api/me/config", { cookie, body: { legacy: "MY_en_nfx" } });

      const r = await call("DELETE", "/api/me/sources/MY", { cookie, body: {} });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.config.sources.map((s) => s.country), ["ES"]);
      assert.equal((await call("DELETE", "/api/me/sources/MY", { cookie, body: {} })).status, 404);
    });

    test("garbage in the segment is a 400, not a stored config", async () => {
      const { cookie } = await signIn("garbage@example.com");
      for (const legacy of ["", "x", "1_2_3", 42]) {
        const r = await call("PUT", "/api/me/config", { cookie, body: { legacy } });
        assert.ok([400].includes(r.status), `${legacy} → ${r.status}`);
      }
    });

    test("the segment is checked against the plan like any other config", async () => {
      const { cookie } = await signIn("rnd@example.com");
      const r = await call("PUT", "/api/me/config", { cookie, body: { legacy: "ES_es_rnd_nfx" } });
      assert.equal(r.status, 400);
      assert.equal(r.json.code, "plan_feature");
    });
  });

  describe("the account's own TMDb key", () => {
    const KEY = "abcdef0123456789abcdef0123456789";
    const setKey = (cookie, key) => call("PUT", "/api/me/tmdb-key", { cookie, body: { key } });

    test("saving a key reports it as set, with a hint — and never echoes it back", async () => {
      tmdbAuth = "ok";
      const { cookie } = await signIn("k1@example.com");
      const r = await setKey(cookie, KEY);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.tmdbKey, { set: true, hint: "…6789" });
      assert.ok(!r.text.includes(KEY), "the full key must not come back");
      assert.ok(!(await call("GET", "/api/me", { cookie })).text.includes(KEY));
    });

    test("a malformed key is refused without asking TMDb", async () => {
      const { cookie } = await signIn("k2@example.com");
      tmdbCalls.length = 0;
      const r = await setKey(cookie, "not a key");
      assert.equal(r.status, 400);
      assert.equal(r.json.code, "invalid_tmdb_key");
      assert.equal(tmdbCalls.length, 0);
    });

    test("a key TMDb rejects is refused, so a typo is caught now", async () => {
      tmdbAuth = "rejected";
      const { cookie } = await signIn("k3@example.com");
      const r = await setKey(cookie, KEY);
      assert.equal(r.status, 400);
      assert.equal(r.json.code, "invalid_tmdb_key");
      assert.equal((await call("GET", "/api/me", { cookie })).json.tmdbKey.set, false);
      tmdbAuth = "ok";
    });

    test("if TMDb can't be reached the key is kept — that says nothing about the key", async () => {
      tmdbAuth = "down";
      const { cookie } = await signIn("k4@example.com");
      assert.equal((await setKey(cookie, KEY)).json.tmdbKey.set, true);
      tmdbAuth = "ok";
    });

    test("it can be cleared, and survives saving and removing countries", async () => {
      tmdbAuth = "ok";
      const store = createMemoryStore();
      setStore(store);
      const { cookie, me } = await signIn("k5@example.com");
      await store.setPlan((await store.findByEmail("k5@example.com")).id, "plus", null);
      accounts.invalidate(me.uid);

      await setKey(cookie, KEY);
      await call("PUT", "/api/me/config", { cookie, body: { legacy: "ES_es_nfx" } });
      await call("PUT", "/api/me/config", { cookie, body: { legacy: "MY_en_nfx" } });
      await call("PUT", "/api/me/config", { cookie, body: { legacy: "MY_en_dnp", merge: false } });
      await call("DELETE", "/api/me/sources/MY", { cookie, body: {} });
      assert.equal((await call("GET", "/api/me", { cookie })).json.tmdbKey.set, true, "still there");
      assert.equal(
        (await store.getConfig((await store.findByEmail("k5@example.com")).id)).tmdbApiKey,
        KEY,
      );

      const cleared = await setKey(cookie, null);
      assert.equal(cleared.json.tmdbKey.set, false);
    });

    test("a full-config write that doesn't mention the key keeps it", async () => {
      tmdbAuth = "ok";
      const { cookie } = await signIn("k6@example.com");
      await setKey(cookie, KEY);
      const r = await call("PUT", "/api/me/config", { cookie, body: { sources: [SPAIN] } });
      assert.equal(r.json.tmdbKey.set, true);
    });

    test("a title JustWatch hasn't linked is recovered with the account's key — not the operator's", async () => {
      tmdbAuth = "ok";
      const { cookie, me } = await signIn("k7@example.com");
      await call("PUT", "/api/me/config", { cookie, body: { sources: [SPAIN] } });
      await setKey(cookie, KEY);

      jwHasImdb = false;
      tmdbCalls.length = 0;
      try {
        const r = await call("GET", `/api/${me.uid}/catalog/movie/ES_es_jw_pop_nfx.json`);
        assert.deepEqual(r.json.metas.map((m) => m.id), ["tt7777777"]);
        const used = tmdbCalls.filter((u) => !u.includes("/authentication"));
        assert.ok(used.length > 0);
        assert.ok(used.every((u) => u.includes(`api_key=${KEY}`)), used.join("\n"));
        assert.ok(!used.some((u) => u.includes(OPERATOR_KEY)));
      } finally {
        jwHasImdb = true;
      }
    });

    test("an account with no key gets no fallback and never borrows the operator's", async () => {
      const { cookie, me } = await signIn("k8@example.com");
      await call("PUT", "/api/me/config", { cookie, body: { sources: [SPAIN] } });

      jwHasImdb = false;
      tmdbCalls.length = 0;
      try {
        const r = await call("GET", `/api/${me.uid}/catalog/series/ES_es_jw_pop_nfx.json`);
        assert.equal(r.status, 200);
        assert.ok(!r.json.metas.some((m) => m.id === "tt7777777"), "the unlinked title is simply dropped");
        assert.equal(tmdbCalls.length, 0, "no TMDb traffic at all, and certainly none on the operator's key");
      } finally {
        jwHasImdb = true;
      }
    });
  });

  describe("upgrading a plan", () => {
    test("more selections and deeper catalogs open up, and a downgrade shrinks without breaking", async () => {
      const store = createMemoryStore();
      setStore(store);
      const { cookie, me } = await signIn("plus@example.com");
      const three = { sources: [SPAIN, { ...SPAIN, country: "MY", language: "en" }, { ...SPAIN, country: "US", language: "en" }] };
      assert.equal((await call("PUT", "/api/me/config", { cookie, body: three })).status, 400);

      const user = await store.findByEmail("plus@example.com");
      await store.setPlan(user.id, "plus", null);
      accounts.invalidate(me.uid);
      const ok = await call("PUT", "/api/me/config", { cookie, body: three });
      assert.equal(ok.status, 200, ok.text);

      const manifest = await call("GET", `/api/${me.uid}/manifest.json`);
      const ids = manifest.json.catalogs.map((c) => c.id);
      assert.ok(["ES_", "MY_", "US_"].every((p) => ids.some((i) => i.startsWith(p))));

      const deep = await call("GET", `/api/${me.uid}/catalog/movie/ES_es_jw_pop_nfx/skip=150.json`);
      assert.equal(deep.json.metas.length > 0, true, "plus reaches beyond the free depth");

      // Plan lapses: the stored selections stay, the manifest just gets smaller.
      await store.setPlan(user.id, "plus", new Date(Date.now() - 1000));
      accounts.invalidate(me.uid);
      const lapsed = await call("GET", `/api/${me.uid}/manifest.json`);
      assert.equal(lapsed.status, 200);
      assert.deepEqual([...new Set(lapsed.json.catalogs.map((c) => c.id.slice(0, 2)))], ["ES", "MY"]);
    });
  });

  describe("per-account rate limit", () => {
    test("the free plan's burst runs out with a 429 and Retry-After", async () => {
      const { cookie, me } = await signIn("burst@example.com");
      await call("PUT", "/api/me/config", { cookie, body: { sources: [SPAIN] } });
      const statuses = [];
      let last;
      for (let i = 0; i < 125; i++) {
        last = await call("GET", `/api/${me.uid}/manifest.json`);
        statuses.push(last.status);
      }
      assert.equal(statuses[0], 200);
      assert.equal(statuses.at(-1), 429);
      assert.ok(Number(last.headers["retry-after"]) >= 1);
    });

    test("one account's traffic doesn't throttle another's", async () => {
      const { cookie, me } = await signIn("calm@example.com");
      await call("PUT", "/api/me/config", { cookie, body: { sources: [SPAIN] } });
      assert.equal((await call("GET", `/api/${me.uid}/manifest.json`)).status, 200);
    });
  });
});

describe("store outage", () => {
  test("a configured-but-down database answers 503, not 404", async () => {
    const broken = createMemoryStore();
    broken.findByUid = async () => {
      throw new Error("connection refused");
    };
    setStore(broken);
    const r = await call("GET", "/api/AbCdEfGhIjKlMnOpQrStUv/manifest.json");
    assert.equal(r.status, 503);
    assert.equal(r.headers["cache-control"], "no-store");
  });
});
