/** Fixed-window-with-sliding-estimate limiter. Store is pluggable (in-memory here; Redis later if the API scales out). */
export interface RateLimitStore {
  /** Increments the counter for `key` in the window `windowStart` and returns the new count. */
  incr(key: string, windowStart: number, ttlMs: number): Promise<number>;
  get(key: string, windowStart: number): Promise<number>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  #m = new Map<string, { n: number; expires: number }>();
  #sweep(now: number) {
    if (this.#m.size < 10_000) return;
    for (const [k, v] of this.#m) if (v.expires < now) this.#m.delete(k);
  }
  async incr(key: string, windowStart: number, ttlMs: number) {
    const k = `${key}:${windowStart}`;
    const now = Date.now();
    this.#sweep(now);
    const e = this.#m.get(k) ?? { n: 0, expires: windowStart + ttlMs * 2 };
    e.n += 1;
    this.#m.set(k, e);
    return e.n;
  }
  async get(key: string, windowStart: number) {
    return this.#m.get(`${key}:${windowStart}`)?.n ?? 0;
  }
}

export interface RateLimitResult { allowed: boolean; limit: number; remaining: number; retryAfterSeconds: number }

export class RateLimiter {
  constructor(private readonly store: RateLimitStore, private readonly windowMs = 60_000) {}
  /** Sliding-window estimate: current window count + previous window count weighted by overlap. */
  async hit(key: string, limit: number, now = Date.now()): Promise<RateLimitResult> {
    const w = this.windowMs;
    const cur = now - (now % w);
    const prev = cur - w;
    const prevCount = await this.store.get(key, prev);
    const curCount = await this.store.incr(key, cur, w);
    const weight = (w - (now - cur)) / w;
    const est = curCount + prevCount * weight;
    const allowed = est <= limit;
    return { allowed, limit, remaining: Math.max(0, Math.floor(limit - est)), retryAfterSeconds: allowed ? 0 : Math.ceil((cur + w - now) / 1000) };
  }
}
