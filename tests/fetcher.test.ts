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
