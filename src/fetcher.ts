// Real `TarballFetcher` — fetches from codeload.github.com. Wires the
// proxy core to actual GitHub for anyone running the server; NOT exercised
// by any test (the task's hard constraint: no real network in tests, and
// no burst against the live API to "test" rate limiting — that experiment
// stays a proposal, see the report). `SourceProxy` itself only ever sees
// the `TarballFetcher` interface, so this file is swappable and, more
// importantly, untouched by the property tests in `tests/proxy.test.ts`.
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

export interface GithubCodeloadFetcherOptions {
  /** GitHub token — codeload honors the same bearer auth as the REST API
   * for private repos. */
  token?: string;
  /** Injectable for tests that exercise this file's URL-building /
   * status-mapping logic without hitting the network (see `tests/fetcher.test.ts`) —
   * distinct from injecting a whole fake `TarballFetcher` into `SourceProxy`,
   * which is what the proxy's own property tests do. */
  fetchImpl?: typeof fetch;
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

export class GithubCodeloadFetcher implements TarballFetcher {
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GithubCodeloadFetcherOptions = {}) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
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

    const res = await this.fetchImpl(url, { headers });
    if (res.status === 404) {
      throw new ProxyNotFoundError(`codeload: not found ${owner}/${repo}@${sha}`);
    }
    if (!res.ok) {
      throw new Error(`codeload: ${res.status} fetching ${owner}/${repo}@${sha}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
