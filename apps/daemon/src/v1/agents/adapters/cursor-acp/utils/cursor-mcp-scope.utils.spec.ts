import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cursorProjectRoot,
  mcpOrigins,
  parseMcpServers,
} from './cursor-mcp-scope.utils';

const dirs: string[] = [];

function realDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cursor-scope-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('parseMcpServers', () => {
  it('reads the servers under mcpServers', () => {
    expect(
      parseMcpServers('{"mcpServers":{"linear":{"url":"u"},"github":{}}}'),
    ).toEqual({ linear: { url: 'u' }, github: {} });
  });

  it('answers nothing for anything that is not that shape', () => {
    // These are the USER's files. A stray comma must cost a label, never the
    // listing the label rides on — the rule claude's folder read follows.
    for (const source of [
      null,
      '',
      'not json at all',
      '[]',
      '{"mcpServers":[]}',
      '{"mcpServers":null}',
      '{}',
    ]) {
      expect(parseMcpServers(source)).toBeNull();
    }
  });
});

describe('mcpOrigins', () => {
  it('places a server that only one scope defines', () => {
    expect(mcpOrigins(['linear'], ['only-here'])).toEqual({
      linear: { scope: 'user', shadowsUser: false },
      'only-here': { scope: 'workspace', shadowsUser: false },
    });
  });

  it('gives a name defined at BOTH scopes to the workspace, and says so', () => {
    // The CLI merges the project file OVER the user one, so this is its
    // precedence rather than a choice made here — and it is the whole reason
    // the field exists: measured in a folder defining `codegraph` twice, the
    // workspace copy was unapproved and the working user copy was unreachable
    // under that name.
    expect(mcpOrigins(['codegraph'], ['codegraph'])).toEqual({
      codegraph: { scope: 'workspace', shadowsUser: true },
    });
  });
});

describe('cursorProjectRoot', () => {
  it('climbs to the directory holding .git, the way the CLI does', () => {
    const root = realDir();
    mkdirSync(join(root, '.git'));
    const deep = join(root, 'apps', 'daemon');
    mkdirSync(deep, { recursive: true });

    expect(cursorProjectRoot(deep)).toBe(root);
  });

  it('accepts a .git FILE, so a linked worktree resolves to itself', () => {
    // Not a detail: a worktree's `.git` is a file pointing at the main
    // checkout, so requiring a directory would climb past it and read the
    // WRONG project's `.cursor/mcp.json`.
    const root = realDir();
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x');

    expect(cursorProjectRoot(join(root))).toBe(root);
  });

  it('falls back to the folder itself when nothing above it is a repo', () => {
    const loose = realDir();

    expect(cursorProjectRoot(loose)).toBe(loose);
  });
});
