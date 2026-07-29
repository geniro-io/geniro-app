import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentCommandOptions } from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAdapter } from '../adapters/cursor/cursor.adapter';
import { ProcessRegistry } from './process-registry';
import { SkillHarvestStore } from './skill-harvest.store';
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

function writeSkill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, '.claude', 'skills', name);
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

/**
 * The real adapters — so the composition under test runs against the real disk
 * scan — with only the CLI-asking method scripted, since that spawns a turn.
 */
class ScriptedClaude extends ClaudeAdapter {
  asked = 0;

  constructor(private readonly reported: string[]) {
    super();
  }

  override listReportedCommands(
    _options: AgentCommandOptions = {},
  ): Promise<string[]> {
    this.asked += 1;
    return Promise.resolve(this.reported);
  }
}

class ScriptedCursor extends CursorAdapter {
  asked = 0;

  override listReportedCommands(): Promise<string[]> {
    this.asked += 1;
    return Promise.resolve([]);
  }
}

function build(
  catalog: string[] = [],
  options: { now?: () => number; catalogTtlMs?: number } = {},
): {
  service: SkillsService;
  cwd: string;
  home: string;
  harvest: SkillHarvestStore;
  claude: ScriptedClaude;
  cursor: ScriptedCursor;
} {
  const cwd = tempDir('skills-cwd-');
  const home = tempDir('skills-home-');
  const harvest = new SkillHarvestStore({
    file: join(tempDir('skills-harvest-'), 'claude-skills.json'),
  });
  const claude = new ScriptedClaude(catalog);
  const cursor = new ScriptedCursor();
  return {
    service: new SkillsService(harvest, claude, cursor, new ProcessRegistry(), {
      homeDir: home,
      resolveVersionFn: () => Promise.resolve('pinned'),
      ...options,
    }),
    cwd,
    home,
    harvest,
    claude,
    cursor,
  };
}

describe('SkillsService', () => {
  it('lists the adapter scan first — project before user, each sorted by name', async () => {
    const { service, cwd, home } = build();
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');
    writeCommand(
      cwd,
      '.claude',
      'review.md',
      '---\ndescription: Review\n---\n',
    );
    writeSkill(home, 'zsh-help', 'description: Home skill');
    writeCommand(home, '.claude', 'auth.md', 'Check auth flows.');

    const skills = await service.list('claude', cwd);
    expect(skills).toEqual([
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
        name: 'auth',
        description: 'Check auth flows.',
        kind: 'command',
        source: 'user',
      },
      {
        name: 'zsh-help',
        description: 'Home skill',
        kind: 'skill',
        source: 'user',
      },
    ]);
  });

  it('appends this cwd’s harvested names as trailing cli entries; scanned names keep their metadata', async () => {
    const { service, cwd, harvest } = build();
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');
    // The harvest is keyed by the CANONICAL cwd — exactly what the executor
    // records (its cwd went through resolveValidCwd).
    harvest.record('claude', realpathSync(cwd), [
      'compact',
      'deploy',
      'review',
    ]);

    const skills = await service.list('claude', cwd);
    expect(skills).toEqual([
      // The scanned entry wins its collision and keeps its description…
      {
        name: 'deploy',
        description: 'Ship it',
        kind: 'skill',
        source: 'project',
      },
      // …and the CLI-only names (built-ins/plugins) trail as bare entries.
      { name: 'compact', description: null, kind: 'command', source: 'cli' },
      { name: 'review', description: null, kind: 'command', source: 'cli' },
    ]);
  });

  it("offers the CLI's own commands in a folder no turn has ever run in", async () => {
    // The gap this closes: the harvest only exists once a turn has run in a
    // folder, and built-ins live in the binary, not on disk — so a fresh
    // folder used to autocomplete to NOTHING.
    const { service, cwd } = build(['clear', 'compact', 'geniro:review']);

    const skills = await service.list('claude', cwd);
    expect(skills).toEqual([
      { name: 'clear', description: null, kind: 'command', source: 'cli' },
      { name: 'compact', description: null, kind: 'command', source: 'cli' },
      {
        name: 'geniro:review',
        description: null,
        kind: 'command',
        source: 'cli',
      },
    ]);
  });

  it('lets a scanned skill keep its metadata over a reported name', async () => {
    const { service, cwd } = build(['deploy', 'clear']);
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');

    const skills = await service.list('claude', cwd);
    expect(skills).toEqual([
      {
        name: 'deploy',
        description: 'Ship it',
        kind: 'skill',
        source: 'project',
      },
      { name: 'clear', description: null, kind: 'command', source: 'cli' },
    ]);
  });

  it('asks each CLI only about itself', async () => {
    const { service, cwd, harvest, claude, cursor } = build(['clear']);
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');
    harvest.record('claude', realpathSync(cwd), ['compact']);

    // The claude harvest and the claude catalog are claude's alone: neither
    // may leak into what a cursor chat is told it can run.
    const skills = await service.list('cursor-agent', cwd);
    expect(skills.map((entry) => entry.name)).toEqual(['fix']);
    expect(cursor.asked).toBe(1);
    expect(claude.asked).toBe(0);
  });

  it('asks the CLI once and reuses the answer across folders', async () => {
    // Asking costs a (cancelled) turn — the composer reads this list on every
    // folder change.
    const { service, cwd, claude } = build(['clear']);
    const other = tempDir('skills-other-');

    await service.list('claude', cwd);
    await service.list('claude', other);

    expect(claude.asked).toBe(1);
  });

  it('re-asks once the cached answer goes stale', async () => {
    let clock = 1_000;
    const { service, cwd, claude } = build(['clear'], {
      now: () => clock,
      catalogTtlMs: 500,
    });

    await service.list('claude', cwd);
    clock += 501;
    await service.list('claude', cwd);

    expect(claude.asked).toBe(2);
  });

  it('coalesces concurrent reads into ONE ask', async () => {
    const { service, cwd, claude } = build(['clear']);

    await Promise.all([
      service.list('claude', cwd),
      service.list('claude', cwd),
    ]);

    expect(claude.asked).toBe(1);
  });

  it('caches a CLI that answered nothing, rather than re-asking every read', async () => {
    // A broken or unauthenticated install reports []; re-probing on every
    // autocomplete read would spawn a turn per keystroke-triggered fetch.
    const { service, cwd, claude } = build([]);

    await service.list('claude', cwd);
    await service.list('claude', cwd);

    expect(claude.asked).toBe(1);
  });

  it('still lists the disk scan when asking the CLI fails outright', async () => {
    const { service, cwd, claude } = build([]);
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');
    claude.listReportedCommands = () => Promise.reject(new Error('boom'));

    const skills = await service.list('claude', cwd);
    expect(skills.map((entry) => entry.name)).toEqual(['deploy']);
  });

  it('rejects an invalid cwd with INVALID_CWD instead of scanning', async () => {
    const { service } = build();
    await expect(
      service.list('claude', '/definitely/not/a/real/dir'),
    ).rejects.toThrow(/INVALID_CWD|does not exist/);
  });
});
