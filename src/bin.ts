// The composition root. Everything else in this package is a library with its
// dependencies injected; this is the one file that reads the environment, picks
// adapters and opens a socket.
//
// The SAME image runs locally and on Cloud Run — only the store adapter differs,
// and it is chosen from configuration rather than by building a second artefact.
// That is the point: the code path under test locally is the code path deployed.

import { SourceProxy } from './proxy.js';
import { GithubCodeloadFetcher } from './fetcher.js';
import { createServer, type ServiceInfo } from './server.js';
import {
  FilesystemBlobStore,
  GcsBlobStore,
  MaxAgePolicyMs,
  runGc,
  type BlobStore,
} from './store.js';

const PORT = Number(process.env.PORT ?? 8080);

// Minutes, not days — and the reason decides the number.
//
// What this cache exists for is the same file being read thirty times inside one
// working window: five lens agents each pulling the same ~77 corpus files, over
// and over, run after run. It is NOT long-term storage. Nothing downstream needs
// a snapshot to survive the burst that wanted it.
//
// That bounds the useful TTL to roughly the length of a burst plus the gap between
// bursts, which is minutes. Holding longer costs storage and buys nothing: a miss
// is one tarball fetch, and spike 619 measured that fetch at ZERO against the
// GitHub REST budget, so retention never buys quota — only latency and bandwidth.
// The design's original "lifecycle age > 30d" predates that measurement.
//
// Note this TTL only governs COLD instances: `SourceProxy` keeps primed snapshots
// in-process for the life of the process, so a warm instance is unaffected by it.
// With scale-to-zero the store is what a re-started instance reads instead of
// re-priming from upstream — which is the whole reason it is not memory-only.
const SNAPSHOT_TTL_MS = Number(process.env.SOURCED_SNAPSHOT_TTL_MS ?? 30 * 60_000);
const GC_INTERVAL_MS = Number(process.env.SOURCED_GC_INTERVAL_MS ?? 5 * 60_000);

async function buildStore(): Promise<{ store?: BlobStore; kind: ServiceInfo['store'] }> {
  const bucket = process.env.SOURCED_GCS_BUCKET?.trim();
  const dir = process.env.SOURCED_FS_DIR?.trim();

  // Explicit over clever: naming both is a configuration mistake, and guessing
  // which was meant would silently write a run's cache somewhere nobody expects.
  if (bucket && dir) {
    throw new Error('configure SOURCED_GCS_BUCKET or SOURCED_FS_DIR, not both');
  }
  if (bucket) {
    // Imported lazily so the storage SDK is never loaded — or required to
    // authenticate — by a filesystem-backed or in-memory run. This is a dynamic
    // import, not require: the package is ESM and require is not defined here.
    const { GoogleCloudBucket } = await import('./gcs-bucket.js');
    return { store: new GcsBlobStore(new GoogleCloudBucket({ bucket })), kind: 'gcs' };
  }
  if (dir) return { store: new FilesystemBlobStore(dir), kind: 'filesystem' };
  return { store: undefined, kind: 'memory' };
}

const { store, kind } = await buildStore();

const info: ServiceInfo = {
  version: process.env.npm_package_version ?? '0.1.0',
  // Cloud Run injects K_REVISION; absent locally, which is itself informative.
  revision: process.env.K_REVISION,
  store: kind,
};

const proxy = new SourceProxy(new GithubCodeloadFetcher({ token: process.env.GITHUB_TOKEN }), {
  store,
});

const server = createServer(proxy, info);

// GC only runs where there is something durable to collect: an in-memory run has
// no store to sweep, and a sweep against `undefined` would be a no-op that still
// logged as though it had done work.
let gcTimer: NodeJS.Timeout | undefined;
if (store) {
  const policy = new MaxAgePolicyMs(SNAPSHOT_TTL_MS);
  const sweep = async () => {
    try {
      const deleted = await runGc(store, policy, (m) => console.log(m));
      if (deleted > 0) console.log(`gc: swept ${deleted} expired snapshot(s)`);
    } catch (err) {
      // A failed sweep costs storage, never correctness — the cache stays
      // servable, so this must not take the process down.
      console.error(`gc: sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  gcTimer = setInterval(sweep, GC_INTERVAL_MS);
  gcTimer.unref(); // never hold the process open for a sweep
}

server.listen(PORT, () => {
  console.log(
    JSON.stringify({
      msg: 'sourced listening',
      port: PORT,
      store: kind,
      version: info.version,
      revision: info.revision ?? null,
      snapshotTtlMs: SNAPSHOT_TTL_MS,
      gcIntervalMs: store ? GC_INTERVAL_MS : null,
      authenticated: Boolean(process.env.GITHUB_TOKEN), // whether, never what
    })
  );
});

// Cloud Run sends SIGTERM and then waits; closing the listener lets in-flight
// requests finish instead of being cut off mid-response.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received — closing`);
    if (gcTimer) clearInterval(gcTimer);
    server.close(() => process.exit(0));
  });
}
