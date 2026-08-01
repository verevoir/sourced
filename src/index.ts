// S1 slice — persistence layer added under the S0 in-memory proxy.
// See the module docs on `proxy.ts` (core), `store.ts` (persistence port
// and adapters), and `server.ts` (HTTP surface) for the design.

export { SourceProxy, type TarballFetcher, type SourceProxyOptions } from './proxy.js';
export { ProxyNotFoundError } from './errors.js';
export { GithubCodeloadFetcher, type GithubCodeloadFetcherOptions } from './fetcher.js';
export { handleRequest, createServer, type ProxyResponse } from './server.js';
export { extractTarball, type TarFile } from './tar.js';
export { buildTree, gitBlobSha, type TreeEntry, type TreeEntryType } from './tree.js';
export {
  // Port
  type BlobStore,
  type RawBlobStore,
  // Adapters
  FilesystemBlobStore,
  GcsBlobStore,
  type GcsBucket,
  // Manifests
  type TreeManifest,
  // GC
  type GcPolicy,
  MaxAgePolicyMs,
  runGc,
  // Key helpers (useful for operators building their own adapters)
  blobKey,
  treeManifestKey,
  snapshotKey,
} from './store.js';
