import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillsService } from './skills.service';

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

function writeSkill(
  root: string,
  agentDir: string,
  name: string,
  frontmatter: string,
): void {
  const dir = join(root, agentDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\nBody.\n`);
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

function build(): { service: SkillsService; cwd: string; home: string } {
  const cwd = tempDir('skills-cwd-');
  const home = tempDir('skills-home-');
  return { service: new SkillsService({ homeDir: home }), cwd, home };
}

describe('SkillsService', () => {
  it('lists claude project + user skills and commands, sorted by name', async () => {
    const { service, cwd, home } = build();
    writeSkill(cwd, '.claude', 'deploy', 'name: deploy\ndescription: Ship it');
    writeCommand(
      cwd,
      '.claude',
      'review.md',
      '---\ndescription: Review\n---\n',
    );
    writeSkill(home, '.claude', 'zsh-help', 'description: Home skill');
    writeCommand(home, '.claude', 'auth.md', 'Check auth flows.');

    const skills = await service.list('claude', cwd);
    expect(skills).toEqual([
      {
        name: 'auth',
        description: 'Check auth flows.',
        kind: 'command',
        source: 'user',
      },
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
    ]);
  });

  it('scans only .cursor/commands for cursor-agent — never .claude', async () => {
    const { service, cwd, home } = build();
    writeSkill(cwd, '.claude', 'deploy', 'name: deploy');
    writeCommand(cwd, '.claude', 'review.md', 'Review.');
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');
    writeCommand(home, '.cursor', 'home-cmd.md', 'From home.');

    const skills = await service.list('cursor-agent', cwd);
    expect(skills.map((s) => s.name)).toEqual(['fix', 'home-cmd']);
    expect(skills.every((s) => s.kind === 'command')).toBe(true);
  });

  it('project shadows user, and a skill shadows a same-named command', async () => {
    const { service, cwd, home } = build();
    writeSkill(
      cwd,
      '.claude',
      'deploy',
      'name: deploy\ndescription: Project skill',
    );
    writeCommand(
      cwd,
      '.claude',
      'deploy.md',
      '---\ndescription: Project command\n---\n',
    );
    writeSkill(
      home,
      '.claude',
      'deploy',
      'name: deploy\ndescription: User skill',
    );

    const skills = await service.list('claude', cwd);
    expect(skills).toEqual([
      {
        name: 'deploy',
        description: 'Project skill',
        kind: 'skill',
        source: 'project',
      },
    ]);
  });

  it('recurses into namespaced command subdirectories', async () => {
    const { service, cwd } = build();
    writeCommand(cwd, '.claude', join('frontend', 'component.md'), 'Make one.');

    const skills = await service.list('claude', cwd);
    expect(skills).toEqual([
      {
        name: 'component',
        description: 'Make one.',
        kind: 'command',
        source: 'project',
      },
    ]);
  });

  it('returns [] when no skill/command directories exist at all', async () => {
    const { service, cwd } = build();
    await expect(service.list('claude', cwd)).resolves.toEqual([]);
  });

  it('skips non-md files, extension-less dirs without SKILL.md, and bad names', async () => {
    const { service, cwd } = build();
    writeCommand(cwd, '.claude', 'notes.txt', 'not a command');
    writeCommand(cwd, '.claude', 'bad name.md', 'space in stem');
    // A skills entry with no SKILL.md inside is not a skill.
    mkdirSync(join(cwd, '.claude', 'skills', 'empty-dir'), { recursive: true });

    await expect(service.list('claude', cwd)).resolves.toEqual([]);
  });

  it('rejects an invalid cwd with INVALID_CWD instead of scanning', async () => {
    const { service } = build();
    await expect(
      service.list('claude', '/definitely/not/a/real/dir'),
    ).rejects.toThrow(/INVALID_CWD|does not exist/);
  });
});
