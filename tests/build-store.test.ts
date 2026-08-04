// Adapter-selection tests for `buildStore`.
//
// `buildStore` takes an env object rather than reading process.env, so tests
// state the configuration they are testing without mutating global state.
//
// The `gcs` branch is NOT tested here: it constructs a real `Storage` object,
// which requires credentials available only in production. Its behaviour is
// covered by the GoogleCloudBucket tests (tests/gcs-bucket.test.ts).

import { describe, it, expect } from 'vitest';
import { buildStore } from '../src/build-store.js';

describe('buildStore', () => {
  it('returns kind: "memory" and no store when the env is empty', async () => {
    // An unconfigured deployment must still serve requests from memory; returning
    // an error here would break every run that omits persistence configuration.
    const result = await buildStore({});
    expect(result.kind).toBe('memory');
    expect(result.store).toBeUndefined();
  });

  it('returns kind: "filesystem" when SOURCED_FS_DIR is set', async () => {
    // Naming the wrong adapter would silently write a run's cache to an
    // unexpected location. The `kind` field exists precisely so the health
    // endpoint (and the operator) can verify what is actually wired.
    const result = await buildStore({ SOURCED_FS_DIR: '/tmp/test-sourced' });
    expect(result.kind).toBe('filesystem');
    expect(result.store).toBeDefined();
  });

  it('throws when both SOURCED_GCS_BUCKET and SOURCED_FS_DIR are set', async () => {
    // Guessing which adapter was meant would silently write cache data to an
    // unexpected location. The only safe response is to refuse to start.
    await expect(
      buildStore({ SOURCED_GCS_BUCKET: 'my-bucket', SOURCED_FS_DIR: '/tmp/x' })
    ).rejects.toThrow();
  });

  it('treats a whitespace-only SOURCED_FS_DIR as absent', async () => {
    // A blank env var in a deployment template (e.g. `SOURCED_FS_DIR=   `)
    // must not select the filesystem adapter and accidentally write cache data
    // to a path nobody configured.
    const result = await buildStore({ SOURCED_FS_DIR: '   ' });
    expect(result.kind).toBe('memory');
    expect(result.store).toBeUndefined();
  });

  it('treats a whitespace-only SOURCED_GCS_BUCKET as absent', async () => {
    // Same whitespace-trimming contract for the GCS variable: a blank value
    // must not attempt to construct a real Storage client (which would throw
    // on a bad bucket name and require credentials).
    const result = await buildStore({ SOURCED_GCS_BUCKET: '  ' });
    expect(result.kind).toBe('memory');
    expect(result.store).toBeUndefined();
  });

  it('treats whitespace-only values for BOTH vars as absent and returns memory', async () => {
    // The conflict guard fires only when both values are non-empty after
    // trimming; two blank values must resolve to in-memory rather than throwing.
    const result = await buildStore({ SOURCED_GCS_BUCKET: '  ', SOURCED_FS_DIR: '  ' });
    expect(result.kind).toBe('memory');
    expect(result.store).toBeUndefined();
  });
});
