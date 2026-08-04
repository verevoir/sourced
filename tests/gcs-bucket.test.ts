// Tests for GoogleCloudBucket: the GcsBucket port backed by @google-cloud/storage.
//
// All tests use a hand-written fake Storage — no vi.mock, no real GCS, no
// credentials. The fake is cast through `unknown` to the SDK type so it can
// satisfy the constructor's injection point without depending on SDK internals.
//
// The key safety properties proven here:
//  - a 404 from the SDK is silently converted to null (cache miss semantics)
//  - any other error propagates: a permission failure must never look like a miss
//  - listSnapshotPrefixes accumulates prefixes across EVERY page: with autoPaginate
//    on the SDK hands back only the last page's apiResponse and the earlier pages'
//    prefixes are silently dropped — the manual page walk is what prevents that
//  - operations respect a hard timeout deadline

import { describe, it, expect } from 'vitest';
import type { Storage } from '@google-cloud/storage';
import { GoogleCloudBucket } from '../src/gcs-bucket.js';

// ---------------------------------------------------------------------------
// Fake Storage
// ---------------------------------------------------------------------------

interface FakeFile {
  download(): Promise<[Buffer]>;
  save(content: Buffer, opts: { contentType: string; resumable: boolean }): Promise<void>;
}

interface FakeBucketObject {
  file(key: string): FakeFile;
  getFiles(query: Record<string, unknown>): Promise<[unknown[], Record<string, unknown> | null, unknown]>;
  deleteFiles(opts: { prefix: string; force: boolean }): Promise<void>;
}

/** Build a minimal fake Storage whose behaviour is controlled by the test. */
function makeFakeStorage(
  bucketFactory: (name: string) => FakeBucketObject
): Storage {
  return {
    bucket(name: string) {
      return bucketFactory(name);
    },
  } as unknown as Storage;
}

/** The simplest in-memory bucket: upload/download over a Map. */
function makeSimpleBucket(): FakeBucketObject & { objects: Map<string, Buffer>; savedOpts: Map<string, { contentType: string; resumable: boolean }> } {
  const objects = new Map<string, Buffer>();
  const savedOpts = new Map<string, { contentType: string; resumable: boolean }>();
  return {
    objects,
    savedOpts,
    file(key: string): FakeFile {
      return {
        async download() {
          const data = objects.get(key);
          if (!data) {
            const err: Error & { code?: number } = new Error('Not found');
            err.code = 404;
            throw err;
          }
          return [data];
        },
        async save(content, opts) {
          objects.set(key, content);
          savedOpts.set(key, opts);
        },
      };
    },
    async getFiles(_query) {
      return [[], null, {}];
    },
    async deleteFiles(opts) {
      for (const key of [...objects.keys()]) {
        if (key.startsWith(opts.prefix)) objects.delete(key);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

describe('GoogleCloudBucket — download', () => {
  it('returns the bytes when the SDK resolves with data', async () => {
    // A non-null return on a hit is the normal fast path for a warm cache.
    const inner = makeSimpleBucket();
    inner.objects.set('some/key', Buffer.from('hello'));
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => inner),
    });
    const result = await bucket.download('some/key');
    expect(result).toEqual(Buffer.from('hello'));
  });

  it('returns null when the SDK rejects with code 404', async () => {
    // A cold snapshot miss is the normal path and must never surface as an error —
    // callers test for null to distinguish a miss from a hit.
    const inner = makeSimpleBucket(); // no objects → download throws 404
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => inner),
    });
    const result = await bucket.download('missing/key');
    expect(result).toBeNull();
  });

  it('propagates errors that are not 404 (e.g. 403 permission denied)', async () => {
    // A permissions failure swallowed as null would make a broken bucket read as
    // an empty one, causing every request to re-prime from upstream and silently
    // discarding every snapshot already stored.
    const permError: Error & { code?: number } = new Error('Permission denied');
    permError.code = 403;
    const inner: FakeBucketObject = {
      file(_key) {
        return {
          async download() { throw permError; },
          async save() { /* no-op */ },
        };
      },
      async getFiles(_q) { return [[], null, {}]; },
      async deleteFiles(_opts) { /* no-op */ },
    };
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => inner),
    });
    await expect(bucket.download('some/key')).rejects.toMatchObject({ code: 403 });
  });

  it('rejects with a timeout message when the download never settles', async () => {
    // An outbound call with no deadline can hold a socket open until the
    // instance runs out of connections, turning a single slow GCS object into a
    // whole-service outage. The timeout converts that into a bounded error.
    const neverSettle: FakeBucketObject = {
      file(_key) {
        return {
          download(): Promise<[Buffer]> { return new Promise(() => { /* never */ }); },
          async save() { /* no-op */ },
        };
      },
      async getFiles(_q) { return [[], null, {}]; },
      async deleteFiles(_opts) { /* no-op */ },
    };
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => neverSettle),
      timeoutMs: 20,
    });
    await expect(bucket.download('slow/key')).rejects.toThrow(/exceeded 20ms/);
  });

  it('does not reject when the download settles inside the deadline', async () => {
    // A call that completes in time must succeed — the timeout must not fire
    // eagerly and must not leave a lingering timer that keeps the process alive.
    const inner = makeSimpleBucket();
    inner.objects.set('fast/key', Buffer.from('data'));
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => inner),
      timeoutMs: 5_000,
    });
    const result = await bucket.download('fast/key');
    expect(result).toEqual(Buffer.from('data'));
  });
});

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

describe('GoogleCloudBucket — upload', () => {
  it('passes the contentType through and sets resumable: false', async () => {
    // resumable: false is required so small uploads go through a single HTTP
    // request rather than the resumable upload protocol, which requires a
    // pre-flight round-trip and state on the server side.
    const inner = makeSimpleBucket();
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => inner),
    });
    await bucket.upload('blobs/key', Buffer.from('content'), 'application/octet-stream');
    expect(inner.savedOpts.get('blobs/key')).toMatchObject({
      contentType: 'application/octet-stream',
      resumable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// listSnapshotPrefixes — pagination
// ---------------------------------------------------------------------------

describe('GoogleCloudBucket — listSnapshotPrefixes', () => {
  /**
   * A fake bucket whose getFiles returns multiple pages driven by pageToken.
   * Page 1: prefixes A, B → nextQuery = { pageToken: 'page2', autoPaginate: false }
   * Page 2: prefixes C   → nextQuery = { pageToken: 'page3', autoPaginate: false }
   * Page 3: prefixes D   → nextQuery = null (last page)
   */
  function makePagedBucket(capturedQueries: Record<string, unknown>[]): FakeBucketObject {
    const pages: Array<{ prefixes: string[]; nextToken: string | null }> = [
      { prefixes: ['snapshots/aaa/', 'snapshots/bbb/'], nextToken: 'page2' },
      { prefixes: ['snapshots/ccc/'],                   nextToken: 'page3' },
      { prefixes: ['snapshots/ddd/'],                   nextToken: null   },
    ];
    const tokenIndex: Record<string, number> = {
      '':      0, // first call has no token
      page2:   1,
      page3:   2,
    };
    return {
      file(_key) {
        return {
          async download(): Promise<[Buffer]> { return [Buffer.alloc(0)]; },
          async save() { /* no-op */ },
        };
      },
      async getFiles(query) {
        capturedQueries.push({ ...query });
        const token = String(query['pageToken'] ?? '');
        const idx = tokenIndex[token] ?? 0;
        const page = pages[idx]!;
        const nextQuery = page.nextToken
          ? { pageToken: page.nextToken, autoPaginate: false }
          : null;
        const apiResponse = { prefixes: page.prefixes };
        return [[], nextQuery, apiResponse];
      },
      async deleteFiles(_opts) { /* no-op */ },
    };
  }

  it('accumulates prefixes across every page', async () => {
    // With autoPaginate on, the SDK returns only the last page's apiResponse
    // and silently drops the earlier pages' prefixes — GC would only ever see
    // the tail of the bucket. The manual walk is what prevents that.
    const queries: Record<string, unknown>[] = [];
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makePagedBucket(queries)),
    });
    const prefixes = await bucket.listSnapshotPrefixes();
    // Returned WITHOUT the trailing delimiter GCS puts on a common prefix: runGc
    // appends '/_tree.json' to these, and the extra slash produced a key that
    // matched no object — GC then read every manifest as missing, which means
    // KEEP, so it silently collected nothing.
    expect(prefixes).toEqual(expect.arrayContaining([
      'snapshots/aaa',
      'snapshots/bbb',
      'snapshots/ccc',
      'snapshots/ddd',
    ]));
    expect(prefixes).toHaveLength(4);
  });

  it('passes autoPaginate: false on every request', async () => {
    // autoPaginate: true is the SDK default and is what causes prefixes to be
    // silently dropped. This assertion is the reason the manual walk exists.
    const queries: Record<string, unknown>[] = [];
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makePagedBucket(queries)),
    });
    await bucket.listSnapshotPrefixes();
    for (const q of queries) {
      expect(q['autoPaginate']).toBe(false);
    }
  });

  it('de-duplicates a prefix that appears on more than one page', async () => {
    // The same snapshot prefix can theoretically appear in multiple pages (e.g.
    // if GCS pages are not strictly partitioned). Returning it twice would cause
    // GC to attempt a double-delete of the same snapshot.
    const dupBucket: FakeBucketObject = (() => {
      let calls = 0;
      return {
        file(_key) {
          return {
            async download(): Promise<[Buffer]> { return [Buffer.alloc(0)]; },
            async save() { /* no-op */ },
          };
        },
        async getFiles(_q) {
          calls++;
          if (calls === 1) {
            return [[], { pageToken: 'p2', autoPaginate: false }, { prefixes: ['snapshots/dup/'] }];
          }
          return [[], null, { prefixes: ['snapshots/dup/', 'snapshots/other/'] }];
        },
        async deleteFiles(_opts) { /* no-op */ },
      };
    })();

    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => dupBucket),
    });
    const prefixes = await bucket.listSnapshotPrefixes();
    const dupCount = prefixes.filter((p) => p === 'snapshots/dup').length;
    expect(dupCount).toBe(1);
  });

  it('stops after a bounded number of pages if the fake never returns a falsy nextQuery', async () => {
    // An infinite pagination loop would hang the GC run. Stopping early is safe
    // (GC is allowed to keep too much); hanging is not.
    let pageCount = 0;
    const infiniteBucket: FakeBucketObject = {
      file(_key) {
        return {
          async download(): Promise<[Buffer]> { return [Buffer.alloc(0)]; },
          async save() { /* no-op */ },
        };
      },
      async getFiles(q) {
        pageCount++;
        const next = { ...(q as Record<string, unknown>), pageToken: `page${pageCount + 1}`, autoPaginate: false };
        return [[], next, { prefixes: [`snapshots/snap${pageCount}/`] }];
      },
      async deleteFiles(_opts) { /* no-op */ },
    };

    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => infiniteBucket),
    });

    // Must resolve (not hang) within the test timeout.
    const prefixes = await bucket.listSnapshotPrefixes();

    // It should have walked at most MAX_LIST_PAGES pages and then returned.
    expect(prefixes.length).toBeGreaterThan(0);
    expect(pageCount).toBeLessThanOrEqual(100);
  });

  it('rejects with a timeout message when listSnapshotPrefixes never settles', async () => {
    // Same concern as download: an outbound call with no deadline can hold an
    // entire GC run open indefinitely.
    const neverSettle: FakeBucketObject = {
      file(_key) {
        return {
          async download(): Promise<[Buffer]> { return new Promise(() => { /* never */ }); },
          async save() { /* no-op */ },
        };
      },
      getFiles(_q): Promise<[unknown[], Record<string, unknown> | null, unknown]> {
        return new Promise(() => { /* never */ });
      },
      async deleteFiles(_opts) { /* no-op */ },
    };
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => neverSettle),
      timeoutMs: 20,
    });
    await expect(bucket.listSnapshotPrefixes()).rejects.toThrow(/exceeded 20ms/);
  });
});

describe('GoogleCloudBucket — the page walk is bounded in wall-clock too', () => {
  // A per-page deadline alone permits MAX_LIST_PAGES × timeoutMs, which is most
  // of an hour. The page cap catches a pathological bucket; this catches a
  // merely slow one.

  /** A bucket whose pages never run out, advancing the clock on every call. */
  function makeEndlessBucket(clock: { t: number }, msPerPage: number): FakeBucketObject {
    let page = 0;
    return {
      file(_key) {
        return {
          async download(): Promise<[Buffer]> {
            return [Buffer.alloc(0)];
          },
          async save() {},
        };
      },
      async getFiles() {
        clock.t += msPerPage;
        page++;
        return [[], { pageToken: `p${page}`, autoPaginate: false }, { prefixes: [`snapshots/p${page}/`] }];
      },
      async deleteFiles() {},
    };
  }

  it('stops at the listing budget rather than walking every page', async () => {
    const clock = { t: 0 };
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makeEndlessBucket(clock, 10)),
      listBudgetMs: 50,
      onTruncated: () => {},
      now: () => clock.t,
    });

    const prefixes = await bucket.listSnapshotPrefixes();
    // 50ms at 10ms a page — far short of the 100-page cap.
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.length).toBeLessThan(20);
  });

  it('reports the truncation instead of returning a short list silently', async () => {
    // A truncated listing looks exactly like a complete one, and GC keeps what
    // it cannot see — so the bucket grows a tail nobody is told about.
    const clock = { t: 0 };
    const warnings: string[] = [];
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makeEndlessBucket(clock, 10)),
      listBudgetMs: 50,
      onTruncated: (m) => warnings.push(m),
      now: () => clock.t,
    });

    await bucket.listSnapshotPrefixes();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/budget/);
  });

  it('reports truncation at the page cap as well as at the budget', async () => {
    // The two bounds catch different failures and both need to be visible; a
    // fast bucket with a huge number of snapshots hits the cap, never the clock.
    const warnings: string[] = [];
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makeEndlessBucket({ t: 0 }, 0)),
      listBudgetMs: 60_000,
      onTruncated: (m) => warnings.push(m),
      now: () => 0,
    });

    const prefixes = await bucket.listSnapshotPrefixes();
    expect(prefixes).toHaveLength(100); // MAX_LIST_PAGES
    expect(warnings[0]).toMatch(/page cap/);
  });

  it('says nothing when the listing completes', async () => {
    // The warning must not fire on an ordinary listing, or a healthy sweep is
    // indistinguishable from a degraded one.
    const warnings: string[] = [];
    const queries: Record<string, unknown>[] = [];
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makePagedBucketForBudgetTest(queries)),
      onTruncated: (m) => warnings.push(m),
    });

    await bucket.listSnapshotPrefixes();
    expect(warnings).toHaveLength(0);
  });

  /** A two-page bucket that terminates properly. */
  function makePagedBucketForBudgetTest(captured: Record<string, unknown>[]): FakeBucketObject {
    let page = 0;
    return {
      file(_key) {
        return {
          async download(): Promise<[Buffer]> {
            return [Buffer.alloc(0)];
          },
          async save() {},
        };
      },
      async getFiles(query) {
        captured.push({ ...query });
        page++;
        const last = page >= 2;
        return [
          [],
          last ? null : { pageToken: 'p2', autoPaginate: false },
          { prefixes: [`snapshots/x${page}/`] },
        ];
      },
      async deleteFiles() {},
    };
  }
});

describe('GoogleCloudBucket — every method is bounded, not just the read path', () => {
  // The class doc says "every method is bounded by timeoutMs", and the writes
  // are where an unbounded call bites hardest: `upload` runs inside the
  // write-through of a prime, and `deletePrefix` inside a GC sweep whose own
  // budget is only checked BETWEEN snapshots — so a wedged delete stalls the
  // sweep past any budget the sweep itself can enforce.

  /** A bucket where nothing but `download` ever settles. */
  function makeStuckWriter(): FakeBucketObject {
    return {
      file(_key) {
        return {
          async download(): Promise<[Buffer]> {
            return [Buffer.alloc(0)];
          },
          save(): Promise<void> {
            return new Promise(() => {
              /* never */
            });
          },
        };
      },
      async getFiles(_q) {
        return [[], null, {}];
      },
      deleteFiles(_opts): Promise<void> {
        return new Promise(() => {
          /* never */
        });
      },
    };
  }

  it('gives up on an upload that never completes', async () => {
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makeStuckWriter()),
      timeoutMs: 20,
    });
    await expect(
      bucket.upload('blobs/key', Buffer.from('x'), 'application/octet-stream')
    ).rejects.toThrow(/exceeded 20ms/);
  });

  it('gives up on a prefix delete that never completes', async () => {
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makeStuckWriter()),
      timeoutMs: 20,
    });
    await expect(bucket.deletePrefix('snapshots/abc/')).rejects.toThrow(/exceeded 20ms/);
  });

  it('names the operation it gave up on', async () => {
    // A bare "timed out" in a log leaves an operator guessing which of four
    // calls stalled and against which key.
    const bucket = new GoogleCloudBucket({
      bucket: 'test-bucket',
      storage: makeFakeStorage(() => makeStuckWriter()),
      timeoutMs: 20,
    });
    await expect(bucket.deletePrefix('snapshots/abc/')).rejects.toThrow(/snapshots\/abc\//);
  });
});
