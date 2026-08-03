// S2 — ResolvedSnapshot and SnapshotReader tests.
//
// Covers:
// - resolveSnapshot() creates a handle stamped with source, ref, sha, resolvedAt
// - SnapshotReader.getBlob / getTree delegate to the proxy with the resolved sha
// - One-sha invariant: two reads through the same SnapshotReader always use
//   the same sha, regardless of any push that moved the ref after resolution
// - Single-flight is preserved: concurrent reads through the same snapshot
//   share one underlying prime
// - RefResolutionError propagates outright — no silent fallback to a stale sha
// - resolvedAt reflects the clock at resolution time

import { describe, it, expect } from 'vitest';
import { SourceProxy, type TarballFetcher } from '../src/proxy.js';
import { ProxyNotFoundError } from '../src/errors.js';
import { StubRefResolver, RefResolutionError } from '../src/resolver.js';
import { resolveSnapshot, SnapshotReader, type ResolvedSnapshot } from '../src/snapshot.js';
import { buildFakeTarballGz } from './helpers/tarball.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeTarball(files: Array<{ path: string; content: string }> = defaultFiles()) {
  return buildFakeTarballGz(files.map((f) => ({ path: f.path, content: f.content })));
}

function defaultFiles() {
  return [
    { path: 'src/index.ts', content: 'export const version = 1;\n' },
    { path: 'README.md', content: '# project\n' },
  ];
}

interface FetchCall {
  source: string;
  sha: string;
}

function makeImmediateFetcher(tarball: () => Buffer) {
  const calls: FetchCall[] = [];
  const fetcher: TarballFetcher = {
    async fetchTarball(source, sha) {
      calls.push({ source, sha });
      return tarball();
    },
  };
  return { fetcher, calls };
}

function makeControllableFetcher(tarball: () => Buffer) {
  const calls: FetchCall[] = [];
  const pending: Array<() => void> = [];
  const fetcher: TarballFetcher = {
    async fetchTarball(source, sha) {
      calls.push({ source, sha });
      await new Promise<void>((resolve) => pending.push(resolve));
      return tarball();
    },
  };
  return {
    fetcher,
    calls,
    release: () => {
      const toRelease = pending.splice(0);
      for (const r of toRelease) r();
    },
  };
}

const SOURCE = 'https://github.com/org/repo';
const MAIN_SHA = 'a'.repeat(40);

// ---------------------------------------------------------------------------
// resolveSnapshot — stamp
// ---------------------------------------------------------------------------

describe('resolveSnapshot — stamps the handle with source, ref, sha, resolvedAt', () => {
  it('returns a ResolvedSnapshot with the sha the resolver returned', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');

    expect(reader.snapshot.source).toBe(SOURCE);
    expect(reader.snapshot.ref).toBe('main');
    expect(reader.snapshot.sha).toBe(MAIN_SHA);
  });

  it('stamps resolvedAt as an ISO-8601 string from the injected clock', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);
    const fixedTime = '2025-06-01T12:00:00.000Z';

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main', () => fixedTime);

    expect(reader.snapshot.resolvedAt).toBe(fixedTime);
  });

  it('two resolveSnapshot calls against the same ref at different times produce different stamps', async () => {
    let tick = 0;
    const resolver = new StubRefResolver()
      .register(SOURCE, 'main', MAIN_SHA);
    const { fetcher } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const times = ['2025-06-01T09:00:00.000Z', '2025-06-01T10:00:00.000Z'];
    const now = () => times[tick++]!;

    const r1 = await resolveSnapshot(resolver, proxy, SOURCE, 'main', now);
    // Re-register so the second call also resolves (same sha for simplicity)
    resolver.register(SOURCE, 'main', MAIN_SHA);
    const r2 = await resolveSnapshot(resolver, proxy, SOURCE, 'main', now);

    expect(r1.snapshot.resolvedAt).toBe('2025-06-01T09:00:00.000Z');
    expect(r2.snapshot.resolvedAt).toBe('2025-06-01T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// resolveSnapshot — failure behaviour
// ---------------------------------------------------------------------------

describe('resolveSnapshot — fails outright when the ref cannot be resolved', () => {
  it('propagates RefResolutionError when the resolver throws', async () => {
    const resolver = new StubRefResolver().registerFailure(SOURCE, 'missing-branch');
    const { fetcher } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    await expect(
      resolveSnapshot(resolver, proxy, SOURCE, 'missing-branch'),
    ).rejects.toBeInstanceOf(RefResolutionError);
  });

  it('does NOT fall back to any stale sha — the error propagates unchanged', async () => {
    const resolver = new StubRefResolver().registerFailure(SOURCE, 'gone', 'branch was deleted');
    const { fetcher, calls } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const error = await resolveSnapshot(resolver, proxy, SOURCE, 'gone')
      .then(() => null)
      .catch((e: unknown) => e);

    // The proxy was never asked to fetch anything — no tarball, no stale read.
    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(RefResolutionError);
    expect((error as RefResolutionError).message).toMatch(/branch was deleted/);
  });
});

// ---------------------------------------------------------------------------
// SnapshotReader — one-sha invariant
// ---------------------------------------------------------------------------

describe('SnapshotReader — every read uses the sha fixed at resolution time', () => {
  it('getBlob reads from the resolved sha, not the ref', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher, calls } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');
    await reader.getBlob('src/index.ts');

    // The proxy was called with the resolved SHA, not the ref string.
    expect(calls[0]).toEqual({ source: SOURCE, sha: MAIN_SHA });
  });

  it('getTree reads from the resolved sha', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher, calls } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');
    await reader.getTree();

    expect(calls[0]).toEqual({ source: SOURCE, sha: MAIN_SHA });
  });

  it('multiple reads from the same SnapshotReader all use the same sha', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher, calls } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');
    await reader.getBlob('src/index.ts');
    await reader.getBlob('README.md');
    await reader.getTree();

    // All reads must have used the resolved SHA.
    const usedShas = new Set(calls.map((c) => c.sha));
    expect(usedShas.size).toBe(1);
    expect([...usedShas][0]).toBe(MAIN_SHA);
  });

  it('a "push that moves main" after resolution has no effect on an existing reader', async () => {
    // Simulate: main resolves to SHA-1; later a push moves main to SHA-2.
    // The reader was created before the push; its reads must still go to SHA-1.
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);

    const resolver = new StubRefResolver().register(SOURCE, 'main', sha1);
    const { fetcher, calls } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');

    // "Push" happens here — we re-register main to a new SHA in the resolver.
    resolver.register(SOURCE, 'main', sha2);

    // All reads still use SHA-1.
    await reader.getBlob('src/index.ts');
    await reader.getTree();

    const usedShas = calls.map((c) => c.sha);
    expect(usedShas.every((s) => s === sha1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SnapshotReader — content
// ---------------------------------------------------------------------------

describe('SnapshotReader — returns correct file content', () => {
  it('getBlob returns the file bytes', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');
    const content = await reader.getBlob('src/index.ts');

    expect(content.toString('utf8')).toBe('export const version = 1;\n');
  });

  it('getBlob throws ProxyNotFoundError for a path that does not exist in the snapshot', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');

    await expect(reader.getBlob('does/not/exist.ts')).rejects.toBeInstanceOf(ProxyNotFoundError);
  });

  it('getTree includes both files and derived directories', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');
    const tree = await reader.getTree();

    const paths = tree.map((e) => e.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('README.md');
    expect(paths).toContain('src'); // derived directory
  });
});

// ---------------------------------------------------------------------------
// Single-flight preserved through SnapshotReader
// ---------------------------------------------------------------------------

describe('SnapshotReader — concurrent reads share one underlying prime', () => {
  it('N concurrent getBlob calls through the same snapshot produce exactly ONE upstream fetch', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher, calls, release } = makeControllableFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');

    const N = 10;
    const requests = Array.from({ length: N }, () => reader.getBlob('src/index.ts'));

    // Let the synchronous prime() prologue run for all concurrent callers.
    await Promise.resolve();

    // All N callers must have joined the one in-flight prime — not started N.
    expect(calls.length).toBe(1);

    release();
    const results = await Promise.all(requests);

    // Still exactly one upstream fetch total.
    expect(calls.length).toBe(1);
    for (const r of results) {
      expect(r.toString('utf8')).toBe('export const version = 1;\n');
    }
  });

  it('a getTree and getBlob for the same snapshot in a burst share one prime', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher, calls, release } = makeControllableFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main');

    const blobP = reader.getBlob('README.md');
    const treeP = reader.getTree();

    await Promise.resolve();
    expect(calls.length).toBe(1);

    release();
    const [blob, tree] = await Promise.all([blobP, treeP]);

    expect(calls.length).toBe(1);
    expect(blob.toString('utf8')).toBe('# project\n');
    expect(tree.some((e) => e.path === 'README.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ResolvedSnapshot type — structural assertions
// ---------------------------------------------------------------------------

describe('ResolvedSnapshot — shape', () => {
  it('snapshot is a plain serialisable object (no methods or class instances)', async () => {
    const resolver = new StubRefResolver().register(SOURCE, 'main', MAIN_SHA);
    const { fetcher } = makeImmediateFetcher(() => makeFakeTarball());
    const proxy = new SourceProxy(fetcher);

    const reader = await resolveSnapshot(resolver, proxy, SOURCE, 'main', () => '2025-06-01T00:00:00.000Z');
    const snap: ResolvedSnapshot = reader.snapshot;

    // Every field is a plain string — safe to JSON.stringify / store in a DB.
    expect(typeof snap.source).toBe('string');
    expect(typeof snap.ref).toBe('string');
    expect(typeof snap.sha).toBe('string');
    expect(typeof snap.resolvedAt).toBe('string');

    // Roundtrips through JSON without loss.
    const roundtripped = JSON.parse(JSON.stringify(snap)) as ResolvedSnapshot;
    expect(roundtripped).toEqual(snap);
  });
});
