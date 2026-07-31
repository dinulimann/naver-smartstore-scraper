import { config, ProxyConfig } from './config';

export class ProxyManager {
  private pool: ProxyConfig[];
  private cursor = 0;

  // Empty pool is allowed on purpose: direct connections (no proxy) turned
  // out to be a legitimate, sometimes-preferable mode, not just a config
  // error — a residential/mobile IP with no proxy-pool history reached the
  // product page reliably where every exhausted commercial proxy pool
  // tested the same day didn't (see README hypothesis row 45). `next()`
  // returns `undefined` for an empty pool, and callers treat that as "no
  // proxy" rather than a fallback needing a default.
  constructor(pool: ProxyConfig[] = config.proxies) {
    this.pool = pool;
  }

  /** Round-robin selection — spreads load evenly across the pool. undefined = direct connection. */
  next(): ProxyConfig | undefined {
    if (this.pool.length === 0) return undefined;
    const proxy = this.pool[this.cursor % this.pool.length];
    this.cursor++;
    return proxy;
  }

  /** Random selection — use when you want less predictable proxy ordering. */
  random(): ProxyConfig | undefined {
    if (this.pool.length === 0) return undefined;
    return this.pool[Math.floor(Math.random() * this.pool.length)];
  }

  size(): number {
    return this.pool.length;
  }
}
