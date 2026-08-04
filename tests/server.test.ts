import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { SourceProxy, type TarballFetcher } from '../src/proxy.js';
import { handleRequest, createServer } from '../src/server.js';
import { RateLimiter } from '../src/rate-limit.js';
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
    // A NUL truncates the string in any C-level path API underneath us, so
    // `safe.txt\0../../etc/passwd` can pass a JS-side check and then be read as
    // `safe.txt` — or, worse, the reverse. It survives the URL layer as %00, so
    // the guard has to reject it here rather than assume it cannot arrive.
    ['safe.txt\0../../etc/passwd', 'NUL byte truncation'],
    ['\0', 'a bare NUL'],
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

// ---------------------------------------------------------------------------
// Rate-limiter integration
// ---------------------------------------------------------------------------

/** A limiter whose prime budget is very small so tests can exhaust it with
 * one or two requests, but whose request budget is generous enough that
 * plain (non-prime) requests continue to work. */
function makeTightPrimeLimiter(opts?: { now?: () => number }) {
  return new RateLimiter({
    requestBurst: 200,
    requestsPerSecond: 50,
    primeBurst: 1,    // one prime allowed then refused
    primesPerSecond: 0.001,
    now: opts?.now ?? (() => 0),
  });
}

describe('handleRequest — rate limiting', () => {
  it('an over-limit request gets 429 with a positive-integer retry-after header', async () => {
    // A 429 with no Retry-After header invites an immediate retry, which is the
    // exact behaviour the rate limit exists to stop. The header value must be a
    // positive integer so a client can safely back off for that many seconds.
    const limiter = makeTightPrimeLimiter();
    const proxy = makeProxy();
    const OPTS = { allowedSources: new Set(['org/repo']), rateLimiter: limiter };

    // Exhaust the prime budget.
    await handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo&sha=sha1', OPTS);

    // This request should be throttled.
    const res = await handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo&sha=sha2', OPTS);
    expect(res.status).toBe(429);

    const retryAfter = res.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    const parsed = parseInt(String(retryAfter), 10);
    expect(Number.isInteger(parsed)).toBe(true);
    expect(parsed).toBeGreaterThan(0);
  });

  it('reads of an already-primed snapshot are NOT charged the prime budget', async () => {
    // Cache hits are cheap (map lookup only). The whole point of the two-budget
    // design is that a warm snapshot's reads must survive even when the prime
    // budget is exhausted.
    const fetcher: TarballFetcher = {
      async fetchTarball() {
        return buildFakeTarballGz([{ path: 'a.txt', content: 'hello' }]);
      },
    };
    const proxy = new SourceProxy(fetcher);
    const limiter = makeTightPrimeLimiter();
    const OPTS = { allowedSources: new Set(['org/repo']), rateLimiter: limiter };

    // Prime sha1 — uses the one prime token.
    await handleRequest(proxy, 'GET', '/v1/tree?source=org%2Frepo&sha=sha1', OPTS);

    // Exhaust the prime budget with a different sha.
    // (sha1 is already primed, so a second call for sha1 is cheap;
    // but sha2 is cold and will be refused because the budget is now empty.)
    const throttled = await handleRequest(
      proxy, 'GET', '/v1/tree?source=org%2Frepo&sha=sha2', OPTS
    );
    expect(throttled.status).toBe(429);

    // Reads of the already-primed sha1 must still succeed — they are cheap.
    const res = await handleRequest(
      proxy, 'GET', '/v1/blob?source=org%2Frepo&sha=sha1&path=a.txt', OPTS
    );
    expect(res.status).toBe(200);
  });

  it('a denied source does not consume any rate-limit budget', async () => {
    // denySource fires before denyVolume on purpose. If a denied source keyed
    // a bucket in the limiter, an attacker could exhaust a valid source's
    // budget by hammering a denied name — the caller-supplied string would be
    // an unbounded map key. Verify by spending nothing on a denied source and
    // confirming the allowed source still has its full budget.
    const limiter = makeTightPrimeLimiter();
    const ALLOWED = new Set(['org/repo']);
    const OPTS = { allowedSources: ALLOWED, rateLimiter: limiter };

    // Hit a denied source many times — must not consume budget.
    for (let i = 0; i < 20; i++) {
      const res = await handleRequest(
        makeProxy(), 'GET', `/v1/tree?source=evil%2Frepo&sha=sha${i}`, OPTS
      );
      expect(res.status).toBe(403);
    }

    // The allowed source must still have its full prime budget intact.
    const res = await handleRequest(
      makeProxy(), 'GET', '/v1/tree?source=org%2Frepo&sha=sha1', OPTS
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createServer — real socket tests
// ---------------------------------------------------------------------------

describe('createServer — maps a throw to 500 rather than crashing the process', () => {
  it('returns 500 with a JSON body when the proxy throws outside the route try/catch', async () => {
    // WHY THIS EXISTS: an unhandled throw in the request handler reaches
    // node:http's 'uncaughtException' path and takes the whole PROCESS down — one
    // bad request becoming an outage. `createServer`'s catch-all is the only
    // thing standing between those two outcomes, and it is the one behaviour
    // `createServer` adds over `handleRequest`, so it needs a real socket to
    // prove rather than a synthetic call.
    //
    // The injection point is deliberate. `handleRequest` already wraps the
    // retrieval calls and maps their failures to 404/502, so a throwing fetcher
    // proves nothing about this boundary. `isPrimed` is called to PRICE the
    // request before that try/catch opens, which makes it the honest place to
    // inject a fault that escapes — standing in for any future statement added
    // outside the guard.
    const bustedProxy = {
      isPrimed() {
        throw new Error('classification exploded');
      },
      async getTree() {
        return [];
      },
      async getBlob() {
        return Buffer.alloc(0);
      },
    } as unknown as SourceProxy;

    const server = createServer(bustedProxy, {
      allowedSources: new Set(['org/repo']),
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    let res: http.IncomingMessage;
    let body = '';
    try {
      res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/v1/tree?source=org%2Frepo&sha=sha1`,
          resolve
        );
        req.on('error', reject);
      });
      body = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(res!.statusCode).toBe(500);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ error: 'internal_error' });

    // The body must NOT carry the underlying error. A raw message here hands a
    // caller bucket names, filesystem paths and SDK internals — a free map of
    // the service to anyone able to provoke a crash — and tells them nothing
    // they can act on, because a 500 is our bug and not their request's fault.
    expect(body).not.toMatch(/classification exploded/);

    // But an operator still has to be able to join this response to the log line
    // that does carry the cause, so it carries a reference.
    expect(typeof parsed.reference).toBe('string');
    expect(parsed.reference.length).toBeGreaterThan(0);
  });
});

