import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type {
  AgentCommandOptions,
  AgentReportedCommand,
} from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type { AgentSkillWire } from '../chat.types';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
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
 * The rows that were DISCOVERED — the disk scan, the harvest, the CLI's own
 * report — with geniro's own commands dropped.
 *
 * Those lead every list unconditionally and are asserted on their own below;
 * folding them into each scan expectation would restate one fact in eight
 * places and make every one of them fail when a command is added.
 */
const discovered = (skills: AgentSkillWire[]): AgentSkillWire[] =>
  skills.filter((skill) => skill.source !== 'geniro');

/** A reported command with no sentence — claude's whole report shape. */
const named = (name: string): AgentReportedCommand => ({
  name,
  description: null,
});

/**
 * The real adapters — so the composition under test runs against the real disk
 * scan — with only the CLI-asking method scripted, since that spawns a turn.
 */
class ScriptedClaude extends ClaudeAdapter {
  asked = 0;

  constructor(private readonly reported: AgentReportedCommand[]) {
    super();
  }

  override listReportedCommands(
    _options: AgentCommandOptions = {},
  ): Promise<AgentReportedCommand[]> {
    this.asked += 1;
    return Promise.resolve(this.reported);
  }
}

class ScriptedCursor extends CursorAcpAdapter {
  // The store is a REQUIRED dependency of the real adapter, and a spec
  // subclass has to satisfy it like any other caller — see
  // `freshVocabularyStore`.
  constructor() {
    super({ vocabularyStore: freshVocabularyStore() });
  }

  asked = 0;

  override listReportedCommands(): Promise<AgentReportedCommand[]> {
    this.asked += 1;
    return Promise.resolve([]);
  }
}

function build(
  catalog: AgentReportedCommand[] = [],
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
    file: join(tempDir('skills-harvest-'), 'skill-harvest.json'),
  });
  const claude = new ScriptedClaude(catalog);
  const cursor = new ScriptedCursor();
  return {
    service: new SkillsService(
      harvest,
      new AgentAdapterRegistry([claude, cursor]),
      new ProcessRegistry(),
      new AgentVersionService(),
      {
        homeDir: home,
        resolveVersionFn: () => Promise.resolve('pinned'),
        ...options,
      },
    ),
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
    expect(discovered(skills)).toEqual([
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
    harvest.record('claude', realpathSync(cwd), null, [
      named('condense'),
      named('deploy'),
      named('review'),
    ]);

    const skills = await service.list('claude', cwd);
    expect(discovered(skills)).toEqual([
      // The scanned entry wins its collision and keeps its description…
      {
        name: 'deploy',
        description: 'Ship it',
        kind: 'skill',
        source: 'project',
      },
      // …and the CLI-only names (built-ins/plugins) trail as bare entries.
      { name: 'condense', description: null, kind: 'command', source: 'cli' },
      { name: 'review', description: null, kind: 'command', source: 'cli' },
    ]);
  });

  it("offers the CLI's own commands in a folder no turn has ever run in", async () => {
    // The gap this closes: the harvest only exists once a turn has run in a
    // folder, and built-ins live in the binary, not on disk — so a fresh
    // folder used to autocomplete to NOTHING.
    const { service, cwd } = build([
      named('clear'),
      named('condense'),
      named('geniro:review'),
    ]);

    const skills = await service.list('claude', cwd);
    expect(discovered(skills)).toEqual([
      { name: 'clear', description: null, kind: 'command', source: 'cli' },
      { name: 'condense', description: null, kind: 'command', source: 'cli' },
      {
        name: 'geniro:review',
        description: null,
        kind: 'command',
        source: 'cli',
      },
    ]);
  });

  it('lets a scanned skill keep its metadata over a reported name', async () => {
    const { service, cwd } = build([named('deploy'), named('clear')]);
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');

    const skills = await service.list('claude', cwd);
    expect(discovered(skills)).toEqual([
      {
        name: 'deploy',
        description: 'Ship it',
        kind: 'skill',
        source: 'project',
      },
      { name: 'clear', description: null, kind: 'command', source: 'cli' },
    ]);
  });

  it('shows the DESCRIPTION a CLI reported for a command it alone knows', async () => {
    // cursor-agent has no scannable convention behind its built-ins, and its
    // ACP report is the only place their sentences exist. Reading just the
    // name left every row in the popup a bare word — the reported defect.
    const { service, cwd, harvest } = build();
    harvest.record('cursor-agent', realpathSync(cwd), null, [
      { name: 'shell', description: 'Runs the rest as a shell command' },
    ]);

    const skills = await service.list('cursor-agent', cwd);
    expect(discovered(skills)).toEqual([
      {
        name: 'shell',
        description: 'Runs the rest as a shell command',
        kind: 'command',
        source: 'cli',
      },
    ]);
  });

  it('fills a SCANNED entry’s missing description from the CLI’s report', async () => {
    // First occurrence still wins the entry — the row keeps `command`/`project`
    // — but a file with no frontmatter description scans to a bare name, and
    // preferring that silence would throw away the only sentence anyone has.
    const { service, cwd, harvest } = build();
    // Frontmatter naming no description and no body to fall back on.
    writeCommand(cwd, '.cursor', 'fix.md', '---\nallowed-tools: Bash\n---\n');
    harvest.record('cursor-agent', realpathSync(cwd), null, [
      { name: 'fix', description: 'Repair the failing build' },
    ]);

    const skills = await service.list('cursor-agent', cwd);
    expect(discovered(skills)).toEqual([
      {
        name: 'fix',
        description: 'Repair the failing build',
        kind: 'command',
        source: 'project',
      },
    ]);
  });

  it('asks each CLI only about itself', async () => {
    const { service, cwd, harvest, claude, cursor } = build([named('clear')]);
    writeCommand(cwd, '.cursor', 'fix.md', 'Fix the thing.');
    harvest.record('claude', realpathSync(cwd), null, [named('condense')]);

    // The claude harvest and the claude catalog are claude's alone: neither
    // may leak into what a cursor chat is told it can run.
    const skills = await service.list('cursor-agent', cwd);
    expect(discovered(skills).map((entry) => entry.name)).toEqual(['fix']);
    expect(cursor.asked).toBe(1);
    expect(claude.asked).toBe(0);
  });

  it('asks the CLI once and reuses the answer across folders', async () => {
    // Asking costs a (cancelled) turn — the composer reads this list on every
    // folder change.
    const { service, cwd, claude } = build([named('clear')]);
    const other = tempDir('skills-other-');

    await service.list('claude', cwd);
    await service.list('claude', other);

    expect(claude.asked).toBe(1);
  });

  it('re-asks once the cached answer goes stale', async () => {
    let clock = 1_000;
    const { service, cwd, claude } = build([named('clear')], {
      now: () => clock,
      catalogTtlMs: 500,
    });

    await service.list('claude', cwd);
    clock += 501;
    await service.list('claude', cwd);

    expect(claude.asked).toBe(2);
  });

  it('coalesces concurrent reads into ONE ask', async () => {
    const { service, cwd, claude } = build([named('clear')]);

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
    expect(discovered(skills).map((entry) => entry.name)).toEqual(['deploy']);
  });

  it("leads with geniro's own commands, ahead of everything discovered", async () => {
    const { service, cwd } = build();
    writeSkill(cwd, 'aaa-first-alphabetically', 'description: Scanned');

    const skills = await service.list('claude', cwd);
    const first = skills[0];
    expect(first?.source).toBe('geniro');
    expect(first?.name).toBe('compact');
    // Its own sentence, not a bare name: these rows are authored here, so a
    // description is the one thing they can never be missing.
    expect(first?.description).toBeTruthy();
  });

  it('reserves a geniro name against a scanned skill that would shadow it', async () => {
    // ChatService dispatches `/compact` by name whatever the folder holds, so
    // a project skill winning the ROW would be offered by the popup and never
    // be the thing that ran.
    const { service, cwd } = build();
    writeSkill(cwd, 'compact', 'name: compact\ndescription: My own compact');

    const rows = (await service.list('claude', cwd)).filter(
      (skill) => skill.name === 'compact',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('geniro');
  });

  it('offers no geniro command for a CLI whose adapter declares none', async () => {
    // Per-CLI availability is the adapter's fact. Pinned through the REAL
    // cursor adapter so this fails if that declaration is dropped.
    const { service, cwd, cursor } = build();
    expect(cursor.listGeniroCommands().map((c) => c.name)).toEqual(['compact']);

    const names = (await service.list('cursor-agent', cwd))
      .filter((skill) => skill.source === 'geniro')
      .map((skill) => skill.name);
    expect(names).toEqual(['compact']);
  });

  it('returns every entry uncapped — the list is also what a send is checked against', async () => {
    // More reported commands than the 200 rows the reply was once cut to, so
    // the ones sorting last (the CLI's report, alphabetically) are the ones a
    // cap would drop — and the composer would then refuse to send them.
    const reported = Array.from({ length: 250 }, (_, i) =>
      named(`cmd-${String(i).padStart(3, '0')}`),
    );
    const { service, cwd } = build(reported);
    writeSkill(cwd, 'deploy', 'name: deploy\ndescription: Ship it');

    const names = discovered(await service.list('claude', cwd)).map(
      (skill) => skill.name,
    );
    expect(names).toHaveLength(251);
    expect(names.at(-1)).toBe('cmd-249');
  });

  it('rejects an invalid cwd with INVALID_CWD instead of scanning', async () => {
    const { service } = build();
    await expect(
      service.list('claude', '/definitely/not/a/real/dir'),
    ).rejects.toThrow(/INVALID_CWD|does not exist/);
  });
});

/**
 * A claude adapter whose command probe is answered BY THE SPEC, one call at a
 * time — so a spec can hold an ask open across something else happening.
 */
class HeldClaude extends ClaudeAdapter {
  readonly calls: {
    configDir: string | null | undefined;
    answer: (commands: AgentReportedCommand[]) => void;
  }[] = [];

  override listReportedCommands(
    options: AgentCommandOptions = {},
  ): Promise<AgentReportedCommand[]> {
    return new Promise((resolve) => {
      this.calls.push({ configDir: options.configDir, answer: resolve });
    });
  }
}

/** Resolve once `predicate` holds, polling the event loop rather than ticks. */
async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('SkillsService — the command catalog per profile', () => {
  function held(
    resolveVersionFn: () => Promise<string | null> = () =>
      Promise.resolve('pinned'),
  ): { service: SkillsService; claude: HeldClaude; cwd: string } {
    const claude = new HeldClaude();
    const service = new SkillsService(
      new SkillHarvestStore({
        file: join(tempDir('skills-harvest-'), 'claude-skills.json'),
      }),
      new AgentAdapterRegistry([claude, new ScriptedCursor()]),
      new ProcessRegistry(),
      new AgentVersionService(),
      { homeDir: tempDir('skills-home-'), resolveVersionFn },
    );
    return { service, claude, cwd: tempDir('skills-cwd-') };
  }

  const names = (skills: AgentSkillWire[]): string[] =>
    discovered(skills).map((entry) => entry.name);

  it('asks under the chat’s PROFILE, and keeps each profile’s answer apart', async () => {
    // A profile carries its own installed plugins, and their commands are half
    // of this catalog. The probe ran under the DEFAULT profile and the answer
    // was filed under the agent alone, so a chat on a profile was offered the
    // default account's plugin commands and never its own.
    const { service, claude, cwd } = held();
    const profileA = tempDir('skills-profile-a-');
    const profileB = tempDir('skills-profile-b-');

    const first = service.list('claude', cwd, profileA);
    await until(() => claude.calls.length === 1);
    claude.calls[0]?.answer([named('a-plugin:cmd')]);
    const second = service.list('claude', cwd, profileB);
    await until(() => claude.calls.length === 2);
    claude.calls[1]?.answer([named('b-plugin:cmd')]);

    expect(claude.calls.map((call) => call.configDir)).toEqual([
      profileA,
      profileB,
    ]);
    expect(names(await first)).toEqual(['a-plugin:cmd']);
    expect(names(await second)).toEqual(['b-plugin:cmd']);
  });

  it('spawns ONE probe for concurrent reads, even while the version is resolving', async () => {
    // The single-flight was registered only AFTER the `--version` await, so two
    // composers opening together both found it empty and both spawned a probe
    // turn. The existing coalescing case resolves the version instantly, which
    // is the one timing that hid it.
    let releaseVersion!: (version: string) => void;
    const version = new Promise<string>((resolve) => {
      releaseVersion = resolve;
    });
    const { service, claude, cwd } = held(() => version);
    const profiles = vi.spyOn(claude, 'vocabularyProfile');

    const reads = Promise.all([
      service.list('claude', cwd),
      service.list('claude', cwd),
    ]);
    // Both reads are past their disk scan and at the single-flight — the one
    // named just before the version await.
    await until(() => profiles.mock.calls.length === 2);
    releaseVersion('pinned');
    // Answer every probe that turns up until both reads are done: a second
    // one, if the single-flight let it through, is answered too and counted.
    let done = false;
    void reads.then(() => {
      done = true;
    });
    await until(() => {
      for (const call of claude.calls) {
        call.answer([named('clear')]);
      }
      return done;
    });

    expect(claude.calls).toHaveLength(1);
  });

  it('is emptied by Clear Agent Cache, like every other cached CLI answer', async () => {
    const { service, claude, cwd } = held();
    let answered = 0;
    const read = async (): Promise<void> => {
      const pending = service.list('claude', cwd);
      await until(() => claude.calls.length > answered);
      claude.calls[answered]?.answer([named('clear')]);
      answered += 1;
      await pending;
    };
    await read();

    expect(service.clearCache()).toBe(1);
    const second = service.list('claude', cwd);
    // A fresh probe, which only a cleared catalog would ask for — without the
    // clear this read is a cache hit and no second call ever arrives.
    await until(() => claude.calls.length === 2);
    claude.calls[1]?.answer([named('clear')]);
    await second;

    expect(claude.calls).toHaveLength(2);
  });

  it('discards an answer that was being asked when the account changed', async () => {
    // A sign-in replaces the credentials the running probe was taken under, so
    // its answer describes the previous account. Filing it after the forget
    // would put that account's commands straight back for the whole TTL.
    const { service, claude, cwd } = held();
    const before = service.list('claude', cwd);
    await until(() => claude.calls.length === 1);

    service.forgetAgent('claude');
    const after = service.list('claude', cwd);
    await until(() => claude.calls.length === 2);
    claude.calls[0]?.answer([named('old-account')]);
    claude.calls[1]?.answer([named('new-account')]);

    expect(names(await before)).toEqual(['old-account']);
    expect(names(await after)).toEqual(['new-account']);
    // And nothing of the old answer was filed: the next read is served the
    // new account's catalog from the cache, with no third probe.
    expect(names(await service.list('claude', cwd))).toEqual(['new-account']);
    expect(claude.calls).toHaveLength(2);
  });
});
