// HTTP surface: `GET /v1/blob`, `GET /v1/tree` and `GET /healthz`.
//
// The retrieval logic lives in `SourceProxy`; what lives HERE is everything that
// is only true at the request boundary — the trust decisions. Which sources this
// service will lend its credential to, which paths it refuses outright, how much
// volume one source may spend, and how a failure is rendered to a caller. None of
// those belong in the proxy, because none of them are properties of retrieval.
//
// `handleRequest` is exported and tested directly against synthetic
// `{method, url}` requests (see `tests/server.test.ts`) — no sockets, no real HTTP
// round-trip needed to prove routing, refusal and status-mapping are correct.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { SourceProxy } from './proxy.js';
import { ProxyNotFoundError } from './errors.js';
import type { RateLimiter } from './rate-limit.js';

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Everything the request boundary needs that the library cannot know. */
export interface ServerOptions {
  info?: ServiceInfo;
  /**
   * Sources this service will fetch, as `owner/repo`.
   *
   * LOAD-BEARING, not a convenience. The service applies its OWN `GITHUB_TOKEN`
   * to whatever `source` a caller names, so without this a caller who can reach
   * `/v1/blob` can read every private repository that token can read — the
   * service becomes a confused deputy for its own credential.
   *
   * Absent or empty means DENY EVERYTHING. Failing closed is the only safe
   * default for a credential-bearing proxy: a misconfiguration must cost
   * availability, never confidentiality. S0's design says the same thing in
   * different words — "/v1/blob for one hardcoded corpus repo".
   */
  allowedSources?: ReadonlySet<string>;
  /**
   * Volume control. Optional because the library is usable without it and the
   * tests are clearer for being able to leave it out — but the composition root
   * always supplies one, and a deployment without it has no application-layer
   * backstop at all. See `rate-limit.ts` for what it does and does not cover.
   */
  rateLimiter?: RateLimiter;
}

/** What `/healthz` reports: up, which build, and which store is wired in.
 * Supplied by the composition root, because the server itself has no way to
 * know any of it. */
export interface ServiceInfo {
  /** Package version of the running build. */
  version: string;
  /** Deployment identity where the platform provides one (Cloud Run revision). */
  revision?: string;
  /** Which persistence adapter this process was started with. */
  store: 'memory' | 'filesystem' | 'gcs';
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): ProxyResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function errorResponse(err: unknown): ProxyResponse {
  if (err instanceof ProxyNotFoundError) {
    return jsonResponse(404, { error: 'not_found', message: err.message });
  }
  return jsonResponse(502, {
    error: 'upstream_error',
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Required `source`/`sha` query params, plus any others named in `extra`.
 * Returns `null` (rather than throwing) when one is missing, so the caller
 * can render a uniform 400 instead of every route hand-rolling the check. */
function requireParams(
  params: URLSearchParams,
  names: readonly string[]
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = params.get(name);
    if (!value) return null;
    out[name] = value;
  }
  return out;
}

/**
 * Refuse any source not explicitly allowed, and say nothing about why beyond
 * that it is not served — whether a given private repo exists is not this
 * service's to disclose.
 *
 * Returns a response to send, or `null` to continue.
 */
function denySource(
  source: string,
  allowed: ReadonlySet<string> | undefined
): ProxyResponse | null {
  if (allowed && allowed.has(source)) return null;
  return jsonResponse(403, {
    error: 'source_not_allowed',
    message: 'this service does not serve that source',
  });
}

/**
 * Refuse a path that could escape its snapshot, rather than trying to clean it.
 *
 * Sanitising is what produced the hole this replaces: a single-pass strip of
 * `../` turns `....//foo` into `../foo` — it MANUFACTURES the traversal it was
 * meant to remove. Rejection has no such failure mode, and a caller has no
 * legitimate reason to ask for a path outside the tree it just listed.
 */
/**
 * Charge a request against its source's budget, and refuse it if that budget is
 * spent — with a `Retry-After` the caller can act on, rather than a bare error
 * that invites an immediate retry.
 *
 * `expensive` is asked of the proxy rather than assumed, so the price matches
 * what the request will actually cost: a resident snapshot is a map lookup, a
 * cold one is a whole repository fetched and held.
 *
 * Called AFTER `denySource` on purpose. A refused source costs a Set lookup, so
 * it needs no throttle — and keying a bucket by an arbitrary caller-supplied
 * string would hand an attacker an unbounded map, which is the exhaustion this
 * is here to prevent.
 */
function denyVolume(
  limiter: RateLimiter | undefined,
  source: string,
  expensive: boolean
): ProxyResponse | null {
  if (!limiter) return null;
  const verdict = limiter.check(source, expensive);
  if (verdict.allowed) return null;
  return jsonResponse(
    429,
    {
      error: 'rate_limited',
      message: `too many ${verdict.limit === 'primes' ? 'uncached snapshot requests' : 'requests'} for this source`,
      retryAfterSeconds: verdict.retryAfterSeconds,
    },
    { 'retry-after': String(verdict.retryAfterSeconds) }
  );
}

function denyPath(path: string): ProxyResponse | null {
  const normalised = path.replace(/\\/g, '/');
  const traversal = normalised.split('/').some((seg) => seg === '..');
  const absolute = normalised.startsWith('/');
  const nulByte = path.includes('\0');
  if (traversal || absolute || nulByte) {
    return jsonResponse(400, {
      error: 'bad_request',
      message: 'path must be relative to the snapshot and contain no ".." segment',
    });
  }
  return null;
}

/** Pure request handler: `(method, url) -> response`, with no dependency on
 * `node:http` beyond the types it borrows for parsing. This is what the
 * test suite drives directly. */
export async function handleRequest(
  proxy: SourceProxy,
  method: string,
  url: string,
  opts: ServerOptions = {}
): Promise<ProxyResponse> {
  const { info, allowedSources, rateLimiter } = opts;
  if (method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  // A base is required by WHATWG URL for a relative input; the value is
  // never used (only `.pathname`/`.searchParams` are read), so any origin
  // does.
  const parsed = new URL(url, 'http://sourced.internal');

  // LIVENESS, deliberately not a dependency probe. It answers "am I up, which
  // build am I, and what am I wired to" without touching GCS or GitHub.
  //
  // Probing the store here would make every liveness check a paid round-trip and
  // turn a transient dependency blip into a restart loop — the platform would kill
  // a process that is perfectly capable of serving the cached snapshots it already
  // holds. Upstream health is reported where it is actually observed: a failing
  // fetch surfaces as a 502 on the route that needed it.
  // Both spellings, because the probe path is the platform's choice, not ours:
  // k8s and Cloud Run conventionally use /healthz, many load balancers and
  // compose healthchecks use /health. One image runs in all of them, so it
  // answers to both rather than making the deployment carry the difference.
  if (parsed.pathname === '/healthz' || parsed.pathname === '/health') {
    return jsonResponse(200, {
      status: 'ok',
      version: info?.version ?? 'unknown',
      revision: info?.revision ?? null,
      store: info?.store ?? 'unknown',
      checks: 'liveness only — this endpoint does not probe the store or upstream',
    });
  }

  if (parsed.pathname === '/v1/blob') {
    const params = requireParams(parsed.searchParams, ['source', 'sha', 'path']);
    if (!params) {
      return jsonResponse(400, {
        error: 'bad_request',
        message: 'source, sha and path are required',
      });
    }
    const denied = denySource(params.source, allowedSources);
    if (denied) return denied;
    const badPath = denyPath(params.path);
    if (badPath) return badPath;
    const throttled = denyVolume(
      rateLimiter,
      params.source,
      !proxy.isPrimed(params.source, params.sha)
    );
    if (throttled) return throttled;
    try {
      const content = await proxy.getBlob(params.source, params.sha, params.path);
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: content,
      };
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (parsed.pathname === '/v1/tree') {
    const params = requireParams(parsed.searchParams, ['source', 'sha']);
    if (!params) {
      return jsonResponse(400, {
        error: 'bad_request',
        message: 'source and sha are required',
      });
    }
    const denied = denySource(params.source, allowedSources);
    if (denied) return denied;
    const throttled = denyVolume(
      rateLimiter,
      params.source,
      !proxy.isPrimed(params.source, params.sha)
    );
    if (throttled) return throttled;
    try {
      const entries = await proxy.getTree(params.source, params.sha);
      return jsonResponse(200, { entries });
    } catch (err) {
      return errorResponse(err);
    }
  }

  return jsonResponse(404, {
    error: 'not_found',
    message: `no route for ${parsed.pathname}`,
  });
}

/** The `node:http` wrapper around `handleRequest` — what an operator actually
 * runs. It adds one behaviour of its own, the catch-all below, which is covered
 * by `tests/server.test.ts` driving a real socket; everything else it does is
 * `handleRequest`, tested directly. */
export function createServer(proxy: SourceProxy, opts: ServerOptions = {}) {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // A throw here would take down the whole process via node:http's
    // 'uncaughtException' path, so one bad request cannot be allowed to become an
    // outage: every failure is mapped to a 500 the client can read.
    try {
      const response = await handleRequest(proxy, req.method ?? 'GET', req.url ?? '/', opts);
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error', message }));
    }
  });
}
