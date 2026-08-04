// HTTP surface: `GET /v1/blob` and `GET /v1/tree`, per the design doc.
// Deliberately thin — all the interesting behaviour is in `SourceProxy`;
// this file only parses query params, calls the proxy, and maps its
// results/errors onto HTTP status codes.
//
// `handleRequest` is exported and tested directly against synthetic
// `{method, url}` requests (see `tests/server.test.ts`) — no sockets, no
// real HTTP round-trip needed to prove the routing and status-mapping are
// correct. `createServer` is the thin `node:http` wrapper an operator
// would actually run; it is exercised by nothing but its own type-check,
// which is fine — sockets have nothing to do with S0's properties.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SourceProxy } from './proxy.js';
import { ProxyNotFoundError } from './errors.js';

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
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

function jsonResponse(status: number, body: unknown): ProxyResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
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

/** Pure request handler: `(method, url) -> response`, with no dependency on
 * `node:http` beyond the types it borrows for parsing. This is what the
 * test suite drives directly. */
export async function handleRequest(
  proxy: SourceProxy,
  method: string,
  url: string,
  info?: ServiceInfo
): Promise<ProxyResponse> {
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
      return jsonResponse(400, { error: 'bad_request', message: 'source, sha and path are required' });
    }
    try {
      const content = await proxy.getBlob(params.source, params.sha, params.path);
      return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: content };
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (parsed.pathname === '/v1/tree') {
    const params = requireParams(parsed.searchParams, ['source', 'sha']);
    if (!params) {
      return jsonResponse(400, { error: 'bad_request', message: 'source and sha are required' });
    }
    try {
      const entries = await proxy.getTree(params.source, params.sha);
      return jsonResponse(200, { entries });
    } catch (err) {
      return errorResponse(err);
    }
  }

  return jsonResponse(404, { error: 'not_found', message: `no route for ${parsed.pathname}` });
}

/** Thin `node:http` wrapper around `handleRequest` — what an operator
 * actually runs. Not exercised by the test suite (see module doc); the
 * behaviour it depends on is fully covered via `handleRequest` directly. */
export function createServer(proxy: SourceProxy, info?: ServiceInfo) {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // A throw here would take down the whole process via node:http's
    // 'uncaughtException' path, so one bad request cannot be allowed to become an
    // outage: every failure is mapped to a 500 the client can read.
    try {
      const response = await handleRequest(proxy, req.method ?? 'GET', req.url ?? '/', info);
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error', message }));
    }
  });
}
