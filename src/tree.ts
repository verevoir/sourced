// Builds the `/v1/tree` response from a primed tarball's file list.
//
// A finding from implementing this against the design doc: a codeload
// tarball carries no git object SHAs at all — it is a plain content
// snapshot, not `git archive` metadata. The design's `TreeEntry` shape
// (mirrored from `@verevoir/sources`'s `RepoTree`) has a REQUIRED `sha`
// field callers may reasonably expect to be the real git blob SHA (that is
// what `getRepoTree`'s `git/trees/{sha}?recursive=1` call returns today).
// Rather than fabricate one or leave it empty, a blob's git object SHA is a
// pure function of its bytes — `sha1("blob " + len + "\0" + content)` — so
// it is computed locally with zero extra upstream calls. It will match
// `git hash-object` / the Git Data API exactly for every blob.
//
// Directory ("tree") entries are a different story: git's tree-object SHA
// is the hash of a sorted, recursively-built listing of each directory's
// entries — a real Merkle build, not a per-entry pure function. Out of
// scope for S0 (the design's own stated use for `/v1/tree` is backing
// `grep`/`find_symbol`, which need paths, not a directory's git object
// identity), so directory entries carry an empty `sha` with a comment
// rather than a fabricated one. Flagged in the S0 report as a known gap.

import { createHash } from 'node:crypto';
import type { TarFile } from './tar.js';

export type TreeEntryType = 'blob' | 'tree';

export interface TreeEntry {
  path: string;
  type: TreeEntryType;
  /** Byte size — only present for blobs. */
  size?: number;
  /** Git object SHA-1. Exact for blobs (computed from content, see module
   * doc). Empty for directories — see module doc for why. */
  sha: string;
}

/** The git blob object SHA-1 for `content` — identical to what
 * `git hash-object` or GitHub's Git Data API would report, computed with no
 * upstream call: it is a pure function of the bytes. */
export function gitBlobSha(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

/** Derive every ancestor directory of `path` (excluding the path itself),
 * e.g. `a/b/c.ts` -> `['a', 'a/b']`. */
function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  parts.pop(); // drop the leaf (file) segment
  const dirs: string[] = [];
  let running = '';
  for (const part of parts) {
    running = running ? `${running}/${part}` : part;
    dirs.push(running);
  }
  return dirs;
}

/** Build the full tree listing (files + their derived directories) for a
 * primed source snapshot. Directories are derived from file paths rather
 * than trusted from tar directory entries, since not every tar producer
 * emits one for every intermediate directory. */
export function buildTree(files: TarFile[]): TreeEntry[] {
  const dirs = new Set<string>();
  const blobs: TreeEntry[] = [];

  for (const file of files) {
    for (const dir of ancestorDirs(file.path)) dirs.add(dir);
    blobs.push({
      path: file.path,
      type: 'blob',
      size: file.content.length,
      sha: gitBlobSha(file.content),
    });
  }

  const treeEntries: TreeEntry[] = [...dirs].sort().map((path) => ({
    path,
    type: 'tree' as const,
    // See module doc: a directory's real git tree SHA needs a recursive
    // Merkle build this S0 slice does not do.
    sha: '',
  }));

  return [...treeEntries, ...blobs].sort((a, b) => a.path.localeCompare(b.path));
}
