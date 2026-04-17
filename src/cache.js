const { Redis } = require("@upstash/redis");
const { getCache } = require("@vercel/functions");
const { trackCacheHit, trackCacheMiss } = require("./analytics");

// L1 Global Memory: Declared outside so it survives "warm" serverless invocations
const _mem = new Map();
class L1 {
  constructor() {}

  async get(key) {
    const hit = _mem.get(key);
    if (hit) {
      // Check if it hasn't expired yet
      if (Date.now() <= hit.expiresAt) {
        return hit.data;
      }
      // Evict if expired
      _mem.delete(key);
    }
    return null;
  }

  async set(key, data, ttl_s) {
    const expiresAt = Date.now() + ttl_s * 1000;
    _mem.set(key, { data, expiresAt });
  }

  async invalidate(key) {
    _mem.delete(key);
  }
}

class L2 {
  constructor() {
    // Correctly assigned to class instance
    this._vercel = getCache();
  }

  async get(key) {
    if (this._vercel) {
      // Vercel getCache is async, must await it
      const data = await this._vercel.get(key);
      if (data) {
        console.log(`[cache] L2 Vercel hit — ${key}`);
        return data; // Returned as parsed object, no need to stringify
      }
    }
    return null;
  }

  async set(key, data, ttl_s, tag = "") {
    if (this._vercel) {
      // Replaced 'cache' with 'this._vercel'
      await this._vercel.set(key, data, {
        ttl: ttl_s,
        tags: tag ? [tag] : undefined,
      });
    }
  }

  async invalidate(key) {
    this._vercel.delete(key);
  }
}

// Global variable to hold the Redis connection across warm invocations
let _redisConnection = null;

class L3 {
  constructor() {
    // Only initialize the connection once to avoid exhausting connections
    if (!_redisConnection) {
      const url =
        process.env.REDIS_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
      const token =
        process.env.REDIS_KV_REST_API_TOKEN ||
        process.env.UPSTASH_REDIS_REST_TOKEN;

      if (url && token) {
        _redisConnection = new Redis({ url, token });
      }
    }
    // Bind the connection to the instance
    this._redis = _redisConnection;
  }

  async get(key) {
    if (this._redis) {
      try {
        const data = await this._redis.get(key);
        if (data !== null) {
          console.log(`[cache] L3 Redis hit — ${key}`);
          return data;
        }
      } catch (err) {
        console.error("[cache] Redis GET error:", err.message);
      }
    }
    return null;
  }

  async set(key, data, ttl_s) {
    if (this._redis) {
      try {
        await this._redis.set(key, data, { ex: ttl_s });
      } catch (err) {
        console.error("[cache] Redis SET error:", err.message);
      }
    }
  }

  async invalidate(key) {
    if (this._redis) this._redis.del(key);
  }
}

// ==========================================
// CREATE INSTANCES (SINGLETONS)
// ==========================================
const L1Cache = new L1();
const L2Cache = new L2();
const L3Cache = new L3();

// Export the instances directly
module.exports = { L1Cache, L2Cache, L3Cache };
