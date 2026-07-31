import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanCommandFiles, scanSkillDirs } from './skill-scan.utils';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Writes `<root>/<relPath>`, creating the intermediate directories. */
function writeAt(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// The two on-disk SHAPES, driven directly — no CLI's roots appear here, which
// is the point of the helper living at the adapters root: both adapters' paths
// are `config.skillRoots` values the base class joins, and this file must never
// learn one.

describe('scanCommandFiles', () => {
  it('recurses into namespaced command subdirectories', async () => {
    const root = tempDir('skill-scan-commands-');
    writeAt(root, join('frontend', 'component.md'), 'Make one.');

    await expect(scanCommandFiles(root, 'project')).resolves.toEqual([
      {
        name: 'component',
        description: 'Make one.',
        kind: 'command',
        source: 'project',
      },
    ]);
  });

  it('recurses into a SYMLINKED subdirectory (parity with symlinked skill dirs)', async () => {
    // A shared command dir symlinked into the project — Dirent reports it as
    // a symlink, not a directory, which used to silently drop its commands.
    const root = tempDir('skill-scan-commands-');
    const shared = tempDir('skill-scan-shared-');
    writeFileSync(join(shared, 'deploy.md'), 'Ship it.');
    symlinkSync(shared, join(root, 'ops'));

    expect(await scanCommandFiles(root, 'project')).toEqual([
      {
        name: 'deploy',
        description: 'Ship it.',
        kind: 'command',
        source: 'project',
      },
    ]);
  });
});

describe('scanSkillDirs + scanCommandFiles', () => {
  it('skips non-md files, extension-less dirs without SKILL.md, and bad names', async () => {
    const commandsRoot = tempDir('skill-scan-commands-');
    const skillsRoot = tempDir('skill-scan-skills-');
    writeAt(commandsRoot, 'notes.txt', 'not a command');
    writeAt(commandsRoot, 'bad name.md', 'space in stem');
    // A skills entry with no SKILL.md inside is not a skill.
    mkdirSync(join(skillsRoot, 'empty-dir'), { recursive: true });

    await expect(scanCommandFiles(commandsRoot, 'project')).resolves.toEqual(
      [],
    );
    await expect(scanSkillDirs(skillsRoot, 'project')).resolves.toEqual([]);
  });
});
