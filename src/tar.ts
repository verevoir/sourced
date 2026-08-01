// Minimal ustar reader for GitHub codeload tarballs.
//
// codeload.github.com/<owner>/<repo>/tar.gz/<sha> is a gzip'd POSIX ustar
// stream with one top-level directory (`<owner>-<repo>-<shortsha>/...`).
// A full tar implementation (symlinks, sparse files, PAX extended headers,
// multi-volume) is not needed to explode a source snapshot into an
// in-memory path->bytes map — regular files and directories are all a repo
// tree needs. Anything else (symlink, hardlink, char/block device, fifo) is
// skipped rather than misread as content.
//
// No third-party tar/gunzip dependency: `zlib.gunzipSync` is Node built-in,
// and ustar's fixed 512-byte header layout is simple enough to parse by
// hand — see https://www.gnu.org/software/tar/manual/html_node/Standard.html.

import { gunzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;

/** One regular file extracted from a tarball, path relative to the repo
 * root (the codeload top-level directory already stripped). */
export interface TarFile {
  path: string;
  content: Buffer;
}

// ustar typeflag values relevant here; everything else is skipped.
const TYPE_REGULAR = '0';
const TYPE_REGULAR_LEGACY = '\0';
const TYPE_DIRECTORY = '5';

function readCString(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const raw = readCString(header, offset, length).trim();
  if (raw === '') return 0;
  const n = parseInt(raw, 8);
  return Number.isNaN(n) ? 0 : n;
}

/** Strips the tarball's single top-level directory (`owner-repo-sha/`) so
 * paths match the repo tree, e.g. `verevoir-corpus-abc1234/src/index.ts`
 * becomes `src/index.ts`. A path with no separator (the top-level dir entry
 * itself) becomes `''` and is filtered out by the caller. */
function stripTopLevelDir(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '' : path.slice(slash + 1);
}

/** Explode a gzip'd tarball buffer into its regular files, keyed by
 * repo-relative path. Directory, symlink and other non-regular entries are
 * skipped — directory structure is derived from file paths by `buildTree`
 * instead of trusted from the archive, since not every tar producer emits
 * an explicit entry for every intermediate directory. */
export function extractTarball(gzipped: Buffer): TarFile[] {
  const tar = gunzipSync(gzipped);
  const files: TarFile[] = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);

    // Two consecutive zero-filled blocks mark end-of-archive.
    if (header.every((b) => b === 0)) break;

    const name = readCString(header, 0, 100);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    // ustar `prefix` field extends `name` for paths > 100 bytes.
    const prefix = readCString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += BLOCK_SIZE;
    const contentBlocks = Math.ceil(size / BLOCK_SIZE);

    if (typeFlag === TYPE_REGULAR || typeFlag === TYPE_REGULAR_LEGACY) {
      const content = Buffer.from(tar.subarray(offset, offset + size));
      const path = stripTopLevelDir(fullName);
      if (path) files.push({ path, content });
    }
    // TYPE_DIRECTORY and anything else (symlink 'l'/'2', hardlink '1',
    // devices, fifos, PAX headers 'x'/'g') carry no content worth keeping
    // for S0 and are skipped — the loop still advances past their body.
    void TYPE_DIRECTORY;

    offset += contentBlocks * BLOCK_SIZE;
  }

  return files;
}
