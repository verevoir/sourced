// S1 persistence tests. Covers:
//
// - FilesystemBlobStore: read miss, write-then-read, tree manifest round-trip,
//   idempotent writes, snapshot listing, snapshot deletion.
// - Key helpers: blobKey, treeManifestKey, snapshotKey are pure functions
//   and must be deterministic and distinct.
// - GcsBlobStore: exercised against a fake GcsBucket — no real GCS,
//   no credentials. Same contract as FilesystemBlobStore.
// - GC: MaxAgePolicyMs policy, runGc sweep (deletes eligible, keeps
//   young, keeps snapshots with missing manifests).
// - Proxy integration: persisted hit skips upstream; write-through warms
//   the store; single-flight preserved under persistence.
//
// Every test uses an isolated temporary directory (os.tmpdir() + random
// suffix) so tests are independent and deterministic.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FilesystemBlobStore,
  GcsBlobStore,
  MaxAgePolicyMs,
  runGc,
  blobKey,
  treeManifestKey,
  snapshotKey,
  type GcsBucket,
  type TreeManifest,
  type RawBlobStore,
} from '../src/store.js';
import { SourceProxy, type TarballFetcher } from '../src/proxy.js';
import { buildFakeTarballGz } from './helpers/tarball.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SOURCE = 'github.com/org/repo';
const SHA = 'abc123def456';
const PATH = 'src/index.ts';
const CONTENT = Buffer.from('export const x = 1;\n', 'utf8');

const SAMPLE_TARBALL = () =>
  buildFakeTarballGz([
    { path: 'src/index.ts', content: 'export const a = 1;\n' },
    { path: 'src/util.ts', content: 'export const b = 2;\n' },
    { path: 'README.md', content: '# hello\n' },
  ]);

function makeImmediateFetcher(result: () => Buffer) {
  let calls = 0;
  const fetcher: TarballFetcher = {
    async fetchTarball() {
      calls++;
      return result();
    },
  };
  return { fetcher, getCallCount: () => calls };
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

describe('key helpers', () => {
  it('blobKey is deterministic for the same inputs', () => {
    expect(blobKey(SOURCE, SHA, PATH)).toBe(blobKey(SOURCE, SHA, PATH));
  });

  it('blobKey differs for different paths within the same snapshot', () => {
    expect(blobKey(SOURCE, SHA, 'a.ts')).not.toBe(blobKey(SOURCE, SHA, 'b.ts'));
  });

  it('blobKey differs for different SHAs', () => {
    expect(blobKey(SOURCE, 'sha-A', PATH)).not.toBe(blobKey(SOURCE, 'sha-B', PATH));
  });

  it('snapshotKey is the same for all blobs in the same snapshot', () => {
    const snap = snapshotKey(SOURCE, SHA);
    expect(blobKey(SOURCE, SHA, 'a.ts')).toContain(snap);
    expect(blobKey(SOURCE, SHA, 'b.ts')).toContain(snap);
  });

  it('treeManifestKey is within the snapshot prefix', () => {
    const snap = snapshotKey(SOURCE, SHA);
    expect(treeManifestKey(SOURCE, SHA)).toContain(snap);
  });

  it('treeManifestKey and blobKey never collide', () => {
    expect(treeManifestKey(SOURCE, SHA)).not.toBe(blobKey(SOURCE, SHA, '_tree.json'));
  });
});

// ---------------------------------------------------------------------------
// FilesystemBlobStore
// ---------------------------------------------------------------------------

describe('FilesystemBlobStore', () => {
  let baseDir: string;
  let store: FilesystemBlobStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'sourced-test-'));
    store = new FilesystemBlobStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('returns null for a blob that has not been written', async () => {
    const result = await store.getBlob(SOURCE, SHA, PATH);
    expect(result).toBeNull();
  });

  it('returns the blob content after a write', async () => {
    await store.putBlob(SOURCE, SHA, PATH, CONTENT);
    const result = await store.getBlob(SOURCE, SHA, PATH);
    expect(result).toEqual(CONTENT);
  });

  it('write is idempotent — a second put with identical content succeeds and reads back correctly', async () => {
    await store.putBlob(SOURCE, SHA, PATH, CONTENT);
    await store.putBlob(SOURCE, SHA, PATH, CONTENT);
    const result = await store.getBlob(SOURCE, SHA, PATH);
    expect(result).toEqual(CONTENT);
  });

  it('stores different blobs under the same snapshot independently', async () => {
    const content2 = Buffer.from('export const y = 2;\n', 'utf8');
    await store.putBlob(SOURCE, SHA, 'src/a.ts', CONTENT);
    await store.putBlob(SOURCE, SHA, 'src/b.ts', content2);
    expect(await store.getBlob(SOURCE, SHA, 'src/a.ts')).toEqual(CONTENT);
    expect(await store.getBlob(SOURCE, SHA, 'src/b.ts')).toEqual(content2);
  });

  it('returns null for the tree manifest before any write', async () => {
    const result = await store.getTreeManifest(SOURCE, SHA);
    expect(result).toBeNull();
  });

  it('round-trips the tree manifest', async () => {
    const manifest: TreeManifest = {
      sourceUrl: SOURCE,
      sha: SHA,
      createdAt: '2024-01-01T00:00:00.000Z',
      entries: [
        { path: 'src/index.ts', type: 'blob', size: 21, sha: 'deadbeef' },
      ],
    };
    await store.putTreeManifest(SOURCE, SHA, manifest);
    const result = await store.getTreeManifest(SOURCE, SHA);
    expect(result).toEqual(manifest);
  });

  it('listSnapshotKeys returns an empty array when the store is empty', async () => {
    const keys = await store.listSnapshotKeys();
    expect(keys).toEqual([]);
  });

  it('listSnapshotKeys includes the snapshot after a write', async () => {
    await store.putBlob(SOURCE, SHA, PATH, CONTENT);
    const keys = await store.listSnapshotKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('snapshots/');
  });

  it('listSnapshotKeys includes distinct entries for different SHAs', async () => {
    await store.putBlob(SOURCE, 'sha-A', PATH, CONTENT);
    await store.putBlob(SOURCE, 'sha-B', PATH, CONTENT);
    const keys = await store.listSnapshotKeys();
    expect(keys).toHaveLength(2);
  });

  it('deleteSnapshot removes the snapshot and its blobs', async () => {
    await store.putBlob(SOURCE, SHA, PATH, CONTENT);
    const [key] = await store.listSnapshotKeys();
    await store.deleteSnapshot(key!);
    expect(await store.listSnapshotKeys()).toHaveLength(0);
    expect(await store.getBlob(SOURCE, SHA, PATH)).toBeNull();
  });

  it('deleteSnapshot on a non-existent key is a no-op', async () => {
    await expect(store.deleteSnapshot('snapshots/doesnotexist')).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GcsBlobStore (tested against a fake GcsBucket — no real GCS)
// ---------------------------------------------------------------------------

function makeFakeGcsBucket(): GcsBucket & {
  objects: Map<string, Buffer>;
} {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async download(key) {
      return objects.get(key) ?? null;
    },
    async upload(key, content) {
      objects.set(key, content);
    },
    async listSnapshotPrefixes() {
      const prefixes = new Set<string>();
      for (const key of objects.keys()) {
        const match = /^(snapshots\/[^/]+)/.exec(key);
        if (match) prefixes.add(match[1]!);
      }
      return [...prefixes];
    },
    async deletePrefix(prefix) {
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) objects.delete(key);
      }
    },
  };
}

describe('GcsBlobStore (fake bucket)', () => {
  it('returns null for a blob that has not been uploaded', async () => {
    const store = new GcsBlobStore(makeFakeGcsBucket());
    expect(await store.getBlob(SOURCE, SHA, PATH)).toBeNull();
  });

  it('round-trips a blob through the fake bucket', async () => {
    const store = new GcsBlobStore(makeFakeGcsBucket());
    await store.putBlob(SOURCE, SHA, PATH, CONTENT);
    expect(await store.getBlob(SOURCE, SHA, PATH)).toEqual(CONTENT);
  });

  it('round-trips the tree manifest through the fake bucket', async () => {
    const store = new GcsBlobStore(makeFakeGcsBucket());
    const manifest: TreeManifest = {
      sourceUrl: SOURCE,
      sha: SHA,
      createdAt: '2024-06-01T12:00:00.000Z',
      entries: [],
    };
    await store.putTreeManifest(SOURCE, SHA, manifest);
    expect(await store.getTreeManifest(SOURCE, SHA)).toEqual(manifest);
  });

  it('lists snapshot prefixes after upload', async () => {
    const store = new GcsBlobStore(makeFakeGcsBucket());
    await store.putBlob(SOURCE, 'sha-A', PATH, CONTENT);
    await store.putBlob(SOURCE, 'sha-B', PATH, CONTENT);
    const keys = await store.listSnapshotKeys();
    expect(keys).toHaveLength(2);
  });

  it('deleteSnapshot removes all objects under the prefix', async () => {
    const bucket = makeFakeGcsBucket();
    const store = new GcsBlobStore(bucket);
    await store.putBlob(SOURCE, SHA, 'a.ts', CONTENT);
    await store.putBlob(SOURCE, SHA, 'b.ts', CONTENT);
    const [key] = await store.listSnapshotKeys();
    await store.deleteSnapshot(key!);
    expect(await store.listSnapshotKeys()).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GC policy and runGc
// ---------------------------------------------------------------------------

describe('MaxAgePolicyMs', () => {
  it('keeps a snapshot younger than maxAgeMs', () => {
    const now = Date.now();
    const policy = new MaxAgePolicyMs(60_000, () => now);
    const manifest: TreeManifest = {
      sourceUrl: SOURCE,
      sha: SHA,
      createdAt: new Date(now - 30_000).toISOString(),
      entries: [],
    };
    expect(policy.shouldKeep(manifest)).toBe(true);
  });

  it('marks a snapshot older than maxAgeMs as eligible for deletion', () => {
    const now = Date.now();
    const policy = new MaxAgePolicyMs(60_000, () => now);
    const manifest: TreeManifest = {
      sourceUrl: SOURCE,
      sha: SHA,
      createdAt: new Date(now - 90_000).toISOString(),
      entries: [],
    };
    expect(policy.shouldKeep(manifest)).toBe(false);
  });

  it('keeps a snapshot whose age equals maxAgeMs exactly (boundary is inclusive)', () => {
    const now = Date.now();
    const policy = new MaxAgePolicyMs(60_000, () => now);
    const manifest: TreeManifest = {
      sourceUrl: SOURCE,
      sha: SHA,
      createdAt: new Date(now - 60_000).toISOString(),
      entries: [],
    };
    expect(policy.shouldKeep(manifest)).toBe(true);
  });

  it('keeps a snapshot with a null manifest (missing _tree.json)', () => {
    const policy = new MaxAgePolicyMs(60_000);
    expect(policy.shouldKeep(null)).toBe(true);
  });
});

describe('runGc', () => {
  let baseDir: string;
  let store: FilesystemBlobStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'sourced-gc-test-'));
    store = new FilesystemBlobStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function writeSnapshot(
    s: RawBlobStore,
    sourceUrl: string,
    sha: string,
    createdAt: string
  ): Promise<void> {
    await s.putBlob(sourceUrl, sha, 'file.ts', Buffer.from('content'));
    await s.putTreeManifest(sourceUrl, sha, {
      sourceUrl,
      sha,
      createdAt,
      entries: [{ path: 'file.ts', type: 'blob', size: 7, sha: 'abc' }],
    });
  }

  it('deletes a snapshot that exceeds maxAgeMs and returns the deleted count', async () => {
    const now = Date.now();
    await writeSnapshot(store, SOURCE, 'old-sha', new Date(now - 200_000).toISOString());
    const policy = new MaxAgePolicyMs(60_000, () => now);
    const deleted = await runGc(store, policy);
    expect(deleted).toBe(1);
    expect(await store.listSnapshotKeys()).toHaveLength(0);
  });

  it('keeps a snapshot within maxAgeMs', async () => {
    const now = Date.now();
    await writeSnapshot(store, SOURCE, 'young-sha', new Date(now - 10_000).toISOString());
    const policy = new MaxAgePolicyMs(60_000, () => now);
    const deleted = await runGc(store, policy);
    expect(deleted).toBe(0);
    expect(await store.listSnapshotKeys()).toHaveLength(1);
  });

  it('deletes old snapshots and keeps young ones in the same sweep', async () => {
    const now = Date.now();
    await writeSnapshot(store, SOURCE, 'old-sha', new Date(now - 200_000).toISOString());
    await writeSnapshot(store, SOURCE, 'young-sha', new Date(now - 10_000).toISOString());
    const policy = new MaxAgePolicyMs(60_000, () => now);
    const deleted = await runGc(store, policy);
    expect(deleted).toBe(1);
    const remaining = await store.listSnapshotKeys();
    expect(remaining).toHaveLength(1);
    // The young snapshot's blobs are still readable
    expect(await store.getBlob(SOURCE, 'young-sha', 'file.ts')).not.toBeNull();
    // The old snapshot's blobs are gone
    expect(await store.getBlob(SOURCE, 'old-sha', 'file.ts')).toBeNull();
  });

  it('keeps a snapshot with a missing _tree.json (orphan blobs are retained, not deleted)', async () => {
    // Write blob but NO manifest — simulates a partial write.
    await store.putBlob(SOURCE, SHA, PATH, CONTENT);
    const policy = new MaxAgePolicyMs(60_000);
    const deleted = await runGc(store, policy);
    expect(deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Proxy + persistence integration
// ---------------------------------------------------------------------------

describe('SourceProxy with persistence', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'sourced-proxy-test-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('a persisted snapshot is served from the store with zero upstream calls', async () => {
    // First proxy instance: prime from upstream, write through to store.
    const store = new FilesystemBlobStore(baseDir);
    const { fetcher: f1, getCallCount: c1 } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy1 = new SourceProxy(f1, { store });
    await proxy1.getBlob('org/repo', 'sha1', 'src/index.ts');
    expect(c1()).toBe(1);

    // Allow the async write-through to flush.
    await new Promise((r) => setTimeout(r, 50));

    // Second proxy instance: same store, cold in-memory cache.
    // Should serve from the store without any upstream call.
    const { fetcher: f2, getCallCount: c2 } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy2 = new SourceProxy(f2, { store });
    const content = await proxy2.getBlob('org/repo', 'sha1', 'src/index.ts');
    expect(c2()).toBe(0); // store hit — upstream never called
    expect(content.toString('utf8')).toBe('export const a = 1;\n');
  });

  it('a persisted hit also serves other paths in the same snapshot without an upstream call', async () => {
    const store = new FilesystemBlobStore(baseDir);
    const { fetcher: f1 } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy1 = new SourceProxy(f1, { store });
    await proxy1.getBlob('org/repo', 'sha1', 'src/index.ts');
    await new Promise((r) => setTimeout(r, 50));

    const { fetcher: f2, getCallCount: c2 } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy2 = new SourceProxy(f2, { store });
    // Ask for a different path — still served from store.
    const util = await proxy2.getBlob('org/repo', 'sha1', 'src/util.ts');
    expect(c2()).toBe(0);
    expect(util.toString('utf8')).toBe('export const b = 2;\n');
  });

  it('single-flight is preserved under persistence: N concurrent requests prime exactly once from upstream on a cold store', async () => {
    const store = new FilesystemBlobStore(baseDir);
    let fetchCount = 0;
    let releaseResolve!: () => void;
    const releaseP = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const fetcher: TarballFetcher = {
      async fetchTarball() {
        fetchCount++;
        await releaseP;
        return SAMPLE_TARBALL();
      },
    };
    const proxy = new SourceProxy(fetcher, { store });

    const N = 8;
    const requests = Array.from({ length: N }, () =>
      proxy.getBlob('org/repo', 'sha1', 'src/index.ts')
    );
    // S1 interposes an async store read before the upstream fetch, so one
    // microtask tick (Promise.resolve) is no longer sufficient to know the
    // fetch has started.  A setImmediate turn lets the filesystem ENOENT
    // resolve (cold store) and the promise chain reach fetchTarball.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCount).toBe(1); // only one upstream fetch in flight

    releaseResolve();
    const results = await Promise.all(requests);
    expect(fetchCount).toBe(1); // still exactly one after all resolved
    for (const r of results) {
      expect(r.toString('utf8')).toBe('export const a = 1;\n');
    }
  });

  it('a partial write (blobs present, manifest absent) is treated as a cache miss and re-primed from upstream', async () => {
    // Write a blob but omit the manifest — simulates a crash mid-write-through.
    const store = new FilesystemBlobStore(baseDir);
    await store.putBlob('org/repo', 'sha1', 'src/index.ts', Buffer.from('stale'));
    // No putTreeManifest call.

    const { fetcher, getCallCount } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy = new SourceProxy(fetcher, { store });
    const content = await proxy.getBlob('org/repo', 'sha1', 'src/index.ts');
    expect(getCallCount()).toBe(1); // upstream called because manifest was absent
    expect(content.toString('utf8')).toBe('export const a = 1;\n');
    // Allow the async write-through to flush before afterEach cleans up the
    // directory — without this, a concurrent rmdir from Node's recursive rm
    // races the in-flight writeFile and throws ENOTEMPTY.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('without a store the proxy behaves identically to S0', async () => {
    const { fetcher, getCallCount } = makeImmediateFetcher(SAMPLE_TARBALL);
    const proxy = new SourceProxy(fetcher); // no store
    const content = await proxy.getBlob('org/repo', 'sha1', 'src/index.ts');
    expect(getCallCount()).toBe(1);
    expect(content.toString('utf8')).toBe('export const a = 1;\n');
    // Second call — served from in-memory, no second fetch.
    await proxy.getBlob('org/repo', 'sha1', 'src/util.ts');
    expect(getCallCount()).toBe(1);
  });
});
