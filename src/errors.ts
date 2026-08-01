// Error vocabulary for the proxy core.
//
// Two, and only two, kinds of failure matter to `SourceProxy.prime`:
//
//  - `ProxyNotFoundError` — a DEFINITIVE verdict. The (source, sha) does not
//    exist upstream (codeload 404s a bad sha/repo), or a path does not exist
//    within an already-primed tree. Safe to cache negatively: asking again
//    will not get a different answer until the caller names a different sha.
//  - anything else — TRANSIENT or unclassified (network blip, 5xx, a rate
//    limit). Must never be cached: the whole point of "an upstream failure
//    does not poison the cache" is that the next call gets a fresh attempt.
//
// This mirrors the same two-bucket shape `capabilities/src/tools/provision.ts`
// uses for corpus reads (`isTransient` / `isRateLimited`) — a real permission
// or not-found verdict fails fast and stays failed; everything else is worth
// retrying. S0 does not need that module's retry/backoff machinery (that is
// a client-side concern, orthogonal to the proxy's cache), only the same
// two-way split on what gets remembered.
export class ProxyNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyNotFoundError';
  }
}
