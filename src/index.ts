// S0 slice — content-addressed source read proxy. See the module docs on
// `proxy.ts` (the core deliverable) and `server.ts` (the HTTP surface) for
// the design; this file is just the public export surface.

export { SourceProxy, type TarballFetcher, type SourceProxyOptions } from './proxy.js';
export { ProxyNotFoundError } from './errors.js';
export { GithubCodeloadFetcher, type GithubCodeloadFetcherOptions } from './fetcher.js';
export { handleRequest, createServer, type ProxyResponse } from './server.js';
export { extractTarball, type TarFile } from './tar.js';
export { buildTree, gitBlobSha, type TreeEntry, type TreeEntryType } from './tree.js';
