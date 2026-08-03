// S2 — RefResolver port tests.
//
// Every test uses `StubRefResolver` — no git binary, no network. The
// `GitLsRemoteRefResolver` real implementation is NOT exercised here
// (it calls a real remote); the seam is the `RefResolver` interface.
// Gaps declared: `GitLsRemoteRefResolver`'s subprocess parsing is covered
// by its own contract — the stub covers the port's contract instead.

import { describe, it, expect } from 'vitest';
import {
  StubRefResolver,
  RefResolutionError,
  type RefResolver,
} from '../src/resolver.js';

// ---------------------------------------------------------------------------
// StubRefResolver — port conformance
// ---------------------------------------------------------------------------

describe('StubRefResolver — resolves a registered ref to its SHA', () => {
  it('returns the SHA registered for (source, ref)', async () => {
    const resolver = new StubRefResolver().register(
      'https://github.com/org/repo',
      'main',
      'a'.repeat(40),
    );

    const sha = await resolver.resolveRef('https://github.com/org/repo', 'main');

    expect(sha).toBe('a'.repeat(40));
  });

  it('records every resolution call in order', async () => {
    const resolver = new StubRefResolver()
      .register('https://github.com/org/repo', 'main', 'a'.repeat(40))
      .register('https://github.com/org/repo', 'v1.0.0', 'b'.repeat(40));

    await resolver.resolveRef('https://github.com/org/repo', 'main');
    await resolver.resolveRef('https://github.com/org/repo', 'v1.0.0');

    expect(resolver.calls).toEqual([
      { source: 'https://github.com/org/repo', ref: 'main' },
      { source: 'https://github.com/org/repo', ref: 'v1.0.0' },
    ]);
  });

  it('different (source, ref) pairs resolve independently', async () => {
    const resolver = new StubRefResolver()
      .register('https://github.com/org/repo-a', 'main', 'a'.repeat(40))
      .register('https://github.com/org/repo-b', 'main', 'b'.repeat(40));

    const shaA = await resolver.resolveRef('https://github.com/org/repo-a', 'main');
    const shaB = await resolver.resolveRef('https://github.com/org/repo-b', 'main');

    expect(shaA).toBe('a'.repeat(40));
    expect(shaB).toBe('b'.repeat(40));
    expect(shaA).not.toBe(shaB);
  });
});

describe('StubRefResolver — throws RefResolutionError for unresolvable refs', () => {
  it('throws RefResolutionError for a ref that was never registered', async () => {
    const resolver = new StubRefResolver();

    await expect(
      resolver.resolveRef('https://github.com/org/repo', 'missing-branch'),
    ).rejects.toBeInstanceOf(RefResolutionError);
  });

  it('throws RefResolutionError with the source and ref set on the error', async () => {
    const resolver = new StubRefResolver();
    const source = 'https://github.com/org/repo';
    const ref = 'no-such-branch';

    const error = await resolver
      .resolveRef(source, ref)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RefResolutionError);
    const re = error as RefResolutionError;
    expect(re.source).toBe(source);
    expect(re.ref).toBe(ref);
  });

  it('throws RefResolutionError for a ref explicitly registered as a failure', async () => {
    const resolver = new StubRefResolver().registerFailure(
      'https://github.com/org/repo',
      'deleted-branch',
      'branch was deleted',
    );

    await expect(
      resolver.resolveRef('https://github.com/org/repo', 'deleted-branch'),
    ).rejects.toBeInstanceOf(RefResolutionError);
  });

  it('still records the call even when resolution fails', async () => {
    const resolver = new StubRefResolver();

    await resolver
      .resolveRef('https://github.com/org/repo', 'ghost')
      .catch(() => undefined);

    expect(resolver.calls).toEqual([{ source: 'https://github.com/org/repo', ref: 'ghost' }]);
  });
});

describe('StubRefResolver — satisfies the RefResolver interface structurally', () => {
  it('is assignable to RefResolver without a cast', () => {
    // This is a compile-time assertion expressed as a runtime no-op.
    // If StubRefResolver diverges from RefResolver, TypeScript rejects
    // this assignment and the typecheck gate fails.
    const _: RefResolver = new StubRefResolver();
    void _;
  });
});

// ---------------------------------------------------------------------------
// RefResolutionError
// ---------------------------------------------------------------------------

describe('RefResolutionError', () => {
  it('carries source, ref, and message', () => {
    const err = new RefResolutionError('could not reach remote', 'https://github.com/org/repo', 'main');

    expect(err.name).toBe('RefResolutionError');
    expect(err.message).toBe('could not reach remote');
    expect(err.source).toBe('https://github.com/org/repo');
    expect(err.ref).toBe('main');
  });

  it('carries a cause when provided', () => {
    const cause = new Error('ECONNREFUSED');
    const err = new RefResolutionError('network error', 'https://github.com/org/repo', 'main', cause);

    expect(err.cause).toBe(cause);
  });

  it('is an instance of Error', () => {
    const err = new RefResolutionError('x', 'src', 'ref');
    expect(err).toBeInstanceOf(Error);
  });
});
