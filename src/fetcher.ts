// Real `TarballFetcher` — fetches from codeload.github.com. Wires the proxy
// core to actual GitHub for anyone running the server.
//
// It IS covered, by `tests/fetcher.test.ts`, through the injected `fetchImpl`
// seam: URL building, status mapping, the abort signal and the timeout. What no
// test does is touch the NETWORK — the hard constraint is no real requests, and
// in particular no burst against the live API to "test" rate limiting; that
// experiment stays a proposal, see the report.
//
// `SourceProxy` itself only ever sees the `TarballFetcher` interface, so this
// file is swappable and untouched by the property tests in `tests/proxy.test.ts`.
//
// `source` here is `owner/repo` — deliberately narrower than the
// `sources/github` adapter's `parseGithubRepoUrl` (which also accepts full
// URLs and SSH form). S0 hardcodes one corpus repo per the design doc's own
// slice description ("S0 — corpus only... /v1/blob for one hardcoded
// corpus repo"); the parsing breadth that a general SourceAdapter needs is
// an S1+ concern, not this spike's.

import { ProxyNotFoundError } from './errors.js';
import type { TarballFetcher } from './proxy.js';

const CODELOAD_HOST = 'https://codeload.github.com';

/**
 * Deadline on the whole tarball fetch — connect, headers AND body.
 *
 * This is the single most expensive outbound call the service makes, and it is
 * made while holding the single-flight slot for its `(source, sha)`: every other
 * caller for that snapshot is parked behind it. Without a deadline, one stalled
 * codeload connection does not slow a request down, it holds a whole snapshot's
 * worth of callers open indefinitely and never releases the in-flight entry.
 *
 * Sixty seconds because it has to cover a large repository over a slow link, not
 * just a round-trip; anything still unfinished by then is stuck, not slow.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GithubCodeloadFetcherOptions {
  /** GitHub token — codeload honors the same bearer auth as the REST API
   * for private repos. */
  token?: string;
  /** Injectable for tests that exercise this file's URL-building /
   * status-mapping logic without hitting the network (see `tests/fetcher.test.ts`) —
   * distinct from injecting a whole fake `TarballFetcher` into `SourceProxy`,
   * which is what the proxy's own property tests do. */
  fetchImpl?: typeof fetch;
  /** Deadline for one tarball fetch. See `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** `source` is `owner/repo`. Splits and validates before it ever reaches a
 * URL, so a malformed source fails with a clear error rather than an
 * opaque codeload 404. */
function parseOwnerRepo(source: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(source.trim());
  if (!match) {
    throw new Error(`GithubCodeloadFetcher: expected "owner/repo", got ${JSON.stringify(source)}`);
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Rewrite an abort into an error that says what actually happened.
 *
 * A bare `AbortError` in a log tells an operator nothing about which call gave
 * up or how long it waited. Deliberately NOT a `ProxyNotFoundError`: a timeout
 * is transient, and mapping it to not-found would put it in the negative cache
 * and keep answering 404 for a source that exists.
 */
function asTimeoutError(err: unknown, timeoutMs: number, what: string): Error {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error(`codeload: fetching ${what} exceeded ${timeoutMs}ms`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export class GithubCodeloadFetcher implements TarballFetcher {
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GithubCodeloadFetcherOptions = {}) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** One request: `GET /<owner>/<repo>/tar.gz/<sha>`. This IS the "385
   * requests becomes 1" call — everything downstream reads from the
   * exploded result, never codeload or the contents API again for this
   * (source, sha). */
  async fetchTarball(source: string, sha: string): Promise<Buffer> {
    const { owner, repo } = parseOwnerRepo(source);
    const url = `${CODELOAD_HOST}/${owner}/${repo}/tar.gz/${encodeURIComponent(sha)}`;
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    // One signal across the request AND the body read. Timing out the response
    // but not the download would leave the expensive half unbounded — a tarball
    // that trickles a byte at a time would still hang the prime forever.
    const signal = AbortSignal.timeout(this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal });
    } catch (err) {
      throw asTimeoutError(err, this.timeoutMs, `${owner}/${repo}@${sha}`);
    }

    if (res.status === 404) {
      throw new ProxyNotFoundError(`codeload: not found ${owner}/${repo}@${sha}`);
    }
    if (!res.ok) {
      throw new Error(`codeload: ${res.status} fetching ${owner}/${repo}@${sha}`);
    }

    try {
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      throw asTimeoutError(err, this.timeoutMs, `${owner}/${repo}@${sha}`);
    }
  }
}
