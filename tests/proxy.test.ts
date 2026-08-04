// Proves the properties the S0 task exists to deliver — not that the
// functions exist. Every test asserts on a COUNTED fake fetcher, never on
// timing, and no test touches the network (the fetcher is always injected).

import { describe, it, expect } from 'vitest';
import { SourceProxy, type TarballFetcher } from '../src/proxy.js';
import { ProxyNotFoundError } from '../src/errors.js';
import { buildFakeTarballGz } from './helpers/tarball.js';

interface FetchCall {
  source: string;
  sha: string;
}

/** A fetcher whose `fetchTarball` calls are counted and DO NOT resolve
 * until `release()` is called — the tool for proving single-flight and
 * coalescing under real concurrency rather than by timing assumptions. */
function makeControllableFetcher(result: () => Buffer | Promise<Buffer>) {
  const calls: FetchCall[] = [];
  const pending: Array<() => void> = [];
  const fetcher: TarballFetcher = {
    async fetchTarball(source, sha) {
      calls.push({ source, sha });
      await new Promise<void>((resolve) => pending.push(resolve));
      return result();
    },
  };
  return {
    fetcher,
    calls,
    /** Resolve every fetchTarball call currently awaiting release. */
    release: () => {
      const toRelease = pending.splice(0, pending.length);
      for (const resolve of toRelease) resolve();
    },
  };
}

/** A fetcher that resolves immediately — used where concurrency control
 * isn't the point of the test. */
function makeImmediateFetcher(result: () => Buffer | Promise<Buffer>) {
  const calls: FetchCall[] = [];
  const fetcher: TarballFetcher = {
    async fetchTarball(source, sha) {
      calls.push({ source, sha });
      return result();
    },
  };
  return { fetcher, calls };
}

const SAMPLE_TARBALL = () =>
  buildFakeTarballGz([
    { path: 'src/index.ts', content: 'export const a = 1;\n' },
    { path: 'src/util.ts', content: 'export const b = 2;\n' },
    { path: 'README.md', content: '# hello\n' },
  ]);

describe('SourceProxy — single-flight / coalescing', () => {
  it('N concurrent requests for the same (source, sha, path) produce exactly ONE upstream fetch', async () => {
    const { fetcher, calls, release } = makeControllableFetcher(SAMPLE_TARBALL);
    const proxy = new SourceProxy(fetcher);

    const N = 12;
    const requests = Array.from({ length: N }, () => proxy.getBlob('org/repo', 'sha1', 'src/index.ts'));

    // All N requests have been issued; none can have resolved yet (the
    // fetcher is deliberately held open), so this is the moment to assert
    // the fetch count rather than after the fact.
    await Promise.resolve(); // let the synchronous prime() prologue run for each
    expect(calls.length).toBe(1);

    release();
    const results = await Promise.all(requests);
    expect(calls.length).toBe(1); // still one, after every caller resolved
    for (const r of results) {
      expect(r.toString('utf8')).toBe('export const a = 1;\n');
    }
  });

  it('a prime serves subsequent distinct paths with zero further upstream calls', async () => {
    const { fetcher, calls } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy = new SourceProxy(fetcher);

    await proxy.getBlob('org/repo', 'sha1', 'src/index.ts');
    expect(calls.length).toBe(1);

    const util = await proxy.getBlob('org/repo', 'sha1', 'src/util.ts');
    const readme = await proxy.getBlob('org/repo', 'sha1', 'README.md');
    const tree = await proxy.getTree('org/repo', 'sha1');

    expect(calls.length).toBe(1); // three more reads, zero more fetches
    expect(util.toString('utf8')).toBe('export const b = 2;\n');
    expect(readme.toString('utf8')).toBe('# hello\n');
    expect(tree.some((e) => e.path === 'src' && e.type === 'tree')).toBe(true);
    expect(tree.some((e) => e.path === 'src/index.ts' && e.type === 'blob')).toBe(true);
  });

  it('a concurrent burst during an in-flight prime does not trigger a second prime', async () => {
    const { fetcher, calls, release } = makeControllableFetcher(SAMPLE_TARBALL);
    const proxy = new SourceProxy(fetcher);

    // First caller starts the prime and is left hanging.
    const first = proxy.getBlob('org/repo', 'sha1', 'src/index.ts');
    await Promise.resolve();
    expect(calls.length).toBe(1);

    // A burst arrives WHILE that prime is still in flight — same path,
    // different paths, and a tree read. None of these should start a
    // second prime.
    const burst = [
      proxy.getBlob('org/repo', 'sha1', 'src/index.ts'),
      proxy.getBlob('org/repo', 'sha1', 'src/util.ts'),
      proxy.getBlob('org/repo', 'sha1', 'README.md'),
      proxy.getTree('org/repo', 'sha1'),
    ];
    await Promise.resolve();
    expect(calls.length).toBe(1); // the burst joined the existing prime

    release();
    await Promise.all([first, ...burst]);
    expect(calls.length).toBe(1); // still exactly one upstream fetch total
  });
});

describe('SourceProxy — failure does not poison the cache', () => {
  it('an upstream (transient) failure is not cached; the next request retries', async () => {
    let attempt = 0;
    const calls: FetchCall[] = [];
    const fetcher: TarballFetcher = {
      async fetchTarball(source, sha) {
        calls.push({ source, sha });
        attempt++;
        if (attempt === 1) throw new Error('ECONNRESET: simulated transient network failure');
        return SAMPLE_TARBALL();
      },
    };
    const proxy = new SourceProxy(fetcher);

    await expect(proxy.getBlob('org/repo', 'sha1', 'src/index.ts')).rejects.toThrow(
      /simulated transient network failure/
    );
    expect(calls.length).toBe(1);

    // The next request must NOT see a cached rejection — it gets a fresh
    // attempt, which this time succeeds.
    const content = await proxy.getBlob('org/repo', 'sha1', 'src/index.ts');
    expect(calls.length).toBe(2);
    expect(content.toString('utf8')).toBe('export const a = 1;\n');
  });
});

describe('SourceProxy — negative caching', () => {
  it('caches a DEFINITIVE not-found (bad source/sha) and expires it after the TTL', async () => {
    const calls: FetchCall[] = [];
    let succeedFromNowOn = false;
    const fetcher: TarballFetcher = {
      async fetchTarball(source, sha) {
        calls.push({ source, sha });
        if (!succeedFromNowOn) throw new ProxyNotFoundError('no such sha upstream');
        return SAMPLE_TARBALL();
      },
    };

    let clock = 0;
    const proxy = new SourceProxy(fetcher, { now: () => clock, negativeTtlMs: 1000 });

    await expect(proxy.getBlob('org/repo', 'bad-sha', 'README.md')).rejects.toBeInstanceOf(
      ProxyNotFoundError
    );
    expect(calls.length).toBe(1);

    // Within the TTL: a second probe (even for a different path — the
    // negative verdict is about the (source, sha), not one path) is served
    // from the negative cache, not a second upstream call.
    clock += 500;
    await expect(proxy.getBlob('org/repo', 'bad-sha', 'src/index.ts')).rejects.toBeInstanceOf(
      ProxyNotFoundError
    );
    expect(calls.length).toBe(1);

    // Past the TTL: the negative entry has expired, so the next request
    // retries upstream — and this time it succeeds, proving expiry doesn't
    // just re-throw a stale cached error either.
    clock += 600; // total 1100ms, past the 1000ms TTL
    succeedFromNowOn = true;
    const content = await proxy.getBlob('org/repo', 'bad-sha', 'README.md');
    expect(calls.length).toBe(2);
    expect(content.toString('utf8')).toBe('# hello\n');
  });

  it('a missing path within a successfully primed tree 404s without a second fetch', async () => {
    const { fetcher, calls } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy = new SourceProxy(fetcher);

    await proxy.getBlob('org/repo', 'sha1', 'src/index.ts');
    expect(calls.length).toBe(1);

    await expect(proxy.getBlob('org/repo', 'sha1', 'does/not/exist.ts')).rejects.toBeInstanceOf(
      ProxyNotFoundError
    );
    expect(calls.length).toBe(1); // the tree is already fully known in memory
  });
});

describe('SourceProxy — distinct (source, sha) keys prime independently', () => {
  it('a different sha for the same source triggers its own prime', async () => {
    const { fetcher, calls } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy = new SourceProxy(fetcher);

    await proxy.getBlob('org/repo', 'sha1', 'src/index.ts');
    await proxy.getBlob('org/repo', 'sha2', 'src/index.ts');

    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.sha)).toEqual(['sha1', 'sha2']);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction and maxCachedBytes
// ---------------------------------------------------------------------------

describe('SourceProxy — LRU eviction and maxCachedBytes', () => {
  // Build a tarball whose content is exactly `size` bytes (approximately —
  // path overhead is small and consistent, so `size` is the dominant cost).
  function makeTarball(id: string, payloadBytes: number): () => Buffer {
    return () =>
      buildFakeTarballGz([
        { path: `file-${id}.txt`, content: 'x'.repeat(payloadBytes) },
      ]);
  }

  it('under the budget, nothing is evicted: a re-read of a primed snapshot does not re-fetch', async () => {
    // If a snapshot within the budget were evicted, the cache would be
    // pointless — every re-read would cost an upstream fetch regardless of how
    // much budget was left.
    let fetchCount = 0;
    const fetcher: TarballFetcher = {
      async fetchTarball(source, sha) {
        fetchCount++;
        return buildFakeTarballGz([{ path: 'a.txt', content: 'hello' }]);
      },
    };
    const proxy = new SourceProxy(fetcher, { maxCachedBytes: 10 * 1024 * 1024 });

    await proxy.getBlob('org/repo', 'sha1', 'a.txt');
    await proxy.getBlob('org/repo', 'sha2', 'a.txt');
    expect(fetchCount).toBe(2);

    // Re-read sha1 — should serve from cache.
    await proxy.getBlob('org/repo', 'sha1', 'a.txt');
    expect(fetchCount).toBe(2); // no additional fetch
  });

  it('over the budget, the LEAST RECENTLY USED snapshot is evicted', async () => {
    // Eviction must target the coldest entry. If MRU were evicted instead, the
    // snapshot most recently accessed would be the first to be lost, defeating
    // temporal locality — the pattern that makes an LRU cache useful.
    //
    // Sequence: prime A, prime B, touch A (makes B the coldest), prime C
    // (pushes past budget) → B must be evicted, A must remain.
    // Verified by isPrimed() — no fetches needed after the eviction check.

    const PAYLOAD = 50;
    const fetcher: TarballFetcher = {
      async fetchTarball(_source, sha) {
        return makeTarball(sha, PAYLOAD)();
      },
    };

    // Measure one entry's byte footprint, then set a budget that holds exactly 2.
    const probe = new SourceProxy(
      { async fetchTarball(_s, sha) { return makeTarball(sha, PAYLOAD)(); } },
      { maxCachedBytes: 100 * 1024 * 1024 }
    );
    await probe.getBlob('org/repo', 'shaRef', `file-shaRef.txt`);
    const oneEntryBytes = probe.cachedByteCount;

    // Budget fits exactly 2 entries — admitting a third must evict the coldest.
    const proxy = new SourceProxy(fetcher, { maxCachedBytes: oneEntryBytes * 2 + 1 });

    await proxy.getBlob('org/repo', 'shaA', `file-shaA.txt`); // LRU order: [A]
    await proxy.getBlob('org/repo', 'shaB', `file-shaB.txt`); // LRU order: [A, B]
    await proxy.getBlob('org/repo', 'shaA', `file-shaA.txt`); // touch A → [B, A]

    // Both entries fit; nothing evicted yet.
    expect(proxy.isPrimed('org/repo', 'shaA')).toBe(true);
    expect(proxy.isPrimed('org/repo', 'shaB')).toBe(true);

    // Prime C: over budget → evict B (coldest), keep A (hot).
    await proxy.getBlob('org/repo', 'shaC', `file-shaC.txt`); // LRU order: [A, C], B evicted

    expect(proxy.isPrimed('org/repo', 'shaB')).toBe(false); // B was evicted
    expect(proxy.isPrimed('org/repo', 'shaA')).toBe(true);  // A survived
  });

  it('a snapshot larger than the whole budget is still served to the caller that just primed it', async () => {
    // If a too-large snapshot were immediately evicted after priming, every
    // request for it would re-prime on every read — a cold-start loop with no
    // exit.
    let fetchCount = 0;
    const fetcher: TarballFetcher = {
      async fetchTarball(_source, _sha) {
        fetchCount++;
        return buildFakeTarballGz([{ path: 'big.txt', content: 'x'.repeat(10_000) }]);
      },
    };
    // Budget is only 1 byte — far smaller than the snapshot.
    const proxy = new SourceProxy(fetcher, { maxCachedBytes: 1 });

    const content = await proxy.getBlob('org/repo', 'sha1', 'big.txt');
    expect(fetchCount).toBe(1);
    // The caller receives the bytes — the snapshot was not evicted before the read.
    expect(content.byteLength).toBe(10_000);
  });

  it('cachedByteCount decreases after an eviction', async () => {
    // If the byte counter is not decremented on eviction, the budget is only
    // tracked upwards and the cache would continue evicting until it is empty,
    // never stabilising.
    const PAYLOAD = 100;
    let fetchCount = 0;
    const fetcher: TarballFetcher = {
      async fetchTarball(_source, sha) {
        fetchCount++;
        return makeTarball(sha, PAYLOAD)();
      },
    };

    const probe = new SourceProxy(
      { async fetchTarball(_s, sha) { return makeTarball(sha, PAYLOAD)(); } },
      { maxCachedBytes: 100 * 1024 * 1024 }
    );
    await probe.getBlob('org/repo', 'shaX', `file-shaX.txt`);
    const oneEntryBytes = probe.cachedByteCount;

    // Budget fits one entry only.
    const proxy = new SourceProxy(fetcher, { maxCachedBytes: oneEntryBytes + 1 });
    fetchCount = 0;

    await proxy.getBlob('org/repo', 'sha1', `file-sha1.txt`);
    const afterFirst = proxy.cachedByteCount;
    expect(afterFirst).toBeGreaterThan(0);

    // Prime a second entry; the first should be evicted.
    await proxy.getBlob('org/repo', 'sha2', `file-sha2.txt`);
    // The byte count must have dropped (eviction removed the first entry).
    expect(proxy.cachedByteCount).toBeLessThan(afterFirst + oneEntryBytes);
  });

  it('an evicted snapshot re-primes and returns identical content', async () => {
    // Eviction is a cache miss, not an error. The content stored upstream is
    // immutable (addressed by sha), so a re-prime must return the same bytes.
    const PAYLOAD = 50;
    const fetcher: TarballFetcher = {
      async fetchTarball(_source, sha) {
        return makeTarball(sha, PAYLOAD)();
      },
    };

    const probe = new SourceProxy(
      { async fetchTarball(_s, sha) { return makeTarball(sha, PAYLOAD)(); } },
      { maxCachedBytes: 100 * 1024 * 1024 }
    );
    await probe.getBlob('org/repo', 'shaEv', `file-shaEv.txt`);
    const oneEntryBytes = probe.cachedByteCount;

    // Budget fits exactly one entry.
    const proxy = new SourceProxy(fetcher, { maxCachedBytes: oneEntryBytes + 1 });

    const first = await proxy.getBlob('org/repo', 'shaEv', `file-shaEv.txt`);
    // Prime a second entry to evict the first.
    await proxy.getBlob('org/repo', 'shaOther', `file-shaOther.txt`);

    // Re-prime and compare.
    const second = await proxy.getBlob('org/repo', 'shaEv', `file-shaEv.txt`);
    expect(second).toEqual(first);
  });

  it('isPrimed returns true for a resident snapshot and false for an evicted one', async () => {
    // isPrimed is the signal the rate limiter uses to decide whether a request
    // is expensive. An evicted entry that still reports true would cause cache
    // hits to be mischarged as cache misses — or let a re-prime bypass the
    // prime budget.
    const PAYLOAD = 50;
    const fetcher: TarballFetcher = {
      async fetchTarball(_source, sha) {
        return makeTarball(sha, PAYLOAD)();
      },
    };

    const probe = new SourceProxy(
      { async fetchTarball(_s, sha) { return makeTarball(sha, PAYLOAD)(); } },
      { maxCachedBytes: 100 * 1024 * 1024 }
    );
    await probe.getBlob('org/repo', 'shaPr', `file-shaPr.txt`);
    const oneEntryBytes = probe.cachedByteCount;

    const proxy = new SourceProxy(fetcher, { maxCachedBytes: oneEntryBytes + 1 });

    expect(proxy.isPrimed('org/repo', 'shaPr')).toBe(false); // never seen

    await proxy.getBlob('org/repo', 'shaPr', `file-shaPr.txt`);
    expect(proxy.isPrimed('org/repo', 'shaPr')).toBe(true); // resident

    // Evict by priming another entry.
    await proxy.getBlob('org/repo', 'shaEvict', `file-shaEvict.txt`);
    expect(proxy.isPrimed('org/repo', 'shaPr')).toBe(false); // evicted
  });

  it('isPrimed never triggers a prime: asking does not increase the fetch count', async () => {
    // If isPrimed caused a prime as a side effect, the rate limiter would be
    // unable to classify a request accurately before spending its budget —
    // and callers asking "is this primed?" would unexpectedly trigger fetches.
    let fetchCount = 0;
    const fetcher: TarballFetcher = {
      async fetchTarball() {
        fetchCount++;
        return buildFakeTarballGz([{ path: 'a.txt', content: 'a' }]);
      },
    };
    const proxy = new SourceProxy(fetcher);

    proxy.isPrimed('org/repo', 'sha1');
    proxy.isPrimed('org/repo', 'sha1');
    proxy.isPrimed('org/repo', 'sha2');
    expect(fetchCount).toBe(0);
  });
});


describe('SourceProxy — a failed write-through is reported, not swallowed', () => {
  // A store write that fails costs the CALLER nothing: the snapshot is already
  // in memory, so the request succeeds either way. That is exactly what makes
  // swallowing the failure dangerous — a bucket rejecting every write looks
  // identical to one that is working, while every cold start re-primes from
  // upstream forever and nobody is ever told.

  /** A store whose reads always miss and whose writes always fail. */
  function makeBrokenStore() {
    return {
      async getBlob() {
        return null;
      },
      async putBlob() {
        throw new Error('bucket is on fire');
      },
      async getTreeManifest() {
        return null;
      },
      async putTreeManifest() {
        throw new Error('bucket is on fire');
      },
      async listSnapshotKeys() {
        return [];
      },
      async deleteSnapshot() {},
    };
  }

  it('reports the failure through the injected sink', async () => {
    const reported: unknown[] = [];
    const proxy = new SourceProxy(
      {
        async fetchTarball() {
          return buildFakeTarballGz([{ path: 'a.txt', content: 'A' }]);
        },
      },
      { store: makeBrokenStore(), onStoreWriteError: (err) => reported.push(err) }
    );

    await proxy.getTree('org/repo', 'sha1');
    // The write-through is deliberately not awaited by the caller, so let the
    // rejection settle before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toMatch(/on fire/);
  });

  it('still serves the request that triggered the failed write', async () => {
    // Fail-soft: the store is a cache, so losing a write must degrade cost, not
    // correctness. The caller gets its data.
    const proxy = new SourceProxy(
      {
        async fetchTarball() {
          return buildFakeTarballGz([{ path: 'a.txt', content: 'A' }]);
        },
      },
      { store: makeBrokenStore(), onStoreWriteError: () => {} }
    );

    const blob = await proxy.getBlob('org/repo', 'sha1', 'a.txt');
    expect(blob.toString('utf8')).toBe('A');
  });
});
