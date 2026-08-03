// S2 — ResolvedSnapshot: the one-SHA-per-run handle.
//
// DESIGN
// ------
// A `ResolvedSnapshot` is the evidence that ref resolution has already
// happened. The proxy's `getBlob` / `getTree` methods accept ONLY a
// `ResolvedSnapshot`, never a raw (source, ref) pair. A caller cannot
// accidentally read from two different SHAs in one run — not because they
// remembered a convention, but because the type does not let them pass two
// different SHAs to the same snapshot handle.
//
// The stamp (`resolvedAt`, `ref`) lets a consumer record WHICH snapshot a
// run read and distinguish two runs against "main" an hour apart:
//
//   { source: 'https://github.com/org/repo', ref: 'main',
//     sha: 'a3f...', resolvedAt: '2025-01-15T09:00:00.000Z' }
//
//   { source: 'https://github.com/org/repo', ref: 'main',
//     sha: 'd9b...', resolvedAt: '2025-01-15T10:00:00.000Z' }
//
// The two objects are visibly different despite the same `source` and `ref`.
//
// CALL SITE
// ---------
// `resolveSnapshot()` is the one place where a mutable ref becomes an
// immutable handle. It should be called ONCE, at claim time (the
// dispatcher's moment). Every downstream read in the run passes the same
// handle — the proxy never sees the ref again after this call.

import type { RefResolver } from './resolver.js';
import type { SourceProxy } from './proxy.js';
import type { TreeEntry } from './tree.js';

// ---------------------------------------------------------------------------
// Handle type
// ---------------------------------------------------------------------------

/** An immutable record of a resolved snapshot.
 *
 * - `source` + `sha` are the key the proxy uses to retrieve content.
 * - `ref` is the mutable ref that was resolved (for audit / display).
 * - `resolvedAt` is the ISO-8601 wall-clock instant of resolution (for
 *    distinguishing two runs against the same ref at different times).
 *
 * This object is safe to serialise (e.g. into a run record) and compare
 * across runs. Two `ResolvedSnapshot` objects with different `sha` values
 * always describe different trees, regardless of `ref`. */
export interface ResolvedSnapshot {
  /** The source identifier (URL, `owner/repo`, etc.) — identical to what
   * was passed to `resolveSnapshot`. */
  readonly source: string;
  /** The mutable ref that was resolved — for audit and display. */
  readonly ref: string;
  /** The immutable 40-hex commit SHA this snapshot was resolved to. */
  readonly sha: string;
  /** ISO-8601 instant at which the ref was resolved. */
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Resolution helper
// ---------------------------------------------------------------------------

/** Resolve a mutable `ref` to an immutable `ResolvedSnapshot`, then return
 * a reader bound to that snapshot.
 *
 * Call this ONCE, at claim time. Pass the returned `SnapshotReader` to
 * every downstream operation — the `ref` is never consulted again.
 *
 * Throws `RefResolutionError` if the ref cannot be resolved. There is no
 * fallback; see `resolver.ts` for the rationale. */
export async function resolveSnapshot(
  resolver: RefResolver,
  proxy: SourceProxy,
  source: string,
  ref: string,
  now: () => string = () => new Date().toISOString(),
): Promise<SnapshotReader> {
  const sha = await resolver.resolveRef(source, ref);
  const snapshot: ResolvedSnapshot = {
    source,
    ref,
    sha,
    resolvedAt: now(),
  };
  return new SnapshotReader(proxy, snapshot);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** A read-only view over one resolved snapshot.
 *
 * Every method on this object is bound to the SAME `(source, sha)` pair —
 * the pair that was fixed at resolution time. There is no way to pass a
 * different SHA to a `SnapshotReader` after construction; the one-snapshot
 * invariant is structural, not a convention.
 *
 * Single-flight is preserved: concurrent reads through ANY `SnapshotReader`
 * for the same `(source, sha)` share the same underlying prime, because they
 * all go through the same `SourceProxy` instance. */
export class SnapshotReader {
  /** The resolved snapshot this reader is bound to. */
  readonly snapshot: ResolvedSnapshot;

  private readonly proxy: SourceProxy;

  constructor(proxy: SourceProxy, snapshot: ResolvedSnapshot) {
    this.proxy = proxy;
    this.snapshot = snapshot;
  }

  /** Read one file's bytes from this snapshot. Throws `ProxyNotFoundError`
   * if the path does not exist within the snapshot. */
  getBlob(path: string): Promise<Buffer> {
    return this.proxy.getBlob(this.snapshot.source, this.snapshot.sha, path);
  }

  /** The full tree listing for this snapshot. */
  getTree(): Promise<TreeEntry[]> {
    return this.proxy.getTree(this.snapshot.source, this.snapshot.sha);
  }
}
