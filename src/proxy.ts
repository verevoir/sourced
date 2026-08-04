// The proxy core: content-addressed, tarball-primed, single-flight,
// negative-cached. S1 adds persistence underneath the in-memory layer;
// single-flight still collapses concurrent identical requests to ONE
// upstream fetch even on a cold start (before the store is warmed),
// and a persisted hit serves directly from the store with zero upstream
// calls.
//
// S0's invariant — "385 requests becomes 1, not 77" — is preserved:
// the `inflight` map is checked BEFORE both the store and the fetcher,
// so a burst on a cold store still collapses to one upstream read.
//
// Persistence is optional: constructing `SourceProxy` without a `store`
// gives identical behaviour to S0 (in-memory only).

import { extractTarball } from './tar.js';
import { buildTree, type TreeEntry } from './tree.js';
import { ProxyNotFoundError } from './errors.js';
import type { BlobStore, TreeManifest } from './store.js';

/** What the proxy needs from upstream: one call, the tarball's raw
 * (gzip'd) bytes for a `(source, sha)`. Real GitHub codeload usage is
 * `GithubCodeloadFetcher` in `fetcher.ts`; tests inject a counting fake —
 * this interface is the seam that makes "no real network in tests"
 * possible without any conditional test-mode code in the proxy itself.
 *
 * Contract: throw `ProxyNotFoundError` for a DEFINITIVE "this source/sha
 * does not exist" (codeload 404). Throw anything else for a transient
 * failure (network error, 5xx, rate limit) — see `errors.ts` for why the
 * distinction is load-bearing. */
export interface TarballFetcher {
  fetchTarball(source: string, sha: string): Promise<Buffer>;
}

/** One primed source snapshot: every file's bytes, plus the derived tree
 * listing, held entirely in memory. */
interface PrimedEntry {
  files: Map<string, Buffer>;
  tree: TreeEntry[];
  /** Bytes this entry holds, computed once at prime. The eviction budget is
   * measured in the resource that actually runs out — heap — rather than in a
   * snapshot count, because snapshots differ in size by orders of magnitude. */
  bytes: number;
}

function entryBytes(files: Map<string, Buffer>): number {
  let total = 0;
  for (const [path, content] of files) {
    // The key is retained alongside the value, so it is part of what the entry
    // costs; 2 bytes/char is V8's worst case for a JS string.
    total += content.byteLength + path.length * 2;
  }
  return total;
}

export interface SourceProxyOptions {
  /** How long a negatively-cached (source, sha) 404 is remembered before
   * the next request is allowed to retry upstream. Default 60s, matching
   * the design doc's stated 404 TTL. */
  negativeTtlMs?: number;
  /** Injectable clock, so negative-cache expiry is testable without real
   * timers. Defaults to `Date.now`. */
  now?: () => number;
  /** Where a failed write-through goes. Defaults to `console.error`.
   *
   * It must go SOMEWHERE. A store write that fails costs the caller nothing —
   * the snapshot is already in memory — which is exactly why swallowing it is
   * dangerous: a bucket that is failing every write looks identical to one that
   * is working, while every cold start re-primes from upstream forever and
   * nobody is told. Injectable so a test can assert it was reported without
   * writing to the console. */
  onStoreWriteError?: (err: unknown) => void;
  /** S1: optional persistent store. When provided, a cold start reads from
   * the store before going upstream; a successful prime writes through to
   * the store. When absent the proxy behaves identically to S0. */
  store?: BlobStore;
  /** Heap budget for primed snapshots. Once exceeded, least-recently-used
   * snapshots are evicted until the total fits again. Default 128 MiB — see
   * `DEFAULT_MAX_CACHED_BYTES`. */
  maxCachedBytes?: number;
  /** How many remembered 404s to hold before evicting the oldest. Default
   * 10,000 — see `MAX_NEGATIVE_ENTRIES`. Injectable so the eviction can be
   * tested at a size a test can reach. */
  maxNegativeEntries?: number;
}

const DEFAULT_NEGATIVE_TTL_MS = 60_000;

/**
 * How much heap primed snapshots may hold before eviction starts.
 *
 * This cache used to be unbounded and process-lifetime — "present forever within
 * this process". Every distinct `(source, sha)` holds an entire repository in
 * memory, so a caller naming N shas of an allowed source could grow it without
 * limit until the instance OOMs. On Cloud Run that is a crash loop, not a slow
 * degradation: eviction is what turns a memory-exhaustion vector into a cache
 * miss.
 *
 * 128 MiB sits comfortably inside the 512 MiB default instance while still
 * holding several corpus-sized snapshots, which is the working set that matters
 * — a lens fan reading the same snapshot repeatedly. Raise it with the instance
 * size via SOURCED_MAX_CACHED_BYTES.
 */
const DEFAULT_MAX_CACHED_BYTES = 128 * 1024 * 1024;

/** Cap on remembered 404s. Bounded by TTL only in principle — an entry is
 * removed when it is next asked for, so a caller naming many bad shas would
 * otherwise grow this map for free. Small, because it holds only a timestamp. */
const DEFAULT_MAX_NEGATIVE_ENTRIES = 10_000;

function sourceKey(source: string, sha: string): string {
  return `${source}\u0000${sha}`;
}

/**
 * A content-addressed read proxy over one or more sources, keyed by
 * `(source, sha)`. First read for a given `(source, sha)` primes the whole
 * snapshot from one tarball fetch (or, in S1, from the persistent store);
 * every subsequent read — any path, any number of concurrent callers — is
 * served from the in-memory map with zero further upstream calls, until a
 * different `sha` is asked for.
 *
 * Single-flight is preserved under persistence: the `inflight` map is
 * checked before both the store and the upstream fetcher, so a burst
 * during a cold-store prime still collapses to one upstream read.
 */
export class SourceProxy {
  private readonly fetcher: TarballFetcher;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly store?: BlobStore;
  private readonly maxCachedBytes: number;
  private readonly onStoreWriteError: (err: unknown) => void;
  private readonly maxNegativeEntries: number;

  /** Successfully primed snapshots, in least-recently-used order — Map iterates
   * in insertion order, so `touch()` re-inserting on every hit makes the FIRST
   * key the coldest and eviction a walk from the front.
   *
   * Bounded by `maxCachedBytes`. Eviction here is a pure cache miss: the
   * snapshot is still in the persistent store (and upstream), so an evicted key
   * costs one re-read, never correctness. */
  private readonly primed = new Map<string, PrimedEntry>();

  /** Bytes currently held across `primed`, maintained incrementally so the
   * budget check is O(1) rather than a walk of every cached snapshot. */
  private cachedBytes = 0;

  /** In-flight primes, keyed identically to `primed`. This Map IS the
   * single-flight mechanism: every caller for the same key during a prime
   * receives (via `await`) the same pending Promise instead of starting a
   * second fetch. Entries are removed once the prime settles, success or
   * failure — a failure must not leave a stale in-flight entry that would
   * wedge every future caller. */
  private readonly inflight = new Map<string, Promise<PrimedEntry>>();

  /** DEFINITIVE not-found verdicts for a whole `(source, sha)` — the
   * tarball fetch itself 404'd (bad sha, bad repo, no read access). Never
   * populated for a transient failure; see `prime()`. */
  private readonly negativeTarball = new Map<string, number>();

  constructor(fetcher: TarballFetcher, options: SourceProxyOptions = {}) {
    this.fetcher = fetcher;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.store = options.store;
    this.maxCachedBytes = options.maxCachedBytes ?? DEFAULT_MAX_CACHED_BYTES;
    this.maxNegativeEntries = options.maxNegativeEntries ?? DEFAULT_MAX_NEGATIVE_ENTRIES;
    this.onStoreWriteError =
      options.onStoreWriteError ??
      ((err) =>
        console.error(
          `store write-through failed (serving from memory): ${err instanceof Error ? err.message : String(err)}`
        ));
  }

  /**
   * Whether `(source, sha)` can be served without an upstream fetch or a store
   * read. The request boundary uses this to price a request before doing it: a
   * hit is a map lookup and needs no throttling, a miss can cost a whole tarball
   * and does. Read-only — asking never primes anything.
   */
  isPrimed(source: string, sha: string): boolean {
    return this.primed.has(sourceKey(source, sha));
  }

  /** Bytes currently held in the in-memory snapshot cache. Exposed for the
   * health/metrics surface and for tests to assert the budget is honoured. */
  get cachedByteCount(): number {
    return this.cachedBytes;
  }

  /** Record a snapshot as most-recently-used, then evict from the cold end
   * until the cache is back inside its budget. */
  private admit(key: string, entry: PrimedEntry): void {
    const existing = this.primed.get(key);
    if (existing) this.cachedBytes -= existing.bytes;
    this.primed.delete(key);
    this.primed.set(key, entry);
    this.cachedBytes += entry.bytes;

    for (const [oldest, victim] of this.primed) {
      if (this.cachedBytes <= this.maxCachedBytes) break;
      // Never evict the entry we just admitted: the caller is about to read it,
      // and dropping it would turn every request into a re-prime once a single
      // snapshot exceeds the budget on its own.
      if (oldest === key) continue;
      this.primed.delete(oldest);
      this.cachedBytes -= victim.bytes;
    }
  }

  /** Move an existing key to the hot end of the LRU order. */
  private touch(key: string, entry: PrimedEntry): void {
    this.primed.delete(key);
    this.primed.set(key, entry);
  }

  /** Prime (or reuse the prime of) a `(source, sha)` snapshot. The whole
   * single-flight + negative-cache + persistence contract lives here;
   * `getBlob` and `getTree` are thin readers over its result. */
  private async prime(source: string, sha: string): Promise<PrimedEntry> {
    const key = sourceKey(source, sha);

    // 1. Already fully primed in memory — the fast path every request after
    // the first takes. Zero upstream cost, zero store cost.
    const done = this.primed.get(key);
    if (done) {
      this.touch(key, done);
      return done;
    }

    // 2. A definitive 404 for this exact (source, sha), still within TTL.
    // Fail fast without touching the fetcher or the in-flight map.
    const negExpiry = this.negativeTarball.get(key);
    if (negExpiry !== undefined) {
      if (this.now() < negExpiry) {
        throw new ProxyNotFoundError(`source not found (cached): ${source}@${sha}`);
      }
      this.negativeTarball.delete(key);
    }

    // 3. A prime is already in flight for this key — join it rather than
    // starting a second upstream fetch. Everything above and including
    // this check runs synchronously (no `await` yet), so a burst of
    // concurrent calls in the same microtask all observe the same map
    // state and only the first one falls through to step 4.
    const existing = this.inflight.get(key);
    if (existing) return existing;

    // 4. Nothing cached, nothing in flight: this call owns the prime.
    // Register in `inflight` synchronously (before the first `await`) so
    // any concurrent caller that arrives during the async work joins here
    // instead of starting a parallel prime.
    const attempt = this.doPrime(source, sha, key)
      .finally(() => {
        // Whether it succeeded or failed, this key is no longer in flight
        // — a failed prime must not wedge future callers behind a
        // permanently-pending promise.
        this.inflight.delete(key);
      });

    this.inflight.set(key, attempt);
    return attempt;
  }

  /** The actual prime work — reading from the store (if available) before
   * hitting upstream. Separated from `prime()` so the synchronous
   * `inflight` registration in step 4 is not interleaved with async code. */
  private async doPrime(source: string, sha: string, key: string): Promise<PrimedEntry> {
    // 4a. Persistent store hit — load from store, skip upstream entirely.
    if (this.store) {
      const fromStore = await this.loadFromStore(source, sha);
      if (fromStore) {
        this.admit(key, fromStore);
        return fromStore;
      }
    }

    // 4b. Cold start — fetch from upstream.
    try {
      const bytes = await this.fetcher.fetchTarball(source, sha);
      const files = extractTarball(bytes);
      const fileMap = new Map(files.map((f) => [f.path, f.content]));
      const entry: PrimedEntry = {
        files: fileMap,
        tree: buildTree(files),
        bytes: entryBytes(fileMap),
      };
      this.admit(key, entry);

      // Write through to the persistent store asynchronously — we don't block
      // the caller on store writes. A failure is REPORTED but not surfaced to
      // the caller: the data is already in memory, so the request succeeds, and
      // a future GC run cleans up any partial write. Reporting is what stops a
      // persistently broken store from being invisible.
      if (this.store) {
        this.writeThrough(source, sha, entry).catch((err: unknown) => {
          this.onStoreWriteError(err);
        });
      }

      return entry;
    } catch (err: unknown) {
      // Only a DEFINITIVE not-found is remembered. Any other failure
      // (network blip, 5xx, rate limit) is deliberately left unrecorded
      // so the very next call gets a fresh attempt — "an upstream failure
      // does not poison the cache".
      if (err instanceof ProxyNotFoundError) {
        // Oldest-first eviction, same Map-ordering trick as `primed`. Forgetting
        // a 404 early costs one wasted upstream call, never a wrong answer.
        if (this.negativeTarball.size >= this.maxNegativeEntries) {
          const oldest = this.negativeTarball.keys().next();
          if (!oldest.done) this.negativeTarball.delete(oldest.value);
        }
        this.negativeTarball.set(key, this.now() + this.negativeTtlMs);
      }
      throw err;
    }
  }

  /** Try to rebuild a `PrimedEntry` from the persistent store.
   * Returns `null` if the manifest or any blob is missing (treat as a
   * cache miss — go to upstream). */
  private async loadFromStore(source: string, sha: string): Promise<PrimedEntry | null> {
    const manifest = await this.store!.getTreeManifest(source, sha);
    if (!manifest) return null;

    const files = new Map<string, Buffer>();
    for (const entry of manifest.entries) {
      if (entry.type !== 'blob') continue;
      const content = await this.store!.getBlob(source, sha, entry.path);
      if (content === null) {
        // Partial write detected — treat the whole snapshot as a miss so
        // it gets re-primed from upstream cleanly.
        return null;
      }
      files.set(entry.path, content);
    }

    return { files, tree: manifest.entries, bytes: entryBytes(files) };
  }

  /** Write all blobs and the tree manifest to the persistent store.
   * Writes blobs first, then the manifest. This ordering means a partial
   * write (blobs present, manifest absent) is detectable by `loadFromStore`
   * (manifest is the gate) and treated as a miss rather than a corrupt hit. */
  private async writeThrough(source: string, sha: string, entry: PrimedEntry): Promise<void> {
    // Blobs first — so if we crash here the manifest is still absent and
    // the next load treats it as a clean miss.
    for (const [path, content] of entry.files) {
      await this.store!.putBlob(source, sha, path, content);
    }
    // Manifest last — its presence is the "all blobs are here" signal.
    const manifest: TreeManifest = {
      sourceUrl: source,
      sha,
      createdAt: new Date(this.now()).toISOString(),
      entries: entry.tree,
    };
    await this.store!.putTreeManifest(source, sha, manifest);
  }

  /** Read one file's bytes at `(source, sha, path)`. Throws
   * `ProxyNotFoundError` when the source/sha doesn't exist, or the path
   * doesn't exist within it; propagates any other error from the
   * underlying fetch unchanged (so the caller can distinguish and retry). */
  async getBlob(source: string, sha: string, path: string): Promise<Buffer> {
    const entry = await this.prime(source, sha);
    const content = entry.files.get(path);
    if (content === undefined) {
      throw new ProxyNotFoundError(`path not found: ${path} in ${source}@${sha}`);
    }
    return content;
  }

  /** The full tree listing for `(source, sha)` — files and their derived
   * directories. Same prime path as `getBlob`, so a `getTree` call and a
   * `getBlob` call for the same `(source, sha)` share one prime. */
  async getTree(source: string, sha: string): Promise<TreeEntry[]> {
    const entry = await this.prime(source, sha);
    return entry.tree;
  }
}
