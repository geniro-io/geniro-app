import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cursorProjectRoot, seedCursorDataDir } from './cursor-data-dir.utils';
import { cursorProjectKey } from './cursor-delegate-transcript.utils';

const made: string[] = [];
function temp(prefix: string): string {
  // Real path: the seed keys by it, as the CLI does by `process.cwd()`.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A home whose real `~/.cursor/projects/<key>/` holds a sign-in and a list. */
function homeWith(cwd: string, disabled: string[] | null): string {
  const home = temp('cursor-home-');
  const real = join(home, '.cursor', 'projects', cursorProjectKey(cwd));
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'mcp-auth.json'), '{"datadog":{}}');
  if (disabled !== null) {
    writeFileSync(join(real, 'mcp-disabled.json'), JSON.stringify(disabled));
  }
  return home;
}

describe('seedCursorDataDir', () => {
  it('adds the node’s servers to the user’s own disabled list, and links everything else to the real store', () => {
    const cwd = temp('cursor-cwd-');
    const home = homeWith(cwd, ['linear']);
    const dir = seedCursorDataDir({
      baseDir: temp('cursor-base-'),
      cwd,
      disabled: ['codegraph', 'linear'],
      homeDir: home,
      env: {},
    });
    const own = join(dir, 'projects', cursorProjectKey(cwd));
    const real = join(home, '.cursor', 'projects', cursorProjectKey(cwd));

    expect(
      JSON.parse(readFileSync(join(own, 'mcp-disabled.json'), 'utf8')),
    ).toEqual(['linear', 'codegraph']);
    // The user's own list is never written to.
    expect(
      JSON.parse(readFileSync(join(real, 'mcp-disabled.json'), 'utf8')),
    ).toEqual(['linear']);
    // The sign-in is the user's real file, so a token refreshed mid-turn
    // lands there.
    expect(lstatSync(join(own, 'mcp-auth.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(own, 'mcp-auth.json'), 'utf8')).toBe(
      '{"datadog":{}}',
    );
    expect(lstatSync(join(own, 'agent-transcripts')).isSymbolicLink()).toBe(
      true,
    );
  });

  it('links a not-yet-written state file so the CLI’s first write reaches the real store', () => {
    const cwd = temp('cursor-cwd-');
    const home = temp('cursor-home-');
    const dir = seedCursorDataDir({
      baseDir: temp('cursor-base-'),
      cwd,
      disabled: ['codegraph'],
      homeDir: home,
      env: {},
    });
    const key = cursorProjectKey(cwd);
    // What the CLI's own writers do here: a plain write through the path.
    writeFileSync(join(dir, 'projects', key, 'mcp-approvals.json'), '[]');
    expect(
      readFileSync(
        join(home, '.cursor', 'projects', key, 'mcp-approvals.json'),
        'utf8',
      ),
    ).toBe('[]');
  });

  it('keys the list by the git root and links the cwd’s own key whole', () => {
    const repo = temp('cursor-repo-');
    mkdirSync(join(repo, '.git'));
    const cwd = join(repo, 'apps', 'api');
    mkdirSync(cwd, { recursive: true });
    const home = temp('cursor-home-');
    const dir = seedCursorDataDir({
      baseDir: temp('cursor-base-'),
      cwd,
      disabled: ['codegraph'],
      homeDir: home,
      env: {},
    });
    expect(
      existsSync(
        join(dir, 'projects', cursorProjectKey(repo), 'mcp-disabled.json'),
      ),
    ).toBe(true);
    expect(
      lstatSync(join(dir, 'projects', cursorProjectKey(cwd))).isSymbolicLink(),
    ).toBe(true);
  });

  it('reads the user’s own list from the data dir THEY named', () => {
    const cwd = temp('cursor-cwd-');
    const data = temp('cursor-data-');
    const real = join(data, 'projects', cursorProjectKey(cwd));
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'mcp-disabled.json'), '["slack"]');
    const dir = seedCursorDataDir({
      baseDir: temp('cursor-base-'),
      cwd,
      disabled: ['codegraph'],
      homeDir: temp('cursor-home-'),
      env: { CURSOR_DATA_DIR: data },
    });
    expect(
      JSON.parse(
        readFileSync(
          join(dir, 'projects', cursorProjectKey(cwd), 'mcp-disabled.json'),
          'utf8',
        ),
      ),
    ).toEqual(['slack', 'codegraph']);
  });
});

describe('cursorProjectRoot', () => {
  it('is the nearest folder holding .git, else the folder itself', () => {
    const repo = temp('cursor-root-');
    writeFileSync(join(repo, '.git'), 'gitdir: elsewhere');
    const deep = join(repo, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(cursorProjectRoot(deep)).toBe(repo);
    const loose = temp('cursor-loose-');
    expect(cursorProjectRoot(loose)).toBe(loose);
  });
});
