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
