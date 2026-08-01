import { describe, it, expect } from 'vitest';
import { extractTarball } from '../src/tar.js';
import { buildFakeTarballGz } from './helpers/tarball.js';

describe('extractTarball', () => {
  it('strips the codeload top-level directory and returns file contents', () => {
    const gz = buildFakeTarballGz(
      [
        { path: 'src/index.ts', content: 'export const a = 1;\n' },
        { path: 'README.md', content: '# hi\n' },
      ],
      'verevoir-corpus-abc1234'
    );

    const files = extractTarball(gz);
    const byPath = new Map(files.map((f) => [f.path, f.content.toString('utf8')]));

    expect(files.length).toBe(2);
    expect(byPath.get('src/index.ts')).toBe('export const a = 1;\n');
    expect(byPath.get('README.md')).toBe('# hi\n');
    // the top-level dir itself must not leak through as a path
    expect(byPath.has('')).toBe(false);
  });

  it('round-trips binary content exactly, including sizes not aligned to 512 bytes', () => {
    const binary = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const gz = buildFakeTarballGz([{ path: 'blob.bin', content: binary }]);

    const files = extractTarball(gz);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('blob.bin');
    expect(Buffer.compare(files[0].content, binary)).toBe(0);
  });

  it('handles an empty tarball (no files)', () => {
    const gz = buildFakeTarballGz([]);
    expect(extractTarball(gz)).toEqual([]);
  });

  it('handles a zero-byte file', () => {
    const gz = buildFakeTarballGz([{ path: 'empty.txt', content: '' }]);
    const files = extractTarball(gz);
    expect(files.length).toBe(1);
    expect(files[0].content.length).toBe(0);
  });
});
