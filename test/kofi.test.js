"use strict";

const assert = require("node:assert/strict");
const { test, describe, before, after, beforeEach } = require("node:test");
const http = require("node:http");

const TOKEN = "11111111-2222-3333-4444-555555555555";
process.env.KOFI_VERIFICATION_TOKEN = TOKEN;
process.env.KOFI_URL = "https://ko-fi.com/omnicatalogs";

const sent = [];
const mailerPath = require.resolve("../src/infra/mailer");
require.cache[mailerPath] = {
  id: mailerPath,
  filename: mailerPath,
  loaded: true,
  exports: { sendMagicLink: async (email, link) => void sent.push({ email, link }) },
};

const handler = require("../src/index");
const { setStore, createMemoryStore } = require("../src/infra/userStore");
const kofi = require("../src/domain/kofi");

const DAY = 24 * 60 * 60 * 1000;
const MONTH_AND_GRACE = kofi.BILLING_PERIOD_MS + kofi.GRACE_MS;

let server;
let base;
let store;
before(async () => {
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  setStore(null);
});
beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

function call(method, path, { body, raw, contentType, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? null : JSON.stringify(body));
    const r = http.request(
      base + path,
      {
        method,
        headers: {
          ...(payload ? { "Content-Type": contentType || "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
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
    r.end(payload);
  });
}

// What Ko-fi sends: form-encoded, one `data` field holding the JSON.
function deliver(fields) {
  const payment = {
    verification_token: TOKEN,
    message_id: `msg-${Math.random()}`,
    timestamp: new Date().toISOString(),
    type: "Subscription",
    is_public: true,
    from_name: "Jo",
    message: null,
    amount: "1.00",
    url: "https://ko-fi.com/Home/CoffeeShop?txid=x",
    email: "jo@example.com",
    currency: "EUR",
    is_subscription_payment: true,
    is_first_subscription_payment: true,
    kofi_transaction_id: `tx-${Math.random()}`,
    shop_items: null,
    tier_name: "Plus",
    shipping: null,
    ...fields,
  };
  return call("POST", "/api/kofi/webhook", {
    raw: new URLSearchParams({ data: JSON.stringify(payment) }).toString(),
    contentType: "application/x-www-form-urlencoded",
  });
}

let clientSeq = 0;
async function signIn(email) {
  sent.length = 0;
  const headers = { "X-Forwarded-For": `10.7.0.${++clientSeq}` };
  assert.equal((await call("POST", "/api/auth/request", { body: { email }, headers })).status, 200);
  const token = sent.at(-1).link.split("#login=")[1];
  const v = await call("POST", "/api/auth/verify", { body: { token }, headers });
  assert.equal(v.status, 200);
  return { cookie: v.headers["set-cookie"][0].split(";")[0], me: v.json.me };
}

describe("Ko-fi webhook", () => {
  test("a membership payment gives the account its tier for a month plus grace", async () => {
    await store.createUser({ email: "jo@example.com" });
    const paidAt = Date.now() - DAY;
    const r = await deliver({ tier_name: "Pro", timestamp: new Date(paidAt).toISOString() });
    assert.equal(r.status, 200);
    const user = await store.findByEmail("jo@example.com");
    assert.equal(user.plan, "pro");
    assert.equal(user.planExpiresAt.getTime(), paidAt + MONTH_AND_GRACE);
  });

  test("the tier name and email are matched loosely", async () => {
    await store.createUser({ email: "jo@example.com" });
    await deliver({ tier_name: "  plus ", email: "  Jo@Example.COM " });
    assert.equal((await store.findByEmail("jo@example.com")).plan, "plus");
  });

  test("a payer who never signed in gets an account with the plan waiting", async () => {
    await deliver({ email: "new@example.com" });
    const { me } = await signIn("new@example.com");
    assert.equal(me.plan, "plus");
  });

  test("a renewal extends from its own payment date", async () => {
    await store.createUser({ email: "jo@example.com" });
    const first = Date.now() - 30 * DAY;
    await deliver({ timestamp: new Date(first).toISOString() });
    const renewal = Date.now();
    await deliver({ timestamp: new Date(renewal).toISOString(), is_first_subscription_payment: false });
    const user = await store.findByEmail("jo@example.com");
    assert.equal(user.planExpiresAt.getTime(), renewal + MONTH_AND_GRACE);
  });

  test("a repeated or late delivery of an older payment doesn't shorten the plan", async () => {
    await store.createUser({ email: "jo@example.com" });
    await deliver({ timestamp: new Date().toISOString() });
    const before = (await store.findByEmail("jo@example.com")).planExpiresAt.getTime();
    await deliver({ timestamp: new Date(Date.now() - 20 * DAY).toISOString() });
    assert.equal((await store.findByEmail("jo@example.com")).planExpiresAt.getTime(), before);
  });

  test("a timestamp in the future is not trusted", async () => {
    await store.createUser({ email: "jo@example.com" });
    await deliver({ timestamp: new Date(Date.now() + 365 * DAY).toISOString() });
    const expires = (await store.findByEmail("jo@example.com")).planExpiresAt.getTime();
    assert.ok(expires <= Date.now() + MONTH_AND_GRACE);
  });

  test("changing tier applies the new one", async () => {
    await store.createUser({ email: "jo@example.com" });
    await deliver({ tier_name: "Plus" });
    await deliver({ tier_name: "Pro" });
    assert.equal((await store.findByEmail("jo@example.com")).plan, "pro");
  });

  test("a wrong verification token is refused and changes nothing", async () => {
    await store.createUser({ email: "jo@example.com" });
    const r = await deliver({ verification_token: "not-the-token", tier_name: "Pro" });
    assert.equal(r.status, 401);
    const missing = await deliver({ verification_token: undefined, tier_name: "Pro" });
    assert.equal(missing.status, 401);
    assert.equal((await store.findByEmail("jo@example.com")).plan, "free");
  });

  test("donations, shop orders and unknown tiers are acknowledged but grant nothing", async () => {
    await store.createUser({ email: "jo@example.com" });
    for (const fields of [
      { type: "Donation", tier_name: null },
      { type: "Shop Order", tier_name: null },
      { tier_name: "Gold" },
      { email: "not an email" },
    ]) {
      assert.equal((await deliver(fields)).status, 200);
    }
    assert.equal((await store.findByEmail("jo@example.com")).plan, "free");
  });

  test("a malformed body is a 400", async () => {
    const r = await call("POST", "/api/kofi/webhook", {
      raw: "data=%7Bnot-json",
      contentType: "application/x-www-form-urlencoded",
    });
    assert.equal(r.status, 400);
    assert.equal((await call("GET", "/api/kofi/webhook")).status, 405);
  });

  test("the database down answers 503 so Ko-fi retries", async () => {
    store.findByEmail = async () => {
      throw new Error("db down");
    };
    assert.equal((await deliver({})).status, 503);
  });

  test("an account served through its install URL sees the new plan at once", async () => {
    const { cookie } = await signIn("jo@example.com");
    const uid = (await store.findByEmail("jo@example.com")).uid;
    await call("GET", `/api/${uid}/manifest.json`); // caches the account as free
    await deliver({ tier_name: "Pro" });
    const accounts = require("../src/domain/accounts");
    assert.equal((await accounts.getAccountByUid(uid)).plan.id, "pro");
    assert.equal((await call("GET", "/api/me", { cookie })).json.plan, "pro");
  });
});

describe("subscription page data", () => {
  test("the account says where to pay and what each plan costs", async () => {
    const { me } = await signIn("page@example.com");
    assert.deepEqual(me.billing, { provider: "kofi", url: "https://ko-fi.com/omnicatalogs" });
    const prices = Object.fromEntries(me.plans.map((p) => [p.id, p.price]));
    assert.deepEqual(prices, {
      free: null,
      plus: { amount: 100, currency: "eur" },
      pro: { amount: 200, currency: "eur" },
    });
  });

  test("without Ko-fi configured, there's no billing and the webhook is off", async () => {
    const saved = process.env.KOFI_VERIFICATION_TOKEN;
    delete process.env.KOFI_VERIFICATION_TOKEN;
    try {
      const { me } = await signIn("off@example.com");
      assert.equal(me.billing, null);
      assert.equal((await deliver({})).status, 404);
    } finally {
      process.env.KOFI_VERIFICATION_TOKEN = saved;
    }
  });
});
