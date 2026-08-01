// Test-only ustar + gzip builder — the mirror image of `src/tar.ts`'s
// reader, used to synthesize fake codeload responses so the test suite
// never touches the network. Not part of the shipped package: production
// only ever needs to READ a tarball (from real codeload), never write one.

import { gzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;

export interface TarballFile {
  path: string;
  content: string | Buffer;
}

function writeString(buf: Buffer, offset: number, value: string, length: number): void {
  buf.write(value, offset, length, 'utf8');
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  // Octal, zero-padded, NUL-terminated — ustar's numeric field convention.
  const octal = value.toString(8);
  const padded = octal.padStart(length - 1, '0');
  writeString(buf, offset, padded, length - 1);
  buf[offset + length - 1] = 0;
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    // The checksum field itself counts as eight ASCII spaces while summing.
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

function buildHeader(path: string, size: number, typeFlag: string): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeString(header, 0, path.slice(0, 100), 100);
  writeOctal(header, 100, 8, 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime
  header[156] = typeFlag.charCodeAt(0);
  writeString(header, 257, 'ustar', 6); // magic (NUL-terminated by Buffer.alloc zero-fill)
  writeString(header, 263, '00', 2); // version

  const chk = checksum(header);
  const chkOctal = chk.toString(8).padStart(6, '0');
  writeString(header, 148, chkOctal, 6);
  header[154] = 0; // NUL
  header[155] = 0x20; // space, per spec

  return header;
}

function pad(buf: Buffer): Buffer {
  const remainder = buf.length % BLOCK_SIZE;
  if (remainder === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - remainder, 0)]);
}

/** Build a gzip'd ustar tarball with a codeload-shaped top-level directory
 * (`<topDir>/<path>` for every file), so `extractTarball`'s prefix-stripping
 * is exercised the same way it would be against a real codeload response. */
export function buildFakeTarballGz(files: TarballFile[], topDir = 'owner-repo-abc1234'): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const fullPath = `${topDir}/${file.path}`;
    blocks.push(buildHeader(fullPath, content.length, '0'));
    blocks.push(pad(content));
  }

  // End-of-archive marker: two zero-filled blocks.
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

  return gzipSync(Buffer.concat(blocks));
}
