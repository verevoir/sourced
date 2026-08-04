// Exercises `GithubCodeloadFetcher`'s URL-building and status-mapping with
// an injected `fetchImpl` — a fake in-process function, not a real network
// call. This is the file the task's "propose, don't run" experiment about
// codeload's rate-limit budget would extend, against the real network,
// which this suite deliberately does not do.

import { describe, it, expect } from 'vitest';
import { GithubCodeloadFetcher } from '../src/fetcher.js';
import { ProxyNotFoundError } from '../src/errors.js';

describe('GithubCodeloadFetcher', () => {
  it('requests codeload.github.com/<owner>/<repo>/tar.gz/<sha> with bearer auth', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(Buffer.from('fake-gzip-bytes'), { status: 200 });
    }) as typeof fetch;

    const fetcher = new GithubCodeloadFetcher({ token: 'test-token', fetchImpl });
    const bytes = await fetcher.fetchTarball('org/repo', 'deadbeef');

    expect(seenUrl).toBe('https://codeload.github.com/org/repo/tar.gz/deadbeef');
    expect(seenAuth).toBe('Bearer test-token');
    expect(bytes.toString('utf8')).toBe('fake-gzip-bytes');
  });

  it('maps a 404 to ProxyNotFoundError', async () => {
    const fetchImpl = (async () => new Response('', { status: 404 })) as typeof fetch;
    const fetcher = new GithubCodeloadFetcher({ fetchImpl });
    await expect(fetcher.fetchTarball('org/repo', 'nope')).rejects.toBeInstanceOf(ProxyNotFoundError);
  });

  it('rejects a source that is not owner/repo before making any request', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const fetcher = new GithubCodeloadFetcher({ fetchImpl });
    await expect(fetcher.fetchTarball('https://github.com/org/repo', 'sha1')).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('surfaces a non-404 error status as a plain (retryable) error, not ProxyNotFoundError', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as typeof fetch;
    const fetcher = new GithubCodeloadFetcher({ fetchImpl });
    const err = await fetcher.fetchTarball('org/repo', 'sha1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ProxyNotFoundError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('GithubCodeloadFetcher — the fetch is bounded', () => {
  // This is the most expensive outbound call the service makes, and it is made
  // while holding the single-flight slot for its (source, sha) — every other
  // caller for that snapshot is parked behind it. An unbounded fetch does not
  // make one request slow, it holds a whole snapshot's worth of callers open
  // and never releases the in-flight entry.

  it('passes an abort signal to the underlying fetch', async () => {
    let seenSignal: AbortSignal | null | undefined;
    const fetchImpl = (async (_input: unknown, init?: { signal?: AbortSignal | null }) => {
      seenSignal = init?.signal;
      return new Response(Buffer.from('x'), { status: 200 });
    }) as unknown as typeof fetch;

    await new GithubCodeloadFetcher({ fetchImpl, timeoutMs: 5_000 }).fetchTarball(
      'org/repo',
      'sha1'
    );
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('gives up on a request that never responds, naming the deadline', async () => {
    // A bare AbortError in a log says nothing about which call gave up or how
    // long it waited.
    const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;

    const fetcher = new GithubCodeloadFetcher({ fetchImpl, timeoutMs: 20 });
    await expect(fetcher.fetchTarball('org/repo', 'sha1')).rejects.toThrow(/exceeded 20ms/);
  });

  it('gives up on a BODY that never finishes, not just a slow response', async () => {
    // Bounding the response but not the download would leave the expensive half
    // unbounded: a tarball trickling one byte at a time would still hang the
    // prime forever.
    const fetchImpl = (async (_input: unknown, init?: { signal?: AbortSignal | null }) => ({
      status: 200,
      ok: true,
      arrayBuffer: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    })) as unknown as typeof fetch;

    const fetcher = new GithubCodeloadFetcher({ fetchImpl, timeoutMs: 20 });
    await expect(fetcher.fetchTarball('org/repo', 'sha1')).rejects.toThrow(/exceeded 20ms/);
  });

  it('does not report a timeout as not-found', async () => {
    // Load-bearing: ProxyNotFoundError is negatively cached. Mapping a transient
    // timeout onto it would make the proxy keep answering 404 for a source that
    // exists, long after the network recovered.
    const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;

    const fetcher = new GithubCodeloadFetcher({ fetchImpl, timeoutMs: 20 });
    await expect(fetcher.fetchTarball('org/repo', 'sha1')).rejects.not.toBeInstanceOf(
      ProxyNotFoundError
    );
  });
});
