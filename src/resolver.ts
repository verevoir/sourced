// S2 — RefResolver port: turn a mutable ref (branch name, tag, HEAD) into
// an immutable commit SHA, once, at the start of a run.
//
// DESIGN NOTES
//
// Where resolution belongs
// ------------------------
// The port (`RefResolver`) and the real implementation
// (`GitLsRemoteRefResolver`) live here because this package owns the seam
// and needs to supply the test double. But the CALL belongs to the caller —
// resolution happens at "claim time" (the dispatcher's moment), not inside
// any per-read code path. `SourceProxy.getBlob` / `getTree` deliberately do
// NOT accept a mutable ref; they only accept a resolved `ResolvedSnapshot`
// handle (see `snapshot.ts`). That is not a convention a caller can forget
// — it is structural.
//
// What happens when resolution fails
// ------------------------------------
// `resolveRef` throws `RefResolutionError` on failure (network down, unknown
// branch, bad credentials). A run that silently fell back to a stale SHA
// would read a snapshot NOBODY ASKED FOR — which is worse than failing,
// because the caller cannot tell they are reading the wrong tree. Failing
// outright is the correct choice: the dispatcher can surface the error and
// reschedule. No silent fallback, no stale-SHA reuse, no default.
//
// Zero runtime dependencies
// -------------------------
// The real implementation uses `node:child_process` (`git ls-remote`) —
// a Node built-in, no npm dependency. Tests inject a `StubRefResolver` that
// never touches the network. The package's zero-runtime-dependency count is
// preserved.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Thrown by `RefResolver.resolveRef` when the ref cannot be resolved to a
 * SHA — the remote is unreachable, the branch does not exist, credentials are
 * missing, or any other condition that makes the result unknowable.
 *
 * This is ALWAYS a hard failure. Do not catch and substitute a cached SHA:
 * a run reading the wrong snapshot is worse than a run that does not start. */
export class RefResolutionError extends Error {
  constructor(
    message: string,
    /** The source URL / repo identifier that was queried. */
    public readonly source: string,
    /** The ref that could not be resolved. */
    public readonly ref: string,
    /** The underlying cause, if any. */
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RefResolutionError';
  }
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/** Turns a mutable ref into an immutable commit SHA.
 *
 * Implementations must:
 * - Return the full 40-hex commit SHA that `ref` currently points to.
 * - Throw `RefResolutionError` for EVERY failure — unknown ref, unreachable
 *   remote, bad credentials. No silent fallback, no partial result.
 * - Be callable exactly once per run (callers must not cache the result and
 *   call again later expecting the same answer — the ref may have moved). */
export interface RefResolver {
  resolveRef(source: string, ref: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

export interface GitLsRemoteRefResolverOptions {
  /** Override the `git` binary path. Defaults to `'git'`. */
  gitBin?: string;
}

/** Resolves a ref by running `git ls-remote <url> <ref>` as a child process.
 * Uses the caller's ambient git credential helpers; no token management here.
 *
 * `source` must be a URL that `git ls-remote` can address
 * (e.g. `https://github.com/owner/repo`). The interpretation of `source` as
 * a URL is this implementation's contract; the `RefResolver` port itself is
 * source-format-agnostic. */
export class GitLsRemoteRefResolver implements RefResolver {
  private readonly gitBin: string;

  constructor(options: GitLsRemoteRefResolverOptions = {}) {
    this.gitBin = options.gitBin ?? 'git';
  }

  async resolveRef(source: string, ref: string): Promise<string> {
    let stdout: string;
    try {
      const result = await execFileAsync(this.gitBin, ['ls-remote', source, ref]);
      stdout = result.stdout;
    } catch (err: unknown) {
      throw new RefResolutionError(
        `git ls-remote failed for ${source} ref ${JSON.stringify(ref)}: ${err instanceof Error ? err.message : String(err)}`,
        source,
        ref,
        err,
      );
    }

    // ls-remote output is tab-separated: "<sha>\t<refname>\n" per matching
    // ref. We take the first match — if the caller passes an ambiguous ref
    // (e.g. both a branch and a tag named the same thing) the git default
    // applies: refs/heads precedes refs/tags.
    const line = stdout.split('\n').find((l) => l.trim() !== '');
    if (!line) {
      throw new RefResolutionError(
        `ref ${JSON.stringify(ref)} not found in ${source}`,
        source,
        ref,
      );
    }

    const sha = line.split('\t')[0]?.trim() ?? '';
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new RefResolutionError(
        `git ls-remote returned unexpected output for ${source} ref ${JSON.stringify(ref)}: ${JSON.stringify(line)}`,
        source,
        ref,
      );
    }

    return sha;
  }
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

/** A deterministic, in-memory `RefResolver` for tests. Populate `entries`
 * with `(source, ref) → sha` mappings; any lookup that is not in the map
 * throws `RefResolutionError` as the real implementation would for an
 * unknown ref.
 *
 * Callers that want to observe resolution calls can read `calls`. */
export class StubRefResolver implements RefResolver {
  /** Recorded resolution attempts, in order. */
  readonly calls: Array<{ source: string; ref: string }> = [];

  /** Map from `"<source>\0<ref>"` to a SHA (or an Error to throw). */
  private readonly entries = new Map<string, string | Error>();

  /** Register a successful resolution. */
  register(source: string, ref: string, sha: string): this {
    this.entries.set(this.key(source, ref), sha);
    return this;
  }

  /** Register a resolution that will throw `RefResolutionError`. */
  registerFailure(source: string, ref: string, message?: string): this {
    this.entries.set(
      this.key(source, ref),
      new RefResolutionError(
        message ?? `ref ${JSON.stringify(ref)} not found in ${source} (stub)`,
        source,
        ref,
      ),
    );
    return this;
  }

  async resolveRef(source: string, ref: string): Promise<string> {
    this.calls.push({ source, ref });
    const value = this.entries.get(this.key(source, ref));
    if (value === undefined) {
      throw new RefResolutionError(
        `ref ${JSON.stringify(ref)} not registered in StubRefResolver for ${source}`,
        source,
        ref,
      );
    }
    if (value instanceof Error) throw value;
    return value;
  }

  private key(source: string, ref: string): string {
    return `${source}\0${ref}`;
  }
}
