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
  url: string
): Promise<ProxyResponse> {
  if (method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  // A base is required by WHATWG URL for a relative input; the value is
  // never used (only `.pathname`/`.searchParams` are read), so any origin
  // does.
  const parsed = new URL(url, 'http://sourced.internal');

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
export function createServer(proxy: SourceProxy) {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const response = await handleRequest(proxy, req.method ?? 'GET', req.url ?? '/');
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
}
