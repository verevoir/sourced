// The `GcsBucket` port, implemented over @google-cloud/storage.
//
// `store.ts` defines GcsBucket as a four-method structural interface precisely so
// the storage SDK is not a dependency of the core — the proxy, the policy and the
// tests all work against the port. This file is the only place the SDK appears.

import { Storage } from '@google-cloud/storage';
import type { GcsBucket } from './store.js';

export interface GoogleCloudBucketOptions {
  /** Bucket name. */
  bucket: string;
  /** Injectable for tests; defaults to ADC, which is what Cloud Run provides. */
  storage?: Storage;
}

/**
 * A `GcsBucket` backed by a real GCS bucket.
 *
 * Content is addressed by `(sourceUrl, sha, path)` and therefore immutable, which
 * is what makes every operation here safe to repeat: an upload is last-writer-wins
 * over identical bytes, and a delete is only ever issued by GC against a snapshot
 * the policy has already judged expired.
 */
export class GoogleCloudBucket implements GcsBucket {
  private readonly bucket;

  constructor(opts: GoogleCloudBucketOptions) {
    const storage = opts.storage ?? new Storage();
    this.bucket = storage.bucket(opts.bucket);
  }

  async download(key: string): Promise<Buffer | null> {
    try {
      const [buf] = await this.bucket.file(key).download();
      return buf;
    } catch (err) {
      // A miss is the normal path for a cold snapshot, so it must be `null` rather
      // than an error — every other failure (permissions, network) must still
      // propagate, or a broken bucket would read as an empty one and silently
      // re-prime on every request.
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async upload(key: string, content: Buffer, contentType: string): Promise<void> {
    await this.bucket.file(key).save(content, { contentType, resumable: false });
  }

  async listSnapshotPrefixes(): Promise<string[]> {
    // delimiter gives common prefixes rather than every object, so this stays one
    // page-walk over snapshot roots instead of a full listing of the bucket.
    const [, , apiResponse] = await this.bucket.getFiles({
      prefix: 'snapshots/',
      delimiter: '/',
      autoPaginate: true,
    });
    const prefixes = (apiResponse as { prefixes?: string[] } | undefined)?.prefixes ?? [];
    return prefixes;
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.bucket.deleteFiles({ prefix, force: true });
  }
}

/** GCS reports a missing object as a 404; the SDK surfaces that as `code`. */
function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 404;
}
