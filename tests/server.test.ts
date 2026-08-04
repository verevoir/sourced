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

describe('handleRequest — /healthz', () => {
  // The platform (Cloud Run, k8s, compose) probes this to decide whether the
  // container is alive. Every assertion here is something a probe or an operator
  // depends on.
  // Both spellings, because the probe path is the platform's choice: k8s and
  // Cloud Run conventionally use /healthz, load balancers and compose
  // healthchecks often use /health. One image runs in all of them.
  it.each(['/healthz', '/health'])('200s and reports up on %s', async (path) => {
    const res = await handleRequest(makeProxy(), 'GET', path);
    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body)).status).toBe('ok');
  });

  it('does not treat a trailing slash as the health route', async () => {
    // Exact match only — a prefix match would make /healthz-anything answer ok.
    expect((await handleRequest(makeProxy(), 'GET', '/healthz/')).status).toBe(404);
  });

  it('reports the build and the store it was wired with', async () => {
    // "Which build are you, and what are you talking to" — without this an
    // operator cannot tell a stale revision from a current one, or a run that
    // silently fell back to memory from one using its bucket.
    const res = await handleRequest(makeProxy(), 'GET', '/healthz', {
      version: '9.9.9',
      revision: 'sourced-00042-abc',
      store: 'gcs',
    });
    const body = JSON.parse(String(res.body));
    expect(body).toMatchObject({ version: '9.9.9', revision: 'sourced-00042-abc', store: 'gcs' });
  });

  it('degrades to "unknown" rather than lying when no info is supplied', async () => {
    const body = JSON.parse(String((await handleRequest(makeProxy(), 'GET', '/healthz')).body));
    expect(body.version).toBe('unknown');
    expect(body.store).toBe('unknown');
    expect(body.revision).toBeNull();
  });

  it('states that it is liveness only, so nobody reads it as a dependency probe', async () => {
    // Load-bearing honesty: a green /healthz says the process is up, NOT that GCS
    // or GitHub are reachable. Probing them here would turn a dependency blip into
    // a restart loop of a process still able to serve its cached snapshots.
    const body = JSON.parse(String((await handleRequest(makeProxy(), 'GET', '/healthz')).body));
    expect(body.checks).toMatch(/liveness only/);
  });

  it('answers without touching the proxy at all', async () => {
    // A health check that primes a snapshot would make the probe itself expensive
    // and could fail on an upstream outage the check is not meant to report.
    let touched = false;
    const fetcher: TarballFetcher = {
      async fetchTarball() {
        touched = true;
        return buildFakeTarballGz([{ path: 'a', content: 'a' }]);
      },
    };
    await handleRequest(new SourceProxy(fetcher), 'GET', '/healthz');
    expect(touched).toBe(false);
  });

  it('is GET-only like every other route', async () => {
    expect((await handleRequest(makeProxy(), 'POST', '/healthz')).status).toBe(405);
  });
});
