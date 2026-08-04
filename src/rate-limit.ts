// Volume control for the read surface.
//
// The allowlist decides WHICH sources a caller may name; this decides HOW MANY
// times. They are different failures: the allowlist stops a caller reading a repo
// it should not see, and a caller that is entirely within its rights can still
// exhaust the service by asking too often.
//
// WHAT IS ACTUALLY SCARCE here is not CPU — it is the upstream tarball fetch and
// the heap the resulting snapshot occupies. A cache hit is a map lookup and costs
// almost nothing; a miss downloads a whole repository. So the limits are priced
// per operation rather than per request: a generous bucket for requests in
// general, and a much meaner one for the requests that would prime. Limiting them
// at one flat rate would either throttle cheap traffic pointlessly or leave the
// expensive path wide open.
//
// THIS IS THE APPLICATION HALF of a two-layer defence, and it is deliberately not
// the only one. It is per-instance and has no view of who is calling, so it
// cannot shed a distributed flood or enforce a per-principal quota. The edge
// half — Cloud Run's ingress restriction, IAM invoker check and max-instances
// ceiling — is what bounds crude volume and total spend; see README.md. Neither
// layer alone is sufficient, which is why this exists even though the service is
// not publicly invocable.

/** What a limiter says about one request. */
export interface RateLimitVerdict {
  allowed: boolean;
  /** Whole seconds until the caller could reasonably succeed. Only meaningful
   * when `allowed` is false; sent as the `Retry-After` header so a client backs
   * off for a stated period instead of guessing or hot-looping. */
  retryAfterSeconds: number;
  /** Which budget ran out, for the response body and the operator's logs. */
  limit?: 'requests' | 'primes';
}

const ALLOWED: RateLimitVerdict = { allowed: true, retryAfterSeconds: 0 };

/**
 * A token bucket: `capacity` tokens, refilled at `refillPerSecond`, never more
 * than full.
 *
 * Chosen over a fixed window because the traffic this serves is bursty by
 * design — a lens fan opens with N near-simultaneous reads of the same snapshot
 * and then goes quiet. A fixed window would reject the burst it exists to serve;
 * a bucket absorbs it up to `capacity` and then paces the caller at the refill
 * rate, which is exactly the shape we want.
 *
 * Refill is computed from the clock on each check rather than by a timer, so an
 * idle bucket costs nothing and there is no interval to keep the process alive.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now
  ) {
    if (capacity <= 0) throw new Error('TokenBucket: capacity must be positive');
    if (refillPerSecond <= 0) throw new Error('TokenBucket: refillPerSecond must be positive');
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  /** Take one token if there is one. Returns whether it was taken, and how long
   * until the next token if it was not. */
  take(): { ok: boolean; retryAfterSeconds: number } {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true, retryAfterSeconds: 0 };
    }
    // Always at least a second: a Retry-After of 0 invites an immediate retry,
    // which is what we are trying to stop.
    const waitSeconds = (1 - this.tokens) / this.refillPerSecond;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitSeconds)) };
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = nowMs - this.lastRefillMs;
    // A clock that jumps backwards (NTP correction, container suspend) must not
    // credit tokens or freeze the bucket; treat it as no elapsed time.
    if (elapsedMs > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
    }
    this.lastRefillMs = nowMs;
  }

  /** Tokens available right now, for tests and for reporting. */
  get available(): number {
    this.refill();
    return this.tokens;
  }
}

export interface RateLimitOptions {
  /** Burst size for requests of any kind. */
  requestBurst?: number;
  /** Sustained requests per second once the burst is spent. */
  requestsPerSecond?: number;
  /** Burst size for requests that would cause an upstream prime. */
  primeBurst?: number;
  /** Sustained primes per second. Low on purpose — each one is a whole
   * repository downloaded and held in memory. */
  primesPerSecond?: number;
  /** Injectable clock, so the tests do not sleep. */
  now?: () => number;
}

// Sized for the workload this serves: a fan of lens agents, each reading tens of
// files from ONE snapshot. That is a burst of cheap reads (hence 200) against a
// handful of distinct snapshots (hence 5). Anything wanting primes faster than
// one every two seconds, sustained, is not this workload.
const DEFAULTS = {
  requestBurst: 200,
  requestsPerSecond: 50,
  primeBurst: 5,
  primesPerSecond: 0.5,
} as const;

/**
 * The service's volume control.
 *
 * Buckets are held per source rather than globally, so one source being hammered
 * cannot starve another — the practice's "throttling degrades gracefully: the
 * rest of the service stays healthy while one caller is throttled". The map is
 * bounded by construction: only allowlisted sources ever reach it, and the
 * allowlist is a fixed set supplied at startup.
 */
export class RateLimiter {
  private readonly opts: Required<Omit<RateLimitOptions, 'now'>>;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { requests: TokenBucket; primes: TokenBucket }>();

  constructor(options: RateLimitOptions = {}) {
    this.now = options.now ?? Date.now;
    this.opts = {
      requestBurst: options.requestBurst ?? DEFAULTS.requestBurst,
      requestsPerSecond: options.requestsPerSecond ?? DEFAULTS.requestsPerSecond,
      primeBurst: options.primeBurst ?? DEFAULTS.primeBurst,
      primesPerSecond: options.primesPerSecond ?? DEFAULTS.primesPerSecond,
    };
  }

  /**
   * Charge one request against `source`.
   *
   * `expensive` says whether this request would prime — the caller knows, because
   * it can ask the proxy whether the snapshot is already resident. An expensive
   * request spends from both budgets: it is still a request, and it is also a
   * prime.
   */
  check(source: string, expensive: boolean): RateLimitVerdict {
    const bucket = this.bucketsFor(source);

    // Charge the expensive budget FIRST. Taking a token is a side effect, so
    // checking requests first would spend one on a call the prime budget is
    // about to refuse — and a caller stuck on the prime limit would drain its
    // request budget too, turning one throttle into two.
    if (expensive) {
      const prime = bucket.primes.take();
      if (!prime.ok) {
        return {
          allowed: false,
          retryAfterSeconds: prime.retryAfterSeconds,
          limit: 'primes',
        };
      }
    }

    const request = bucket.requests.take();
    if (!request.ok) {
      return {
        allowed: false,
        retryAfterSeconds: request.retryAfterSeconds,
        limit: 'requests',
      };
    }

    return ALLOWED;
  }

  private bucketsFor(source: string) {
    let entry = this.buckets.get(source);
    if (!entry) {
      entry = {
        requests: new TokenBucket(this.opts.requestBurst, this.opts.requestsPerSecond, this.now),
        primes: new TokenBucket(this.opts.primeBurst, this.opts.primesPerSecond, this.now),
      };
      this.buckets.set(source, entry);
    }
    return entry;
  }
}
