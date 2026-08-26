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
  descendants,
  mcpOrigins,
  parseMcpServerNames,
  parsePluginMcpPath,
  pluginOnlyNote,
  readTextOrNull,
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

describe('parseMcpServerNames', () => {
  it('reads the names under mcpServers', () => {
    expect(
      parseMcpServerNames('{"mcpServers":{"linear":{},"github":{}}}'),
    ).toEqual(['linear', 'github']);
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
      expect(parseMcpServerNames(source)).toEqual([]);
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

describe('pluginOnlyNote', () => {
  it('names what cursor loads in its own app and a turn does not', () => {
    const note = pluginOnlyNote(['datadog', 'sentry']);

    expect(note).toContain('datadog');
    expect(note).toContain('sentry');
    // It must not read as a list of things geniro HAS: the whole claim is that
    // these are absent from the turns it runs.
    expect(note).toContain('not listed here');
  });

  it('says nothing when the machine has no such plugin', () => {
    // A sentence about an empty set states a gap that does not exist, on a
    // panel whose complaint was already that it says too much.
    expect(pluginOnlyNote([])).toBeNull();
  });

  it('names each server once, however many plugins declare it', () => {
    expect(pluginOnlyNote(['datadog', 'datadog'])).toContain('datadog');
    expect(pluginOnlyNote(['datadog', 'datadog'])).not.toContain(
      'datadog, datadog',
    );
  });
});

describe('parsePluginMcpPath', () => {
  it('reads the relative path a plugin manifest points at', () => {
    // The shape of the installed datadog plugin's own manifest.
    expect(
      parsePluginMcpPath(
        '{"name":"datadog","mcpServers":"./.dd_cursor_mcp.json"}',
      ),
    ).toBe('./.dd_cursor_mcp.json');
  });

  it('answers null for a plugin that declares no MCP config', () => {
    for (const source of [null, '{}', '{"mcpServers":{}}', 'nope']) {
      expect(parsePluginMcpPath(source)).toBeNull();
    }
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

describe('descendants', () => {
  it('walks only as deep as it is asked to', async () => {
    // The caller scans a plugin CACHE holding a source checkout per plugin,
    // inside a read the panel waits on — an unbounded walk is seconds.
    const root = realDir();
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });

    expect(await descendants(root, 2)).toEqual([
      join(root, 'a'),
      join(root, 'a', 'b'),
    ]);
  });

  it('answers nothing for a directory that is not there', async () => {
    expect(await descendants(join(realDir(), 'missing'), 3)).toEqual([]);
  });
});

describe('readTextOrNull', () => {
  it('answers null rather than throwing on an absent file', async () => {
    expect(await readTextOrNull(join(realDir(), 'nope.json'))).toBeNull();
  });
});
