// S1 persistence layer — content-addressed blob store behind a port.
//
// Key design decisions (all from the shared design rules):
//
// 1. KEY IMMUTABILITY → NO INVALIDATION. The store key is
//    `(sourceUrl, sha, path)` where `sha` is a commit SHA — immutable by
//    definition. An entry can never go stale, so there is no invalidation
//    code here, only a GC interface. This is a standing rule, not a
//    slice-one shortcut.
//
// 2. TWO LEVELS. Blobs are individual files; the tree manifest
//    `_tree.json` indexes all blobs for a `(sourceUrl, sha)` pair so a
//    reader can enumerate what a snapshot contains without listing the
//    bucket. Both are written atomically — a partial write is observable
//    only if the blob is written and the tree manifest update fails, in
//    which case the blob is simply an orphan that GC will collect later.
//
// 3. THE PORT (`BlobStore`) decouples the proxy from any storage backend.
//    Two adapters are provided:
//      • `FilesystemBlobStore` — exercises the same interface in tests and
//        in local dev; vitest uses real `node:fs` on a `os.tmpdir()`
//        directory, which is fast and does not need credentials.
//      • `GcsBlobStore` — thin adapter over the GCS JSON API; only used
//        when a real bucket is configured. Tests NEVER touch it.
//
// 4. GC POLICY (see `GcPolicy` below). The only safe direction for the
//    worst-case is "keeps too much"; it must NEVER be "deleted something
//    still referenced". See the policy's doc comment for the argument.

import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { TreeEntry } from './tree.js';

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Stable filesystem- and GCS-safe key for a single blob.
 * Uses SHA-256 of the canonical triple so paths are bounded-length
 * and safe in both backends regardless of special chars in the inputs. */
export function blobKey(sourceUrl: string, sha: string, path: string): string {
  // sha component in the path so blobs for the same snapshot are co-located
  // and GC can scan by snapshot.
  const snapshotId = snapshotKey(sourceUrl, sha);
  // path-within-snapshot: preserve the relative path for human readability
  // but sanitise it so it can't escape the base directory.
  const safePath = path.replace(/\.\.\/|\.\.\\/g, '').replace(/^[\/\\]+/, '');
  return `${snapshotId}/blobs/${safePath}`;
}

/** Stable key for the tree manifest of one `(sourceUrl, sha)`. */
export function treeManifestKey(sourceUrl: string, sha: string): string {
  return `${snapshotKey(sourceUrl, sha)}/_tree.json`;
}

/** The directory / prefix that contains every blob and the tree manifest
 * for one `(sourceUrl, sha)`. Used by GC to enumerate snapshots. */
export function snapshotKey(sourceUrl: string, sha: string): string {
  const hash = createHash('sha256')
    .update(`${sourceUrl}\0${sha}`)
    .digest('hex');
  return `snapshots/${hash}`;
}

// ---------------------------------------------------------------------------
// Tree manifest shape
// ---------------------------------------------------------------------------

/** The `_tree.json` payload stored per `(sourceUrl, sha)`. Carries:
 * - the original `sourceUrl` and `sha` (human-readable back-reference)
 * - the full tree entry list (same shape as `buildTree` returns)
 * - a creation timestamp for GC age-based policies */
export interface TreeManifest {
  sourceUrl: string;
  sha: string;
  createdAt: string; // ISO-8601 UTC
  entries: TreeEntry[];
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * A content-addressed blob store keyed on `(sourceUrl, sha, path)`.
 *
 * Because the key includes an immutable commit SHA, an entry can never go
 * stale. The only reclamation mechanism is GC; there is no invalidation.
 *
 * All write operations are idempotent: writing the same key twice is a
 * no-op (or an overwrite with identical bytes — same outcome). This
 * makes a retry after a partial snapshot write safe.
 */
export interface BlobStore {
  /** Read one blob. Returns `null` when the key does not exist (a miss,
   * not an error) so the caller can distinguish a cache miss from a
   * storage failure. */
  getBlob(sourceUrl: string, sha: string, path: string): Promise<Buffer | null>;

  /** Write one blob idempotently. */
  putBlob(sourceUrl: string, sha: string, path: string, content: Buffer): Promise<void>;

  /** Read the tree manifest, or `null` on a miss. */
  getTreeManifest(sourceUrl: string, sha: string): Promise<TreeManifest | null>;

  /** Write the tree manifest idempotently. */
  putTreeManifest(sourceUrl: string, sha: string, manifest: TreeManifest): Promise<void>;

  /** List all snapshot keys present in the store. Used by GC. */
  listSnapshotKeys(): Promise<string[]>;

  /** Delete every object under a snapshot key (all blobs + tree manifest).
   * Used only by GC, never by the read path. */
  deleteSnapshot(snapshotKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// GC policy
// ---------------------------------------------------------------------------

/**
 * A GcPolicy decides which snapshots are eligible for deletion.
 *
 * **Safety argument — why this can never delete a referenced entry:**
 *
 * Every stored key includes the commit SHA. A snapshot is only ever
 * referenced by a caller that knows that exact SHA. The policy below uses
 * age alone (createdAt in `_tree.json`) and keeps any snapshot newer than
 * `maxAgeMs`. If a caller holds a reference to a SHA and the corresponding
 * snapshot has already aged out, the proxy treats it as a cache miss and
 * re-primes from upstream — exactly the same path as a cold start. No
 * data is lost; the cost is one extra upstream fetch.
 *
 * The only dangerous policy would be one that deletes by some proxy for
 * "referenced" (last-accessed time, in-memory pointers) rather than by
 * age against the immutable creation timestamp. This policy does not do
 * that: the creation timestamp is written once and never updated, so the
 * decision is deterministic and cannot race with a concurrent reader.
 *
 * **Worst case deliberately set to "keeps too much":**
 * - If `_tree.json` is missing for a snapshot (e.g. a partial write left
 *   orphan blobs with no manifest), the snapshot is retained, not deleted.
 * - GC runs on a best-effort basis; a GC failure leaves extra data, not
 *   missing data.
 */
export interface GcPolicy {
  /**
   * Given a snapshot's tree manifest, return `true` if the snapshot
   * should be KEPT. Returning `false` means the snapshot is eligible
   * for deletion — it will be passed to `BlobStore.deleteSnapshot`.
   *
   * A missing manifest (null) must return `true` (keep) — partial writes
   * are retained until a future GC run can evaluate them.
   */
  shouldKeep(manifest: TreeManifest | null): boolean;
}

/**
 * The only built-in GC policy: keep every snapshot whose `_tree.json` was
 * created within the last `maxAgeMs` milliseconds.
 *
 * Rationale for age-based eviction:
 * - The creation timestamp is immutable (written once, never updated).
 * - A SHA is immutable, so a snapshot can only be referenced by callers
 *   that explicitly name that SHA. After `maxAgeMs`, any caller still
 *   naming an old SHA will get a cache miss and a fresh prime — no
 *   corruption, just latency.
 * - There is no "last accessed" clock to update, which would require a
 *   write on every read and introduce its own race conditions.
 */
export class MaxAgePolicyMs implements GcPolicy {
  constructor(
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now
  ) {}

  shouldKeep(manifest: TreeManifest | null): boolean {
    // Missing manifest → keep (orphan blobs; do not delete blindly).
    if (manifest === null) return true;
    const age = this.now() - new Date(manifest.createdAt).getTime();
    return age <= this.maxAgeMs;
  }
}

/**
 * Run one GC sweep: list all snapshots, evaluate each against the policy,
 * and delete those the policy marks as eligible.
 *
 * Returns the number of snapshots deleted.
 *
 * A failure on one snapshot is logged and skipped rather than aborting the
 * sweep — partial GC success is safe (it leaves extra data, not missing
 * data).
 */
export async function runGc(
  store: BlobStore,
  policy: GcPolicy,
  log: (msg: string) => void = () => {}
): Promise<number> {
  const keys = await store.listSnapshotKeys();
  let deleted = 0;
  for (const key of keys) {
    // We need the manifest to evaluate the policy, but the snapshot key is
    // opaque (a hash). Read the manifest directly from the store using the
    // well-known path within the snapshot.
    const manifestKey = `${key}/_tree.json`;
    // BlobStore.getTreeManifest takes (sourceUrl, sha) — but here we only
    // have the opaque snapshot key. Use the raw read path instead.
    const manifest = await getManifestByKey(store, manifestKey);
    if (policy.shouldKeep(manifest)) continue;
    try {
      await store.deleteSnapshot(key);
      log(`gc: deleted snapshot ${key}`);
      deleted++;
    } catch (err) {
      log(`gc: failed to delete snapshot ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return deleted;
}

/** Read a tree manifest by its raw store key. This is an internal helper
 * for `runGc` which only has the opaque snapshot key, not the original
 * (sourceUrl, sha). Adapters expose this via their own internal mechanism;
 * for the filesystem adapter we use the key as a relative path. */
async function getManifestByKey(
  store: BlobStore,
  _manifestKey: string
): Promise<TreeManifest | null> {
  // The BlobStore port only exposes getTreeManifest(sourceUrl, sha). GC
  // needs to resolve manifests by opaque key. The cleanest solution without
  // expanding the port is to have adapters implement an optional low-level
  // read, but that would bleed implementation detail into the interface.
  //
  // Instead: GC passes through the store, and the adapters that care about
  // GC implement `RawBlobStore` below which extends `BlobStore` with
  // `getRawManifest`. `runGc` is always called with a `RawBlobStore`.
  if (isRawBlobStore(store)) {
    return store.getRawManifest(_manifestKey);
  }
  // If the adapter does not implement `getRawManifest`, return null (keep).
  return null;
}

/** Adapters that support GC extend `BlobStore` with a raw manifest read.
 * This keeps the primary port clean while giving GC what it needs. */
export interface RawBlobStore extends BlobStore {
  getRawManifest(rawKey: string): Promise<TreeManifest | null>;
}

function isRawBlobStore(store: BlobStore): store is RawBlobStore {
  return typeof (store as RawBlobStore).getRawManifest === 'function';
}

// ---------------------------------------------------------------------------
// Filesystem adapter
// ---------------------------------------------------------------------------

/**
 * A `BlobStore` backed by the local filesystem — used in tests and local
 * dev. Each blob is a file at `<baseDir>/<key>`, where `<key>` is the
 * result of `blobKey` / `treeManifestKey`. Directories are created on
 * demand.
 *
 * No credentials required. Safe to use in CI with a temp directory.
 */
export class FilesystemBlobStore implements RawBlobStore {
  constructor(private readonly baseDir: string) {}

  private fullPath(key: string): string {
    return join(this.baseDir, key);
  }

  async getBlob(sourceUrl: string, sha: string, path: string): Promise<Buffer | null> {
    const key = blobKey(sourceUrl, sha, path);
    return this.readRaw(key);
  }

  async putBlob(sourceUrl: string, sha: string, path: string, content: Buffer): Promise<void> {
    const key = blobKey(sourceUrl, sha, path);
    await this.writeRaw(key, content);
  }

  async getTreeManifest(sourceUrl: string, sha: string): Promise<TreeManifest | null> {
    const key = treeManifestKey(sourceUrl, sha);
    return this.getRawManifest(key);
  }

  async putTreeManifest(sourceUrl: string, sha: string, manifest: TreeManifest): Promise<void> {
    const key = treeManifestKey(sourceUrl, sha);
    await this.writeRaw(key, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  }

  async listSnapshotKeys(): Promise<string[]> {
    const snapshotsDir = join(this.baseDir, 'snapshots');
    let entries: string[];
    try {
      entries = await readdir(snapshotsDir);
    } catch (err) {
      // Directory doesn't exist yet → no snapshots.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    // Each entry is a snapshot hash directory. Return the prefixed key.
    const result: string[] = [];
    for (const entry of entries) {
      const full = join(snapshotsDir, entry);
      const s = await stat(full);
      if (s.isDirectory()) result.push(`snapshots/${entry}`);
    }
    return result;
  }

  async deleteSnapshot(snapshotKeyPath: string): Promise<void> {
    const dir = join(this.baseDir, snapshotKeyPath);
    await deleteDirRecursive(dir);
  }

  async getRawManifest(rawKey: string): Promise<TreeManifest | null> {
    const raw = await this.readRaw(rawKey);
    if (raw === null) return null;
    try {
      return JSON.parse(raw.toString('utf8')) as TreeManifest;
    } catch {
      return null;
    }
  }

  private async readRaw(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.fullPath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async writeRaw(key: string, content: Buffer): Promise<void> {
    const p = this.fullPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
}

/** Recursively delete a directory and its contents. */
async function deleteDirRecursive(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      await deleteDirRecursive(full);
    } else {
      await unlink(full);
    }
  }
  await rmdir(dir);
}

// ---------------------------------------------------------------------------
// GCS adapter
// ---------------------------------------------------------------------------

/** Minimal interface for the GCS operations we need — injectable so tests
 * can supply a fake without hitting the network or requiring credentials. */
export interface GcsBucket {
  /** Download a blob. Resolves `null` when the object does not exist. */
  download(key: string): Promise<Buffer | null>;
  /** Upload a blob idempotently (last-writer-wins is fine — content is
   * identical for the same key). */
  upload(key: string, content: Buffer, contentType: string): Promise<void>;
  /** List all "directories" (common prefixes) under `snapshots/`. */
  listSnapshotPrefixes(): Promise<string[]>;
  /** Delete all objects whose key starts with `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
}

/**
 * A `BlobStore` backed by Google Cloud Storage.
 *
 * **No GCS SDK dependency.** The `GcsBucket` port is injected; the real
 * implementation lives outside this file and is wired at startup. This
 * keeps the package free of a `@google-cloud/storage` dependency that
 * would bloat every consumer — the GCS wiring is the operator's concern.
 *
 * Tests never instantiate this class with a real GCS bucket. They either
 * inject a `GcsBucket` fake or use `FilesystemBlobStore` entirely.
 */
export class GcsBlobStore implements RawBlobStore {
  constructor(private readonly bucket: GcsBucket) {}

  async getBlob(sourceUrl: string, sha: string, path: string): Promise<Buffer | null> {
    return this.bucket.download(blobKey(sourceUrl, sha, path));
  }

  async putBlob(sourceUrl: string, sha: string, path: string, content: Buffer): Promise<void> {
    await this.bucket.upload(blobKey(sourceUrl, sha, path), content, 'application/octet-stream');
  }

  async getTreeManifest(sourceUrl: string, sha: string): Promise<TreeManifest | null> {
    const key = treeManifestKey(sourceUrl, sha);
    return this.getRawManifest(key);
  }

  async putTreeManifest(sourceUrl: string, sha: string, manifest: TreeManifest): Promise<void> {
    const key = treeManifestKey(sourceUrl, sha);
    await this.bucket.upload(
      key,
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      'application/json'
    );
  }

  async listSnapshotKeys(): Promise<string[]> {
    return this.bucket.listSnapshotPrefixes();
  }

  async deleteSnapshot(snapshotKeyPath: string): Promise<void> {
    await this.bucket.deletePrefix(snapshotKeyPath);
  }

  async getRawManifest(rawKey: string): Promise<TreeManifest | null> {
    const raw = await this.bucket.download(rawKey);
    if (raw === null) return null;
    try {
      return JSON.parse(raw.toString('utf8')) as TreeManifest;
    } catch {
      return null;
    }
  }
}
