import { describe, it, expect } from 'vitest';
import { SourceProxy, type TarballFetcher } from '../src/proxy.js';
import { handleRequest } from '../src/server.js';
import { buildFakeTarballGz } from './helpers/tarball.js';

// The allowlist is fail-closed, so every route test must state which sources it
// permits — the same thing the deployment states in SOURCED_ALLOWED_SOURCES.
const ALLOW = { allowedSources: new Set(['a/b', 'org/repo']) } as const;

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
      '/v1/blob?source=org%2Frepo&sha=sha1&path=src%2Findex.ts',
      ALLOW
    );
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe('export const a = 1;\n');
  });

  it('400s when a required param is missing', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'GET', '/v1/blob?source=org%2Frepo&sha=sha1', ALLOW);
    expect(res.status).toBe(400);
  });

  it('404s for a path that does not exist', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(
      proxy,
      'GET',
      '/v1/blob?source=org%2Frepo&sha=sha1&path=nope.txt',
      ALLOW
    );
    expect(res.status).toBe(404);
  });
});

describe('handleRequest — /v1/tree', () => {
  it('200s with the entry list', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo&sha=sha1', ALLOW);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.toString());
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.some((e: { path: string }) => e.path === 'src/index.ts')).toBe(true);
  });

  it('400s when sha is missing', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo', ALLOW);
    expect(res.status).toBe(400);
  });
});

describe('handleRequest — routing + method', () => {
  it('404s an unknown route', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'GET', '/v1/nope', ALLOW);
    expect(res.status).toBe(404);
  });

  it('405s a non-GET method', async () => {
    const proxy = makeProxy();
    const res = await handleRequest(proxy, 'POST', '/v1/blob?source=a%2Fb&sha=s&path=p', ALLOW);
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
      handleRequest(proxy, 'GET', '/v1/blob?source=org%2Frepo&sha=sha1&path=a.txt', ALLOW),
      handleRequest(proxy, 'GET', '/v1/blob?source=org%2Frepo&sha=sha1&path=b.txt', ALLOW),
      handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo&sha=sha1', ALLOW),
    ];
    const results = await Promise.all(requests);
    expect(fetchCount).toBe(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('handleRequest — the source allowlist (the service lends its own credential)', () => {
  // The service applies ITS token to whatever source a caller names. Without the
  // allowlist, anyone who can reach /v1/blob can read every private repo that
  // token can read — the service is a confused deputy for its own credential.
  it.each(['/v1/blob?source=evil%2Frepo&sha=s&path=p', '/v1/tree?source=evil%2Frepo&sha=s'])(
    '403s a source that is not allowed: %s',
    async (url) => {
      expect((await handleRequest(makeProxy(), 'GET', url, ALLOW)).status).toBe(403);
    }
  );

  it.each([
    ['no options at all', undefined],
    ['an empty allowlist', { allowedSources: new Set<string>() }],
  ])('DENIES everything when configured with %s — fail closed', async (_label, opts) => {
    // A misconfiguration must cost availability, never confidentiality. If this
    // ever inverts, a deploy that forgets the env var silently serves everything.
    const res = await handleRequest(
      makeProxy(),
      'GET',
      '/v1/blob?source=org%2Frepo&sha=sha1&path=src%2Findex.ts',
      opts
    );
    expect(res.status).toBe(403);
  });

  it('never fetches upstream for a denied source', async () => {
    // The refusal must happen BEFORE the prime, or a denied caller still spends
    // the service's upstream budget and can warm its cache.
    let fetched = false;
    const fetcher: TarballFetcher = {
      async fetchTarball() {
        fetched = true;
        return buildFakeTarballGz([{ path: 'a', content: 'a' }]);
      },
    };
    await handleRequest(
      new SourceProxy(fetcher),
      'GET',
      '/v1/tree?source=evil%2Frepo&sha=s',
      ALLOW
    );
    expect(fetched).toBe(false);
  });

  it('does not disclose whether a denied source exists', async () => {
    const body = JSON.parse(
      String(
        (await handleRequest(makeProxy(), 'GET', '/v1/tree?source=evil%2Frepo&sha=s', ALLOW)).body
      )
    );
    expect(JSON.stringify(body)).not.toMatch(/evil/);
  });
});

describe('handleRequest — path traversal is refused, not sanitised', () => {
  // Sanitising is what produced the hole this replaces: one pass of `../`
  // stripping turns `....//foo` into `../foo`, MANUFACTURING the traversal.
  it.each([
    ['../etc/passwd', 'plain traversal'],
    ['a/../../b', 'traversal in the middle'],
    ['..\\windows\\system32', 'backslash separators'],
    ['/etc/passwd', 'absolute path'],
  ])('400s %s (%s)', async (path) => {
    const url = `/v1/blob?source=org%2Frepo&sha=sha1&path=${encodeURIComponent(path)}`;
    expect((await handleRequest(makeProxy(), 'GET', url, ALLOW)).status).toBe(400);
  });

  it('still serves a legitimate nested path', async () => {
    // The guard must not be so blunt it breaks the normal case — `..` as a
    // SEGMENT is the hazard, not the characters appearing anywhere.
    const res = await handleRequest(
      makeProxy(),
      'GET',
      '/v1/blob?source=org%2Frepo&sha=sha1&path=src%2Findex.ts',
      ALLOW
    );
    expect(res.status).toBe(200);
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
      info: { version: '9.9.9', revision: 'sourced-00042-abc', store: 'gcs' },
    });
    const body = JSON.parse(String(res.body));
    expect(body).toMatchObject({
      version: '9.9.9',
      revision: 'sourced-00042-abc',
      store: 'gcs',
    });
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
