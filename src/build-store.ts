// Adapter selection, split out of `bin.ts` so it can be tested.
//
// `bin.ts` is a composition root: importing it opens a socket and starts a GC
// timer, so anything that needs asserting has to live somewhere a test can
// import without launching the service. This choice needs asserting — picking
// the wrong store silently writes a run's cache somewhere nobody looks.

import { FilesystemBlobStore, GcsBlobStore, type BlobStore } from './store.js';
import type { ServiceInfo } from './server.js';

export interface BuiltStore {
  store?: BlobStore;
  kind: ServiceInfo['store'];
}

/**
 * Choose the persistence adapter from the environment.
 *
 * `env` is a parameter rather than a read of `process.env` so a test can state
 * the configuration it is testing instead of mutating global state and racing
 * every other test in the file.
 */
export async function buildStore(env: NodeJS.ProcessEnv = process.env): Promise<BuiltStore> {
  const bucket = env.SOURCED_GCS_BUCKET?.trim();
  const dir = env.SOURCED_FS_DIR?.trim();

  // Explicit over clever: naming both is a configuration mistake, and guessing
  // which was meant would silently write a run's cache somewhere nobody expects.
  if (bucket && dir) {
    throw new Error('configure SOURCED_GCS_BUCKET or SOURCED_FS_DIR, not both');
  }
  if (bucket) {
    // Imported lazily so the storage SDK is never loaded — or required to
    // authenticate — by a filesystem-backed or in-memory run. This is a dynamic
    // import, not require: the package is ESM and require is not defined here.
    const { GoogleCloudBucket } = await import('./gcs-bucket.js');
    return {
      store: new GcsBlobStore(new GoogleCloudBucket({ bucket })),
      kind: 'gcs',
    };
  }
  if (dir) return { store: new FilesystemBlobStore(dir), kind: 'filesystem' };
  return { store: undefined, kind: 'memory' };
}
