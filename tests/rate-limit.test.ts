// Volume-control tests: TokenBucket and RateLimiter.
//
// Every test uses a mutable fake clock — never real timers or sleeps — so the
// suite is both deterministic and fast regardless of how the scheduler runs.

import { describe, it, expect } from 'vitest';
import { TokenBucket, RateLimiter } from '../src/rate-limit.js';

// ---------------------------------------------------------------------------
// TokenBucket
// ---------------------------------------------------------------------------

describe('TokenBucket', () => {
  it('allows exactly capacity takes before refusing', () => {
    // If more than `capacity` tokens were available the burst limit would be
    // violated; if fewer, legitimate requests would be refused before the
    // bucket empties.
    const bucket = new TokenBucket(3, 1, () => 0);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(false);
  });

  it('refuses with retryAfterSeconds >= 1, never 0', () => {
    // A Retry-After of 0 tells the client to retry immediately, which is the
    // exact behaviour the rate limit exists to stop.
    const bucket = new TokenBucket(1, 1, () => 0);
    bucket.take(); // empty it
    const { ok, retryAfterSeconds } = bucket.take();
    expect(ok).toBe(false);
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills at the stated rate over time and allows takes again', () => {
    // If refill is wrong (e.g. off by a factor of 1000) the bucket never
    // recovers from a burst and the service is permanently throttled.
    let now = 0;
    const bucket = new TokenBucket(2, 2, () => now); // 2 tokens/s
    bucket.take();
    bucket.take(); // empty
    expect(bucket.take().ok).toBe(false);

    now += 500; // +0.5 s → +1 token
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(false);
  });

  it('never refills above capacity however long it idles', () => {
    // An unbounded token bank would let a long-idle source fire an arbitrarily
    // large burst — every historical idle second would turn into a free request.
    let now = 0;
    const bucket = new TokenBucket(5, 10, () => now);
    bucket.take(); // 4 tokens left
    now += 1_000_000; // 1000 seconds idle — would bank 10 000 tokens if uncapped
    expect(bucket.available).toBe(5); // capped at capacity
  });

  it('a backward clock jump neither credits tokens nor wedges the bucket', () => {
    // NTP corrections and container suspends can move the clock backwards. A
    // backward jump must not give free tokens (negative elapsed → positive credit)
    // and must not freeze the bucket permanently.
    let now = 1000;
    const bucket = new TokenBucket(3, 1, () => now);
    bucket.take();
    bucket.take();
    bucket.take(); // empty at t=1000

    now = 500; // clock goes back 500 ms — must not credit tokens
    expect(bucket.take().ok).toBe(false); // still empty

    now = 2500; // clock back to a sensible value (+1.5 s from original empty)
    expect(bucket.take().ok).toBe(true); // refilled by 1.5 tokens → 1 available
  });

  it('does not pay for the same interval twice after a clock jumps back and forward', () => {
    // The subtle half of a backward jump. Moving the refill REFERENCE backwards
    // credits nothing at the time, so it looks safe — but it re-opens a stretch
    // of time that has already been paid for, and the return trip credits it a
    // second time. A limiter that over-grants on an NTP correction is one an
    // attacker can simply wait out.
    let now = 0;
    const bucket = new TokenBucket(10, 1, () => now);
    for (let i = 0; i < 10; i++) bucket.take(); // empty at t=0

    now = 5_000; // +5 s → 5 tokens, honestly earned
    expect(Math.floor(bucket.available)).toBe(5);

    now = 2_000; // clock corrects backwards
    bucket.peek(); // an ordinary check, which is where the reference would move

    now = 5_000; // and back to where it was — NO new time has actually passed
    expect(Math.floor(bucket.available)).toBe(5); // not 8
  });

  it('rejects a non-positive capacity at construction', () => {
    // A zero or negative capacity makes the bucket permanently empty, which is
    // an API misuse that should fail loudly rather than silently throttling
    // every request.
    expect(() => new TokenBucket(0, 1)).toThrow();
    expect(() => new TokenBucket(-1, 1)).toThrow();
  });

  it('rejects a non-positive refillPerSecond at construction', () => {
    // A zero or negative rate means the bucket never refills; once spent it
    // throttles every subsequent request for the lifetime of the process.
    expect(() => new TokenBucket(5, 0)).toThrow();
    expect(() => new TokenBucket(5, -1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  it('a cheap (non-expensive) request spends only the request budget', () => {
    // Cache hits are cheap (just a map lookup). The whole point of the
    // two-budget design is that a burst of cache hits must not be throttled
    // by the prime budget — otherwise a warmed service behaves identically
    // to a cold one, defeating the cache.
    const limiter = new RateLimiter({
      requestBurst: 5,
      requestsPerSecond: 1,
      primeBurst: 2,
      primesPerSecond: 1,
      now: () => 0,
    });

    // Exhaust the prime budget.
    limiter.check('src/a', true);
    limiter.check('src/a', true);
    // Prime budget is now empty; request budget still has 3 tokens left.

    // Cheap requests (non-expensive) must still succeed.
    expect(limiter.check('src/a', false).allowed).toBe(true);
    expect(limiter.check('src/a', false).allowed).toBe(true);
    expect(limiter.check('src/a', false).allowed).toBe(true);
  });

  it('an expensive request spends BOTH budgets', () => {
    // An uncached prime downloads a whole repository — it is expensive in both
    // the "operation cost" and the "request slot" sense. If only one budget
    // is charged, accounting is wrong and one of the limits is meaningless.
    const limiter = new RateLimiter({
      requestBurst: 3,
      requestsPerSecond: 1,
      primeBurst: 3,
      primesPerSecond: 1,
      now: () => 0,
    });

    limiter.check('src/a', true); // costs one prime + one request token
    limiter.check('src/a', true);
    limiter.check('src/a', true); // request budget now empty

    // Another cheap request must be refused — request budget was drained by
    // the expensive calls.
    expect(limiter.check('src/a', false).allowed).toBe(false);
  });

  it('an exhausted prime budget returns limit: "primes" and does NOT charge the request budget', () => {
    // A caller stuck on the prime limit must not be pushed into the request
    // limit as well. If both are charged on a prime-denied call, a caller
    // retrying after the prime TTL would find its request budget also empty.
    const limiter = new RateLimiter({
      requestBurst: 10,
      requestsPerSecond: 1,
      primeBurst: 1,
      primesPerSecond: 1,
      now: () => 0,
    });

    limiter.check('src/a', true); // uses the one prime token
    const verdict = limiter.check('src/a', true);

    expect(verdict.allowed).toBe(false);
    expect(verdict.limit).toBe('primes');

    // The request budget must still have 9 tokens (only 1 was spent by the
    // first successful expensive call, not by the denied one).
    let remaining = 0;
    for (let i = 0; i < 9; i++) {
      if (limiter.check('src/a', false).allowed) remaining++;
    }
    expect(remaining).toBe(9);
  });

  it('an exhausted request budget returns limit: "requests"', () => {
    // The response body and logs use `limit` to explain what ran out; the
    // wrong label misleads the operator and the client's retry strategy.
    const limiter = new RateLimiter({
      requestBurst: 2,
      requestsPerSecond: 1,
      primeBurst: 10,
      primesPerSecond: 1,
      now: () => 0,
    });

    limiter.check('src/a', false);
    limiter.check('src/a', false);
    const verdict = limiter.check('src/a', false);

    expect(verdict.allowed).toBe(false);
    expect(verdict.limit).toBe('requests');
  });

  it('buckets are per source: exhausting one source leaves another unaffected', () => {
    // A global bucket would let one misbehaving source starve every other
    // allowed source on the same instance. Per-source isolation is the
    // anti-starvation property the design states explicitly.
    const limiter = new RateLimiter({
      requestBurst: 2,
      requestsPerSecond: 1,
      primeBurst: 2,
      primesPerSecond: 1,
      now: () => 0,
    });

    // Drain source A completely.
    limiter.check('src/a', true);
    limiter.check('src/a', true);
    limiter.check('src/a', false);
    limiter.check('src/a', false);

    // Source B is untouched and must still accept requests.
    expect(limiter.check('src/b', false).allowed).toBe(true);
  });
});

describe('RateLimiter — a refused request charges nothing', () => {
  // The whole point of the two-phase check. Charging budgets one at a time means
  // a request refused by the SECOND budget has already spent the first, so a
  // burst of rejections quietly drains an allowance no work ever used.

  it('an expensive request refused by the REQUEST budget does not spend a prime token', () => {
    // This is the leak that matters, because the prime budget is two orders of
    // magnitude scarcer: if refused requests burned prime tokens, a caller could
    // exhaust the whole snapshot allowance without fetching a single snapshot.
    const clock = { t: 0 };
    const limiter = new RateLimiter({
      requestBurst: 1,
      requestsPerSecond: 1, // one token per 1000ms
      primeBurst: 2,
      primesPerSecond: 0.000_001, // effectively frozen for this test
      now: () => clock.t,
    });

    // Spend the only request token. The prime budget is untouched at 2.
    expect(limiter.check('org/repo', false).allowed).toBe(true);

    // Two expensive requests, both refused for want of a REQUEST token.
    for (let i = 0; i < 2; i++) {
      expect(limiter.check('org/repo', true)).toMatchObject({
        allowed: false,
        limit: 'requests',
      });
    }

    // Refill the request budget. The prime budget cannot have refilled.
    clock.t = 1_000;

    // Had those two refusals each charged a prime token, the budget would now be
    // empty and this would come back refused with limit 'primes'. It must not.
    expect(limiter.check('org/repo', true).allowed).toBe(true);
  });

  it('an expensive request refused by the PRIME budget does not spend a request token', () => {
    // The mirror image, and the reason the check cannot simply be reordered:
    // charging in either sequence leaks one of the two budgets.
    const limiter = new RateLimiter({
      requestBurst: 5,
      requestsPerSecond: 0.001,
      primeBurst: 1,
      primesPerSecond: 0.001,
      now: () => 0,
    });

    limiter.check('org/repo', true); // spends the only prime token
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('org/repo', true).limit).toBe('primes');
    }

    // 5 request tokens, 1 spent by the successful prime. If the three refusals
    // had each charged one there would be 1 left; there should be 4.
    for (let i = 0; i < 4; i++) {
      expect(limiter.check('org/repo', false).allowed).toBe(true);
    }
    expect(limiter.check('org/repo', false).allowed).toBe(false);
  });
});

describe('TokenBucket — peek', () => {
  it('reports availability without consuming a token', () => {
    // `check` relies on this: it peeks every budget before charging any, so a
    // peek that consumed would reintroduce the leak it exists to prevent.
    const bucket = new TokenBucket(2, 1, () => 0);
    expect(bucket.peek().ok).toBe(true);
    expect(bucket.peek().ok).toBe(true);
    expect(bucket.available).toBe(2);
  });

  it('agrees with take about an empty bucket', () => {
    const bucket = new TokenBucket(1, 1, () => 0);
    bucket.take();
    expect(bucket.peek().ok).toBe(false);
    expect(bucket.peek().retryAfterSeconds).toBeGreaterThan(0);
  });
});
