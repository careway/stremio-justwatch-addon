"use strict";

// Accounts persistence. Two implementations of one interface: Postgres for
// real, and an in-memory one so the auth/plan logic (domain/accounts) can be
// tested without a database — the repo has no DB tests, because the other
// pools are skipped under NODE_ENV=test.
//
// Unlike warmCache/visitors, which are optimisations that degrade to "off",
// accounts are load-bearing: a request for an account URL with the database
// down must fail loudly (503) rather than pretend the account doesn't exist
// (404, which Stremio may cache and act on). So getStore() distinguishes:
//   null   → not configured at all (no DATABASE_URL): the account routes 404
//            and only the anonymous /{config} flow is served
//   throws → configured but unreachable: callers answer 503

const crypto = require("crypto");

const newUid = () => crypto.randomBytes(16).toString("base64url"); // 22 chars
const newId = () => crypto.randomUUID();

const asDate = (v) => (v ? new Date(v) : null);

// ─── In-memory ───────────────────────────────────────────────────────────────

function createMemoryStore({ now = () => Date.now() } = {}) {
  const users = new Map(); // id -> user
  const configs = new Map(); // userId -> config
  const links = new Map(); // tokenHash -> { email, expiresAt, used }
  const sessions = new Map(); // tokenHash -> { userId, expiresAt }
  const usage = new Map(); // `${userId}|${day}` -> n

  const clone = (u) => (u ? { ...u } : null);
  const find = (pred) => clone([...users.values()].find(pred));

  return {
    kind: "memory",
    async createUser({ email }) {
      const user = {
        id: newId(),
        email,
        uid: newUid(),
        plan: "free",
        planExpiresAt: null,
        createdAt: new Date(now()),
      };
      users.set(user.id, user);
      return clone(user);
    },
    async findByEmail(email) {
      return find((u) => u.email === email);
    },
    async findByUid(uid) {
      return find((u) => u.uid === uid);
    },
    async findById(id) {
      return clone(users.get(id));
    },
    async getConfig(userId) {
      const c = configs.get(userId);
      return c ? structuredClone(c) : null;
    },
    async setConfig(userId, config) {
      configs.set(userId, structuredClone(config));
    },
    async rotateUid(userId) {
      const user = users.get(userId);
      if (!user) return null;
      user.uid = newUid();
      return user.uid;
    },
    async setPlan(userId, plan, planExpiresAt = null) {
      const user = users.get(userId);
      if (user) {
        user.plan = plan;
        user.planExpiresAt = asDate(planExpiresAt);
      }
    },
    async deleteUser(userId) {
      users.delete(userId);
      configs.delete(userId);
      for (const [hash, s] of sessions) if (s.userId === userId) sessions.delete(hash);
    },
    async createMagicLink({ tokenHash, email, expiresAt }) {
      links.set(tokenHash, { email, expiresAt: asDate(expiresAt).getTime(), used: false });
    },
    async consumeMagicLink(tokenHash) {
      const link = links.get(tokenHash);
      if (!link || link.used || link.expiresAt <= now()) return null;
      link.used = true; // single use, decided in one synchronous step
      return link.email;
    },
    async createSession({ tokenHash, userId, expiresAt }) {
      sessions.set(tokenHash, { userId, expiresAt: asDate(expiresAt).getTime() });
    },
    async findSessionUser(tokenHash) {
      const s = sessions.get(tokenHash);
      if (!s || s.expiresAt <= now()) return null;
      return clone(users.get(s.userId));
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async addUsage(userId, day, n) {
      const key = `${userId}|${day}`;
      usage.set(key, (usage.get(key) || 0) + n);
    },
    // Test-only visibility.
    _usage: usage,
  };
}

// ─── Postgres ────────────────────────────────────────────────────────────────

const rowToUser = (r) =>
  r && {
    id: r.id,
    email: r.email,
    uid: r.uid,
    plan: r.plan,
    planExpiresAt: r.plan_expires_at,
    createdAt: r.created_at,
  };

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                 uuid PRIMARY KEY,
      email              text NOT NULL,
      uid                text NOT NULL,
      plan               text NOT NULL DEFAULT 'free',
      plan_expires_at    timestamptz,
      stripe_customer_id text,
      created_at         timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_uid_key ON users (uid)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_config (
      user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      config     jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS magic_links (
      token_hash text PRIMARY KEY,
      email      text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at    timestamptz
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day              date NOT NULL,
      catalog_requests bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    )`);
}

function createPgStore(pool) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  return {
    kind: "pg",
    async createUser({ email }) {
      const r = await one(
        `INSERT INTO users (id, email, uid) VALUES ($1, $2, $3) RETURNING *`,
        [newId(), email, newUid()],
      );
      return rowToUser(r);
    },
    async findByEmail(email) {
      return rowToUser(await one(`SELECT * FROM users WHERE email = $1`, [email]));
    },
    async findByUid(uid) {
      return rowToUser(await one(`SELECT * FROM users WHERE uid = $1`, [uid]));
    },
    async findById(id) {
      return rowToUser(await one(`SELECT * FROM users WHERE id = $1`, [id]));
    },
    async getConfig(userId) {
      const r = await one(`SELECT config FROM user_config WHERE user_id = $1`, [userId]);
      return r ? r.config : null;
    },
    async setConfig(userId, config) {
      await pool.query(
        `INSERT INTO user_config (user_id, config) VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [userId, JSON.stringify(config)],
      );
    },
    async rotateUid(userId) {
      const r = await one(`UPDATE users SET uid = $2 WHERE id = $1 RETURNING uid`, [
        userId,
        newUid(),
      ]);
      return r ? r.uid : null;
    },
    async setPlan(userId, plan, planExpiresAt = null) {
      await pool.query(`UPDATE users SET plan = $2, plan_expires_at = $3 WHERE id = $1`, [
        userId,
        plan,
        planExpiresAt,
      ]);
    },
    async deleteUser(userId) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    },
    async createMagicLink({ tokenHash, email, expiresAt }) {
      await pool.query(`DELETE FROM magic_links WHERE expires_at < now() - interval '1 day'`);
      await pool.query(
        `INSERT INTO magic_links (token_hash, email, expires_at) VALUES ($1, $2, $3)`,
        [tokenHash, email, expiresAt],
      );
    },
    async consumeMagicLink(tokenHash) {
      // One statement: the row is claimed and read together, so two
      // simultaneous requests with the same token can't both succeed.
      const r = await one(
        `UPDATE magic_links SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING email`,
        [tokenHash],
      );
      return r ? r.email : null;
    },
    async createSession({ tokenHash, userId, expiresAt }) {
      await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
      await pool.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
        [tokenHash, userId, expiresAt],
      );
    },
    async findSessionUser(tokenHash) {
      return rowToUser(
        await one(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1 AND s.expires_at > now()`,
          [tokenHash],
        ),
      );
    },
    async deleteSession(tokenHash) {
      await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
    },
    async addUsage(userId, day, n) {
      await pool.query(
        `INSERT INTO usage_daily (user_id, day, catalog_requests) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, day)
         DO UPDATE SET catalog_requests = usage_daily.catalog_requests + EXCLUDED.catalog_requests`,
        [userId, day, n],
      );
    },
  };
}

// ─── Singleton ───────────────────────────────────────────────────────────────

// Same connection-string handling as warmCache/visitors: TLS is forced by the
// `ssl` option, so sslmode in the URL would only trigger a pg warning.
function cleanConn(raw) {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("channel_binding");
    return u.toString();
  } catch {
    return raw;
  }
}

let injected = null; // tests and scripts
let pending = null; // memoised init: a Promise<store>
let failedAt = 0;
const RETRY_AFTER_MS = 15_000;

function setStore(store) {
  injected = store;
  pending = null;
}

async function initPg() {
  const conn = cleanConn(process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || "");
  const { Pool } = require("pg");
  // Neon is always TLS; a local Postgres (development, throwaway test
  // containers) usually doesn't speak it at all.
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(conn);
  const pool = new Pool({
    connectionString: conn,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: Number(process.env.ACCOUNTS_POOL_MAX || 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => console.warn("[userStore] idle client error:", err.message));
  await ensureSchema(pool);
  return createPgStore(pool);
}

/**
 * @returns {Promise<object|null>} the store, or null when accounts aren't
 *   configured. Rejects when they are configured but the database is down.
 */
async function getStore() {
  if (injected) return injected;
  const conn = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
  if (!conn || process.env.NODE_ENV === "test") return null;

  if (!pending) {
    if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) {
      throw new Error("accounts database unavailable");
    }
    pending = initPg().catch((err) => {
      failedAt = Date.now();
      pending = null;
      console.error("[userStore] init failed:", err.message);
      throw err;
    });
  }
  return pending;
}

module.exports = { getStore, setStore, createMemoryStore, createPgStore, ensureSchema, cleanConn, newUid };
