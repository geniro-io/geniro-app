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

import { scanClaudeSkills } from './claude-skills';

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

function writeSkill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\nBody.\n`);
}

function writeCommand(root: string, relPath: string, content: string): void {
  const path = join(root, '.claude', 'commands', relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function build(): { cwd: string; homeDir: string } {
  return { cwd: tempDir('claude-cwd-'), homeDir: tempDir('claude-home-') };
}

describe('scanClaudeSkills', () => {
  it('scans skills and commands from the project folder and from ~', async () => {
    const { cwd, homeDir } = build();
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');
    writeCommand(cwd, 'review.md', '---\ndescription: Review\n---\n');
    writeSkill(homeDir, 'zsh-help', 'description: Home skill');
    writeCommand(homeDir, 'auth.md', 'Check auth flows.');

    expect(await scanClaudeSkills({ cwd, homeDir })).toEqual([
      {
        name: 'deploy',
        description: 'Ship it',
        kind: 'skill',
        source: 'project',
      },
      {
        name: 'review',
        description: 'Review',
        kind: 'command',
        source: 'project',
      },
      {
        name: 'zsh-help',
        description: 'Home skill',
        kind: 'skill',
        source: 'user',
      },
      {
        name: 'auth',
        description: 'Check auth flows.',
        kind: 'command',
        source: 'user',
      },
    ]);
  });

  it('returns project before user, and a skill before a same-named command', async () => {
    // The ORDER is the contract: the caller de-dupes first-occurrence-wins, so
    // this is what makes it keep the entry claude would actually run.
    const { cwd, homeDir } = build();
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Project skill');
    writeCommand(cwd, 'deploy.md', '---\ndescription: Project command\n---\n');
    writeSkill(homeDir, 'deploy', 'name: deploy\ndescription: User skill');

    const found = await scanClaudeSkills({ cwd, homeDir });
    expect(found.map((entry) => entry.description)).toEqual([
      'Project skill',
      'Project command',
      'User skill',
    ]);
  });

  it('recurses into namespaced command subdirectories', async () => {
    const { cwd, homeDir } = build();
    writeCommand(cwd, join('frontend', 'component.md'), 'Make one.');

    expect(await scanClaudeSkills({ cwd, homeDir })).toEqual([
      {
        name: 'component',
        description: 'Make one.',
        kind: 'command',
        source: 'project',
      },
    ]);
  });

  it('recurses into a SYMLINKED command subdirectory (parity with symlinked skill dirs)', async () => {
    // A shared command dir symlinked into the project — Dirent reports it as
    // a symlink, not a directory, which used to silently drop its commands.
    const { cwd, homeDir } = build();
    const shared = tempDir('claude-shared-');
    writeFileSync(join(shared, 'deploy.md'), 'Ship it.');
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true });
    symlinkSync(shared, join(cwd, '.claude', 'commands', 'ops'));

    expect(await scanClaudeSkills({ cwd, homeDir })).toEqual([
      {
        name: 'deploy',
        description: 'Ship it.',
        kind: 'command',
        source: 'project',
      },
    ]);
  });

  it('returns [] when no skill/command directories exist at all', async () => {
    const { cwd, homeDir } = build();
    await expect(scanClaudeSkills({ cwd, homeDir })).resolves.toEqual([]);
  });

  it('skips non-md files, extension-less dirs without SKILL.md, and bad names', async () => {
    const { cwd, homeDir } = build();
    writeCommand(cwd, 'notes.txt', 'not a command');
    writeCommand(cwd, 'bad name.md', 'space in stem');
    // A skills entry with no SKILL.md inside is not a skill.
    mkdirSync(join(cwd, '.claude', 'skills', 'empty-dir'), { recursive: true });

    await expect(scanClaudeSkills({ cwd, homeDir })).resolves.toEqual([]);
  });

  it('never reads cursor-agent roots', async () => {
    const { cwd, homeDir } = build();
    mkdirSync(join(cwd, '.cursor', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.cursor', 'commands', 'fix.md'), 'Fix it.');

    await expect(scanClaudeSkills({ cwd, homeDir })).resolves.toEqual([]);
  });
});
