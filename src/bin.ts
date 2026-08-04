// The composition root. Everything else in this package is a library with its
// dependencies injected; this is the one file that reads the environment, picks
// adapters and opens a socket.
//
// The SAME image runs locally and on Cloud Run — only the store adapter differs,
// and it is chosen from configuration rather than by building a second artefact.
// That is the point: the code path under test locally is the code path deployed.

import { SourceProxy } from './proxy.js';
import { GithubCodeloadFetcher } from './fetcher.js';
import { RateLimiter } from './rate-limit.js';
import { createServer, type ServiceInfo } from './server.js';
import { buildStore } from './build-store.js';
import { MaxAgePolicyMs, runGc } from './store.js';

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

// Heap ceiling for primed snapshots. Raise it WITH the instance's memory, never
// past it: the proxy evicts on this number, so setting it above what the
// container actually has replaces a cache miss with an OOM. Zero/unset takes the
// proxy's own default. See `DEFAULT_MAX_CACHED_BYTES` in proxy.ts.
const MAX_CACHED_BYTES = Number(process.env.SOURCED_MAX_CACHED_BYTES ?? 0) || undefined;

const { store, kind } = await buildStore();

const info: ServiceInfo = {
  version: process.env.npm_package_version ?? '0.1.0',
  // Cloud Run injects K_REVISION; absent locally, which is itself informative.
  revision: process.env.K_REVISION,
  store: kind,
};

// Which sources this service will serve. The token it holds is ITS credential,
// not the caller's, so without an explicit list any caller reaching /v1/blob
// could read every private repo that token can read. Empty means deny
// everything: a misconfiguration must cost availability, never confidentiality.
const allowedSources = new Set(
  (process.env.SOURCED_ALLOWED_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const proxy = new SourceProxy(new GithubCodeloadFetcher({ token: process.env.GITHUB_TOKEN }), {
  store,
  maxCachedBytes: MAX_CACHED_BYTES,
});

// The application half of the volume defence. The other half is the deployment's
// — ingress restriction, IAM invoker check and a max-instances ceiling — and
// neither is sufficient alone; see rate-limit.ts and README.md.
const rateLimiter = new RateLimiter();

const server = createServer(proxy, { info, allowedSources, rateLimiter });

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
      // Loud on purpose: a service that serves nothing looks identical to a
      // broken one from outside, and this is the likeliest misconfiguration.
      allowedSources: [...allowedSources],
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
