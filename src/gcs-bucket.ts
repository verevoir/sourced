// The `GcsBucket` port, implemented over @google-cloud/storage.
//
// `store.ts` defines GcsBucket as a four-method structural interface precisely so
// the storage SDK is not a dependency of the core — the proxy, the policy and the
// tests all work against the port. This file is the only place the SDK appears.

import { Storage } from '@google-cloud/storage';
import type { GcsBucket } from './store.js';

/**
 * Hard ceiling on any single bucket operation.
 *
 * Every call here is an outbound network call, and an outbound call with no
 * deadline can hold a request open until the instance runs out of sockets — one
 * slow dependency becoming a whole-service outage. Thirty seconds is generous
 * for an object read and mean enough to fail before Cloud Run's own request
 * deadline, so a stuck GCS call surfaces as a 502 the caller can retry rather
 * than as a hung connection the platform eventually kills.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Pages to walk before giving up on a listing. Bounds GC's worst case: a
 * bucket with a pathological number of snapshots costs a bounded number of API
 * calls per sweep, and the next sweep picks up where cost cut this one short.
 * GC is allowed to keep too much (see `GcPolicy`), so stopping early is safe. */
const MAX_LIST_PAGES = 100;

export interface GoogleCloudBucketOptions {
  /** Bucket name. */
  bucket: string;
  /** Injectable for tests; defaults to ADC, which is what Cloud Run provides. */
  storage?: Storage;
  /** Ceiling on any one operation. See `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * A `GcsBucket` backed by a real GCS bucket.
 *
 * Content is addressed by `(sourceUrl, sha, path)` and therefore immutable, which
 * is what makes every operation here safe to repeat: an upload is last-writer-wins
 * over identical bytes, and a delete is only ever issued by GC against a snapshot
 * the policy has already judged expired.
 *
 * Every method is bounded by `timeoutMs`. The SDK is also configured with its own
 * per-attempt and total deadlines, but `withDeadline` is what the caller can
 * actually rely on: it bounds the promise this class returns, whatever the SDK
 * does underneath.
 */
export class GoogleCloudBucket implements GcsBucket {
  private readonly bucket;
  private readonly timeoutMs: number;

  constructor(opts: GoogleCloudBucketOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const storage =
      opts.storage ??
      new Storage({
        // Per-attempt deadline...
        timeout: this.timeoutMs,
        // ...and a ceiling on the SDK's own retries, so a retried operation
        // cannot quietly outlast the budget a single attempt was given.
        retryOptions: { totalTimeout: this.timeoutMs },
      });
    this.bucket = storage.bucket(opts.bucket);
  }

  async download(key: string): Promise<Buffer | null> {
    try {
      const [buf] = await this.withDeadline(`download ${key}`, this.bucket.file(key).download());
      return buf;
    } catch (err) {
      // A miss is the normal path for a cold snapshot, so it must be `null` rather
      // than an error — every other failure (permissions, network, timeout) must
      // still propagate, or a broken bucket would read as an empty one and
      // silently re-prime on every request.
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async upload(key: string, content: Buffer, contentType: string): Promise<void> {
    await this.withDeadline(
      `upload ${key}`,
      this.bucket.file(key).save(content, { contentType, resumable: false })
    );
  }

  async listSnapshotPrefixes(): Promise<string[]> {
    // delimiter gives common prefixes rather than every object, so this walks
    // snapshot roots instead of listing every blob in the bucket.
    //
    // autoPaginate is deliberately OFF. With it on, the SDK concatenates the
    // FILES across pages but hands back only the LAST page's apiResponse — and
    // the prefixes live on apiResponse, so every page but the last is silently
    // dropped. GC would then only ever see the tail of the bucket and quietly
    // stop collecting the rest. Walking the pages by hand is the only way to
    // accumulate prefixes correctly.
    const prefixes = new Set<string>();
    let query: Record<string, unknown> = {
      prefix: 'snapshots/',
      delimiter: '/',
      autoPaginate: false,
    };

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const [, nextQuery, apiResponse] = await this.withDeadline(
        `list snapshots (page ${page + 1})`,
        this.bucket.getFiles(query)
      );
      for (const p of (apiResponse as { prefixes?: string[] } | undefined)?.prefixes ?? []) {
        prefixes.add(p);
      }
      if (!nextQuery) return [...prefixes];
      query = { ...(nextQuery as Record<string, unknown>), autoPaginate: false };
    }

    return [...prefixes];
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.withDeadline(`delete ${prefix}`, this.bucket.deleteFiles({ prefix, force: true }));
  }

  /**
   * Bound a bucket operation, so no single call can hold a request open forever.
   *
   * This bounds the WAIT, not the underlying socket: a timed-out operation may
   * still complete in the background. That is deliberate and harmless here —
   * every operation is idempotent over immutable content, so a late upload
   * writes identical bytes and a late delete targets a snapshot GC already
   * judged expired.
   */
  private withDeadline<T>(what: string, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`gcs: ${what} exceeded ${this.timeoutMs}ms`)),
        this.timeoutMs
      );
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }
}

/** GCS reports a missing object as a 404; the SDK surfaces that as `code`. */
function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 404;
}
