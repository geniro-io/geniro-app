import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import type { AgentMcpServer } from '../../agents/adapters/adapter.types';
import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentMcpService } from '../../agents/services/agent-mcp.service';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { AgentVersionService } from '../../agents/services/agent-version.service';
import { McpHarvestStore } from '../../agents/services/mcp-harvest.store';
import { ModelsService } from '../../agents/services/models.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { CLI_PATHS_ENV } from '../../agents/utils/agent-binary';
import { member, teamOf } from '../__tests__/team-builders';
import type { Team, TeamMember } from '../teams.types';
import { TeamHealthService } from './team-health.service';
import type { TeamOverlayService } from './team-overlay.service';

const dirs: string[] = [];

function realDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-health-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function mcpServer(
  name: string,
  status: AgentMcpServer['status'],
): AgentMcpServer {
  return { name, target: null, transport: null, status, detail: null };
}

interface Harness {
  service: TeamHealthService;
  harvest: McpHarvestStore;
  folderless: string;
  listMcpServers: ReturnType<typeof vi.fn>;
  mcpList: ReturnType<typeof vi.spyOn>;
  vocabularies: ReturnType<typeof freshVocabularyStore>;
}

function harness(
  team: Team,
  options: {
    version?: string | null;
    projects?: Record<string, Team>;
  } = {},
): Harness {
  const { version = '1.0.0', projects = {} } = options;
  const listMcpServers = vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      servers: [mcpServer('live', 'connected')],
    }),
  );
  const adapter = {
    listMcpServers,
    forgetMcpNeedsAuth: () => Promise.resolve([]),
    readMcpFolderFacts: () =>
      Promise.resolve({
        disabled: [],
        lockedOff: [],
        origins: {},
        interactiveOnlyNote: null,
        plugins: [],
      }),
    listEfforts: () => [{ id: 'low', label: 'Low' }],
    vocabularyProfile: (configDir: string | null) => configDir,
    getConfig: () => ({
      identity: { displayName: 'Test CLI' },
      configDir: { unavailableReason: null },
      effortsAreExhaustive: true,
      mcp: {
        listingUnavailableReason: null,
        toggleUnavailableReason: null,
        approveUnavailableReason: null,
        turnToggleUnavailableReason: null,
        userDisabledReason: 'you switched it off yourself',
        changeReach: {
          toggle: { where: 'folder', perProfile: true },
          signIn: { where: 'folder', perProfile: true },
        },
      },
    }),
  } as unknown as AgentAdapter;
  const adapters = { for: () => adapter } as unknown as AgentAdapterRegistry;
  const folderless = join(realDir(), 'folderless');
  const harvest = new McpHarvestStore({
    file: join(realDir(), 'mcp-harvest.json'),
  });
  const versions = {
    resolve: () => Promise.resolve(version),
  } as unknown as AgentVersionService;
  const mcp = new AgentMcpService(
    adapters,
    new ProcessRegistry(),
    versions,
    harvest,
    new AgentSessionRegistry(),
    {
      resolveVersionFn: () => Promise.resolve(version),
      folderlessDir: folderless,
    },
  );
  const vocabularies = freshVocabularyStore();
  const overlays = {
    effectiveBySlug: (_slug: string, projectId: string | null) =>
      Promise.resolve({
        team: (projectId === null ? undefined : projects[projectId]) ?? team,
        overlay: null,
      }),
  } as unknown as TeamOverlayService;
  const service = new TeamHealthService(
    overlays,
    adapters,
    versions,
    mcp,
    new ProcessRegistry(),
    new ModelsService(adapters, new ProcessRegistry(), versions, vocabularies),
  );
  return {
    service,
    harvest,
    folderless,
    listMcpServers,
    mcpList: vi.spyOn(mcp, 'list'),
    vocabularies,
  };
}

function seedFolderless(h: Harness, servers: AgentMcpServer[]): void {
  h.harvest.record('claude', realpathSync(h.folderless), null, servers);
}

describe('TeamHealthService', () => {
  it('marks a missing profile folder red', async () => {
    const gone = join(realDir(), 'gone');
    const team = teamOf([member('dev', { configDir: gone })]);
    const h = harness(team);

    const health = await h.service.health('team', false);

    expect(health.blocking).toBe(true);
    expect(health.members).toMatchObject([
      {
        memberId: 'dev',
        status: 'error',
        problems: [
          { kind: 'profile_missing', level: 'error', configDir: gone },
        ],
      },
    ]);
    expect(await h.service.blockingProblems(team)).toMatchObject([
      { kind: 'profile_missing' },
    ]);
  });

  it('checks the team as the asked project runs it', async () => {
    const gone = join(realDir(), 'gone');
    const shared = teamOf([member('dev')]);
    const h = harness(shared, {
      projects: { p1: teamOf([member('dev', { configDir: gone })]) },
    });

    expect((await h.service.health('team', false)).blocking).toBe(false);
    const inProject = await h.service.health('team', false, 'p1');
    expect(inProject.blocking).toBe(true);
    expect(inProject.members[0]?.problems).toMatchObject([
      { kind: 'profile_missing', configDir: gone },
    ]);
    expect(
      (await h.service.memberHealth('team', 'dev', false, 'p1')).problems,
    ).toMatchObject([{ kind: 'profile_missing' }]);
  });

  it('marks needs_auth amber and does not block', async () => {
    const team = teamOf([member('dev')]);
    const h = harness(team);
    // Reading once creates the folderless directory the harvest is keyed by.
    await h.service.health('team', false);
    seedFolderless(h, [mcpServer('figma', 'needs_auth')]);

    const health = await h.service.health('team', false);

    expect(health.blocking).toBe(false);
    expect(health.members).toMatchObject([
      {
        status: 'warning',
        problems: [
          { kind: 'mcp_needs_auth', level: 'warning', server: 'figma' },
        ],
      },
    ]);
    expect(await h.service.blockingProblems(team)).toEqual([]);
  });

  it('does not dial MCP on the cheap path', async () => {
    const first: TeamMember = member('a');
    const second: TeamMember = member('b');
    const third: TeamMember = member('c', {
      pool: [{ agent: 'claude' }],
    });
    const team = teamOf([first, second, third]);
    const h = harness(team);

    await h.service.health('team', false);
    await h.service.blockingProblems(team);
    expect(h.mcpList).not.toHaveBeenCalled();
    expect(h.listMcpServers).not.toHaveBeenCalled();

    await h.service.health('team', true);
    expect(h.mcpList).toHaveBeenCalledTimes(1);
    expect(h.listMcpServers).toHaveBeenCalledTimes(1);
  });

  it('lists once per distinct profile when probing', async () => {
    const profile = realDir();
    const other = realDir();
    const team = teamOf([
      member('a', { configDir: profile }),
      member('b', { configDir: profile }),
      member('c', { configDir: other }),
    ]);
    const h = harness(team);

    await h.service.health('team', true);

    expect(h.mcpList).toHaveBeenCalledTimes(2);
  });

  it('reports a member as checking while its listing is still pending', async () => {
    const team = teamOf([member('dev')]);
    const h = harness(team);
    h.mcpList.mockResolvedValue({
      servers: [],
      unavailableReason: null,
      pending: true,
      interactiveOnlyNote: null,
      plugins: [],
    });

    const health = await h.service.health('team', true);

    expect(health.members[0]?.status).toBe('checking');
  });

  it('marks a CLI that is nowhere to be found red for the member that leads, amber for a call-only one', async () => {
    vi.stubEnv(CLI_PATHS_ENV, JSON.stringify({ claude: '/nowhere/claude' }));
    const team = teamOf([member('dev'), member('helper')]);
    const h = harness(team, { version: null });

    const missing = await h.service.health('team', false);
    const installed = await harness(team).service.health('team', false);

    expect(
      missing.members.map((entry) =>
        entry.problems.map((p) => [p.kind, p.level]),
      ),
    ).toEqual([[['cli_missing', 'error']], [['cli_missing', 'warning']]]);
    expect(
      (await h.service.blockingProblems(team)).map((p) => p.message),
    ).toEqual(['dev: Test CLI is not installed, so this member cannot run.']);
    expect(installed.members.map((entry) => entry.status)).toEqual([
      'ok',
      'ok',
    ]);
  });

  it('reads a CLI that is there but printed no version as unknown, amber, never blocking', async () => {
    const dir = realDir();
    const binary = join(dir, 'claude');
    writeFileSync(binary, '#!/bin/sh\nexit 1\n');
    chmodSync(binary, 0o755);
    vi.stubEnv(CLI_PATHS_ENV, JSON.stringify({ claude: binary }));
    const team = teamOf([member('dev')]);
    const h = harness(team, { version: null });

    const health = await h.service.health('team', false);

    expect(health.members[0]?.problems).toMatchObject([
      { kind: 'cli_unknown', level: 'warning' },
    ]);
    expect(await h.service.blockingProblems(team)).toEqual([]);
  });

  it('flags a model absent from a list the CLI reported, and stays silent without one', async () => {
    const team = teamOf([member('dev', { model: 'ghost-model' })]);
    const silent = harness(team);
    const answered = harness(team);
    answered.vocabularies.remember('claude', null, null, '1.0.0', [
      { id: 'real-model', label: 'Real', source: 'cli' },
    ]);

    const unknown = await silent.service.health('team', false);
    const flagged = await answered.service.health('team', false);

    expect(unknown.members[0]?.problems).toEqual([]);
    expect(flagged.members[0]?.problems).toMatchObject([
      { kind: 'model_not_offered', level: 'warning', model: 'ghost-model' },
    ]);
  });

  it('flags an effort the CLI does not list', async () => {
    const team = teamOf([member('dev', { effort: 'extreme' })]);

    const health = await harness(team).service.health('team', false);

    expect(health.members[0]?.problems).toMatchObject([
      { kind: 'effort_not_offered' },
    ]);
  });

  it('answers a single member and refuses an unknown one', async () => {
    const team = teamOf([member('dev')]);
    const h = harness(team);

    expect(await h.service.memberHealth('team', 'dev', false)).toEqual({
      memberId: 'dev',
      seats: [{ agent: 'claude', configDir: null, poolMember: null }],
      status: 'ok',
      checking: false,
      problems: [],
      mcpCheckedAt: null,
    });
    await expect(
      h.service.memberHealth('team', 'ghost', false),
    ).rejects.toThrow(/no member 'ghost'/);
  });
});
