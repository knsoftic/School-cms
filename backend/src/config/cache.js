'use strict';

/**
 * Caching layer — SRS §25 "Caching".
 *
 * Namespaced TTL cache with two drivers:
 *   memory — default, per-process Map with lazy expiry and a periodic sweep
 *   redis  — used when CACHE_DRIVER=redis and REDIS_URL is set
 *
 * The Redis driver loads `redis` lazily so the package is only required when actually used;
 * if it is unavailable the cache degrades to the memory driver rather than failing the boot.
 */

const config = require('./env');
const logger = require('./logger');

/** @abstract */
class CacheDriver {
  /* eslint-disable no-unused-vars, class-methods-use-this */
  async get(key) { return undefined; }
  async set(key, value, ttlSeconds) {}
  async del(key) {}
  async delByPrefix(prefix) {}
  async flush() {}
  /* eslint-enable no-unused-vars, class-methods-use-this */
}

class MemoryCacheDriver extends CacheDriver {
  constructor() {
    super();
    /** @type {Map<string, {value: any, expiresAt: number}>} */
    this.store = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Structured clone keeps callers from mutating cached objects in place.
    return entry.value === undefined ? undefined : JSON.parse(entry.value);
  }

  async set(key, value, ttlSeconds) {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key) {
    this.store.delete(key);
  }

  async delByPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  async flush() {
    this.store.clear();
  }
}

class RedisCacheDriver extends CacheDriver {
  constructor(client) {
    super();
    this.client = client;
  }

  async get(key) {
    const raw = await this.client.get(key);
    return raw === null ? undefined : JSON.parse(raw);
  }

  async set(key, value, ttlSeconds) {
    await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  }

  async del(key) {
    await this.client.del(key);
  }

  async delByPrefix(prefix) {
    let cursor = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.client.scan(cursor, { MATCH: `${prefix}*`, COUNT: 500 });
      cursor = Number(res.cursor);
      if (res.keys.length) {
        // eslint-disable-next-line no-await-in-loop
        await this.client.del(res.keys);
      }
    } while (cursor !== 0);
  }

  async flush() {
    await this.client.flushDb();
  }
}

let driver = new MemoryCacheDriver();

/** Swap in Redis when configured. Safe to call once at boot. */
async function initCache() {
  if (config.cache.driver !== 'redis' || !config.cache.redisUrl) return;
  try {
    /*
     * `redis` is an OPTIONAL dependency and is not installed here — the driver defaults to
     * in-memory — so this require is deliberately lazy and deliberately unresolvable. The
     * disable used to name `import/no-unresolved` as well; that rule comes from
     * `eslint-plugin-import`, which is not a dependency, and ESLint errors on a disable comment
     * naming a rule it cannot find. Adding a plugin to satisfy a comment is the wrong direction.
     */
    // eslint-disable-next-line global-require
    const { createClient } = require('redis');
    const client = createClient({ url: config.cache.redisUrl });
    client.on('error', (err) => logger.error('Redis cache error', { error: err.message }));
    await client.connect();
    driver = new RedisCacheDriver(client);
    logger.info('Cache driver: redis');
  } catch (err) {
    logger.warn(`Redis cache unavailable (${err.message}); falling back to in-memory cache.`);
  }
}

const PREFIX = 'msms:';

/** Build a namespaced cache key from parts. */
function key(...parts) {
  return PREFIX + parts.filter((p) => p !== undefined && p !== null).join(':');
}

const cache = {
  key,

  async get(cacheKey) {
    try {
      return await driver.get(cacheKey);
    } catch (err) {
      logger.warn('Cache get failed', { key: cacheKey, error: err.message });
      return undefined;
    }
  },

  async set(cacheKey, value, ttlSeconds = config.cache.ttlSeconds) {
    try {
      await driver.set(cacheKey, value, ttlSeconds);
    } catch (err) {
      logger.warn('Cache set failed', { key: cacheKey, error: err.message });
    }
  },

  async del(cacheKey) {
    try {
      await driver.del(cacheKey);
    } catch (err) {
      logger.warn('Cache delete failed', { key: cacheKey, error: err.message });
    }
  },

  /** Invalidate a whole namespace, e.g. everything cached for one school. */
  async invalidate(...parts) {
    const prefix = key(...parts);
    try {
      await driver.delByPrefix(prefix);
    } catch (err) {
      logger.warn('Cache invalidate failed', { prefix, error: err.message });
    }
  },

  async flush() {
    await driver.flush();
  },

  /** Read-through helper: return the cached value or compute, store and return it. */
  async remember(cacheKey, ttlSeconds, producer) {
    const hit = await cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const value = await producer();
    if (value !== undefined) await cache.set(cacheKey, value, ttlSeconds);
    return value;
  },
};

module.exports = { cache, initCache };
