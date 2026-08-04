# sourced

A content-addressed read proxy over Git sources.

One tarball fetch primes a whole `(source, sha)` snapshot; every subsequent read
of any path in that snapshot is served from memory. The problem it exists to
solve is a fan of agents each reading the same ~77 corpus files, over and over,
run after run — 385 upstream requests where 1 will do.

Reads are keyed on `(sourceUrl, sha, path)`. Because `sha` is a commit SHA, an
entry can never go stale, so there is no invalidation anywhere in this service —
only eviction.

## Routes

| Route                             | Purpose                                             |
| --------------------------------- | --------------------------------------------------- |
| `GET /v1/blob?source=&sha=&path=` | One file's bytes                                     |
| `GET /v1/tree?source=&sha=`       | The snapshot's entry list                            |
| `GET /healthz`, `GET /health`     | Liveness — build, revision, wired store              |

`/healthz` is **liveness only**. It does not probe GCS or GitHub: doing so would
make every probe a paid round-trip and turn a transient dependency blip into a
restart loop of a process still perfectly able to serve its cached snapshots.
Upstream health surfaces where it is observed — as a 502 on the route that needed
it.

Both spellings exist because the probe path is the platform's choice, not ours.
Note that `gcloud run services proxy` intercepts `/healthz` itself and answers it
locally, so probe a deployed instance through the proxy on `/health`.

## Configuration

All configuration is environment. The same image runs locally, in a container and
on Cloud Run; only these values differ.

| Variable                   | Required | Default  | Meaning                                                     |
| -------------------------- | -------- | -------- | ----------------------------------------------------------- |
| `SOURCED_ALLOWED_SOURCES`  | **yes**  | _(none)_ | Comma-separated `owner/repo` list this service will serve    |
| `PORT`                     | no       | `8080`   | Listen port; Cloud Run sets this                             |
| `GITHUB_TOKEN`             | no       | _(none)_ | Only needed to read private sources                          |
| `SOURCED_GCS_BUCKET`       | no       | _(none)_ | Persist snapshots to this GCS bucket                         |
| `SOURCED_FS_DIR`           | no       | _(none)_ | Persist snapshots to this directory instead                  |
| `SOURCED_SNAPSHOT_TTL_MS`  | no       | 30 min   | How long a persisted snapshot survives GC                    |
| `SOURCED_GC_INTERVAL_MS`   | no       | 5 min    | How often GC sweeps                                          |
| `SOURCED_MAX_CACHED_BYTES` | no       | 128 MiB  | Heap budget for in-memory snapshots before LRU eviction      |

Naming both `SOURCED_GCS_BUCKET` and `SOURCED_FS_DIR` is refused at startup
rather than resolved by guessing — the wrong guess writes a run's cache somewhere
nobody thinks to look. Naming neither runs in-memory, which is fine for a test
and wrong for a deployment with scale-to-zero.

`SOURCED_MAX_CACHED_BYTES` must be raised **with** the instance's memory, never
past it. The proxy evicts on this number, so setting it above what the container
actually has replaces a cache miss with an OOM.

## Security model

Two things a reader of this code needs to hold onto.

**The token is the service's, not the caller's.** `sourced` applies its own
`GITHUB_TOKEN` to whatever `source` a request names. Without an explicit
allowlist, anyone who can reach `/v1/blob` could read every private repository
that token can read — the service would be a confused deputy for its own
credential. Hence `SOURCED_ALLOWED_SOURCES`, and hence **empty means deny
everything**: a misconfiguration must cost availability, never confidentiality.
A refused source gets a 403 that does not disclose whether it exists.

**Paths are refused, not cleaned.** A single-pass strip of `../` turns
`....//foo` into `../foo` — it manufactures the traversal it was meant to remove.
Any path with a `..` segment, a leading `/`, or a NUL is rejected at the
boundary, and `blobKey` throws on the same input as a second line, because a key
builder has to be safe for every caller and not only the one that validates
first.

## Volume control

Rate limiting is **two layers, and neither is sufficient alone**.

_The edge_ is the deployment's. Cloud Run's IAM invoker check is what stops
unauthenticated volume ever reaching the container — there is deliberately no
`allUsers` binding, so an anonymous request is rejected by Google's front end and
costs this service nothing. `maxScale` caps what a flood can spend even if it is
authenticated.

_The application_ is `src/rate-limit.ts`: per-source token buckets, priced by what
an operation actually costs. A cache hit is a map lookup; a miss downloads a whole
repository and holds it in memory. So there are two budgets — a generous one for
requests in general (burst 200, 50/s) and a mean one for requests that would prime
(burst 5, 0.5/s) — and the boundary asks the proxy which kind it is before
charging. A flat rate would either throttle cheap traffic pointlessly or leave the
expensive path wide open.

Over-limit gets `429` with `Retry-After`. Buckets are per source, so one source
being hammered cannot starve another. The map they live in is bounded by
construction: only allowlisted sources ever reach it, and a denied source is
refused before it can create a bucket.

What the application layer cannot do: it is per-instance and has no view of caller
identity, so it enforces no per-principal quota and sees no distributed flood.
That is the edge's half.

## Running it

Locally, in the same image that ships:

```sh
SOURCED_ALLOWED_SOURCES=verevoir/accelerator docker compose up --build
curl 'http://localhost:8080/healthz'
curl 'http://localhost:8080/v1/tree?source=verevoir/accelerator&sha=<sha>'
```

The only difference from the deployed service is the store adapter — a mounted
volume here, a GCS bucket there — and both satisfy the same `BlobStore` port, so
the code path exercised locally is the deployed one.

Deployed: `ai-gengy-spikes` / `europe-west2`, from source via Cloud Build.

## Verifying

```sh
npm run verify   # typecheck + tests
```

`tests/resolve-merge-base.test.ts` currently has two failures that depend on the
host's locale (tracked as STDIO-637); everything else is green. They are not
caused by this package's code.
