import { describe, it, expect } from 'vitest';
import { SourceProxy, type TarballFetcher } from '../src/proxy.js';
import { handleRequest } from '../src/server.js';
import { buildFakeTarballGz } from './helpers/tarball.js';

function makeProxy(): SourceProxy {
  const fetcher: TarballFetcher = {
    async fetchTarball() {
      return buildFakeTarballGz([
        { path: 'src/index.ts', content: 'export const a = 1;\n' },
        { path: 'README.md', content: '# hi\n' },
      ]);
    },
  };
  return new SourceProxy(fetcher);
}

describe('handleRequest — /v1/blob', () => {
  it('200s with the file bytes for a valid source/sha/path', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(
      proxy,
      'GET',
      '/v1/blob?source=org%2Frepo&sha=sha1&path=src%2Findex.ts'
    );
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe('export const a = 1;\n');
  });

  it('400s when a required param is missing', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'GET', '/v1/blob?source=org%2Frepo&sha=sha1');
    expect(res.status).toBe(400);
  });

  it('404s for a path that does not exist', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(
      proxy,
      'GET',
      '/v1/blob?source=org%2Frepo&sha=sha1&path=nope.txt'
    );
    expect(res.status).toBe(404);
  });
});

describe('handleRequest — /v1/tree', () => {
  it('200s with the entry list', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo&sha=sha1');
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.toString());
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.some((e: { path: string }) => e.path === 'src/index.ts')).toBe(true);
  });

  it('400s when sha is missing', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo');
    expect(res.status).toBe(400);
  });
});

describe('handleRequest — routing + method', () => {
  it('404s an unknown route', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'GET', '/v1/nope');
    expect(res.status).toBe(404);
  });

  it('405s a non-GET method', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'POST', '/v1/blob?source=a%2Fb&sha=s&path=p');
    expect(res.status).toBe(405);
  });
});

describe('handleRequest — a burst through the HTTP layer still primes once', () => {
  it('N concurrent /v1/blob requests for the same (source, sha) share one prime', async () => {
    let fetchCount = 0;
    const fetcher: TarballFetcher = {
      async fetchTarball() {
        fetchCount++;
        return buildFakeTarballGz([
          { path: 'a.txt', content: 'A' },
          { path: 'b.txt', content: 'B' },
        ]);
      },
    };
    const proxy = new SourceProxy(fetcher);

    const requests = [
      handleRequest(proxy, 'GET', '/v1/blob?source=org%2Frepo&sha=sha1&path=a.txt'),
      handleRequest(proxy, 'GET', '/v1/blob?source=org%2Frepo&sha=sha1&path=b.txt'),
      handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo&sha=sha1'),
    ];
    const results = await Promise.all(requests);
    expect(fetchCount).toBe(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
