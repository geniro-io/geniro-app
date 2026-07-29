import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanCursorSkills } from './cursor-skills';

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

function writeCommand(
  root: string,
  agentDir: string,
  relPath: string,
  content: string,
): void {
  const path = join(root, agentDir, 'commands', relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function build(): { cwd: string; homeDir: string } {
  return { cwd: tempDir('cursor-cwd-'), homeDir: tempDir('cursor-home-') };
}

describe('scanCursorSkills', () => {
  it('scans .cursor/commands from the project folder and from ~', async () => {
    const { cwd, homeDir } = build();
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');
    writeCommand(homeDir, '.cursor', 'home-cmd.md', 'From home.');

    expect(await scanCursorSkills({ cwd, homeDir })).toEqual([
      {
        name: 'fix',
        description: 'Fix the thing.',
        kind: 'command',
        source: 'project',
      },
      {
        name: 'home-cmd',
        description: 'From home.',
        kind: 'command',
        source: 'user',
      },
    ]);
  });

  it('never reads claude roots — .claude belongs to the other CLI', async () => {
    const { cwd, homeDir } = build();
    const skillDir = join(cwd, '.claude', 'skills', 'deploy');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deploy\n---\n');
    writeCommand(cwd, '.claude', 'review.md', 'Review.');
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');

    const found = await scanCursorSkills({ cwd, homeDir });
    expect(found.map((entry) => entry.name)).toEqual(['fix']);
  });

  it('has no skills convention — every entry is a command', async () => {
    const { cwd, homeDir } = build();
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');
    // A cursor "skills" directory is not a thing the CLI reads.
    const skillDir = join(cwd, '.cursor', 'skills', 'deploy');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deploy\n---\n');

    const found = await scanCursorSkills({ cwd, homeDir });
    expect(found.map((entry) => entry.name)).toEqual(['fix']);
    expect(found.every((entry) => entry.kind === 'command')).toBe(true);
  });

  it('returns [] when the folder has no .cursor/commands at all', async () => {
    const { cwd, homeDir } = build();
    await expect(scanCursorSkills({ cwd, homeDir })).resolves.toEqual([]);
  });
});
