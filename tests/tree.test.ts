import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildTree, gitBlobSha } from '../src/tree.js';
import type { TarFile } from '../src/tar.js';

describe('gitBlobSha', () => {
  it('matches the git blob object hash formula (sha1("blob " + len + "\\0" + content))', () => {
    const content = Buffer.from('hello world\n', 'utf8');
    const expected = createHash('sha1')
      .update(Buffer.from(`blob ${content.length}\0`, 'utf8'))
      .update(content)
      .digest('hex');
    expect(gitBlobSha(content)).toBe(expected);
    // Known value: `git hash-object` on a file containing "hello world\n".
    expect(gitBlobSha(content)).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
  });
});

describe('buildTree', () => {
  const files: TarFile[] = [
    { path: 'src/index.ts', content: Buffer.from('a') },
    { path: 'src/lib/util.ts', content: Buffer.from('b') },
    { path: 'README.md', content: Buffer.from('c') },
  ];

  it('includes every file as a blob entry with size and a real git blob sha', () => {
    const tree = buildTree(files);
    const index = tree.find((e) => e.path === 'src/index.ts');
    expect(index).toEqual({ path: 'src/index.ts', type: 'blob', size: 1, sha: gitBlobSha(Buffer.from('a')) });
  });

  it('derives every ancestor directory as a tree entry', () => {
    const tree = buildTree(files);
    const dirPaths = tree.filter((e) => e.type === 'tree').map((e) => e.path);
    expect(dirPaths.sort()).toEqual(['src', 'src/lib']);
  });

  it('directory entries carry no size and an empty sha (no recursive Merkle build in S0)', () => {
    const tree = buildTree(files);
    const src = tree.find((e) => e.path === 'src' && e.type === 'tree');
    expect(src?.size).toBeUndefined();
    expect(src?.sha).toBe('');
  });

  it('is sorted by path', () => {
    const tree = buildTree(files);
    const paths = tree.map((e) => e.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });
});
