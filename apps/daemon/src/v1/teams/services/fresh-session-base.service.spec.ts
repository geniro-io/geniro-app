import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import type { MemberTurnReading } from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { McpHarvestStore } from '../../agents/services/mcp-harvest.store';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import { member, teamOf } from '../__tests__/team-builders';
import { FreshSessionBaseService } from './fresh-session-base.service';
import type { InstructionSizesService } from './instruction-sizes.service';

const HARVESTED_AT = Date.UTC(2026, 10, 23, 9, 30);

describe('FreshSessionBaseService', () => {
  let repo: string;
  let harvested: unknown[];
  let readFor: string[][];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'geniro-fresh-base-'));
    await mkdir(join(repo, '.git'));
    await writeFile(join(repo, 'CLAUDE.md'), 'x'.repeat(400));
    harvested = [];
    readFor = [];
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function serviceOver(
    readings: MemberTurnReading[],
    projectOfRun?: (run: { projectId: string | null }) => Promise<unknown>,
  ): FreshSessionBaseService {
    const runs = [
      {
        id: 'r-geniro',
        cwd: repo,
        projectId: 'p1',
        projectSource: 'folder',
        taskId: null,
      },
      {
        id: 'r-loose',
        cwd: '/tmp/scratch-folder',
        projectId: null,
        projectSource: 'none',
        taskId: null,
      },
    ];
    return new FreshSessionBaseService(
      { newestTeamRuns: () => Promise.resolve(runs) } as unknown as RunDao,
      {
        memberTurnReadings: (runIds: readonly string[]) => {
          readFor.push([...runIds]);
          return Promise.resolve(
            readings.filter((row) => runIds.includes(row.runId)),
          );
        },
      } as unknown as ItemDao,
      new AgentAdapterRegistry([
        new ClaudeAdapter(),
        new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
      ]),
      {
        getStaleReading: (
          agent: string,
          cwd: string,
          configDir: string | null,
        ) => {
          harvested.push([agent, cwd, configDir]);
          return agent === 'claude'
            ? {
                servers: [{ name: 'codegraph' }, { name: 'blender' }],
                harvestedAt: HARVESTED_AT,
              }
            : null;
        },
      } as unknown as McpHarvestStore,
      {
        projectOfRun:
          projectOfRun ??
          ((run: { projectId: string | null }) =>
            Promise.resolve(
              run.projectId === null
                ? null
                : { id: run.projectId, name: 'Geniro' },
            )),
      } as unknown as ProjectScopeService,
      {
        measure: () => ({
          members: [
            { memberId: 'manager', approxTokens: 36_000 },
            { memberId: 'handyman', approxTokens: 18_000 },
            { memberId: 'reviewer', approxTokens: 12_000 },
          ],
        }),
      } as unknown as InstructionSizesService,
    );
  }

  const TEAM = teamOf([
    member('manager', { configDir: '/profiles/price-field' }),
    member('handyman', { agent: 'cursor-agent' }),
    member('reviewer'),
  ]);

  function start(
    runId: string,
    fields: Partial<MemberTurnReading>,
  ): MemberTurnReading {
    return {
      runId,
      seq: 1,
      kind: 'turn_complete',
      memberId: 'manager',
      createdAt: new Date(Date.UTC(2026, 10, 22)),
      sessionId: `${runId}-${fields.memberId ?? 'manager'}`,
      contextTokens: 144_982,
      numTurns: 3,
      agent: 'claude',
      model: 'sonnet',
      poolMember: null,
      ...fields,
    };
  }

  it('splits a member’s base into Geniro’s block, the repository files and the CLI’s remainder', async () => {
    const answer = await serviceOver([start('r-geniro', {})]).measure({
      slug: 'dev-team',
      team: TEAM,
      settings: {},
    });

    const manager = answer.members.find(
      (entry) => entry.memberId === 'manager',
    );
    expect(manager).toMatchObject({
      project: { projectId: 'p1', name: 'Geniro' },
      starts: 1,
      baseTokens: 144_982,
      medianRequests: 3,
      teamBlockTokens: 36_000,
      teamBlockShare: 0.248,
      repoFiles: {
        root: repo,
        chars: 400,
        approxTokens: 100,
        share: 0.001,
        files: [expect.objectContaining({ path: join(repo, 'CLAUDE.md') })],
      },
      repoFilesUnavailableReason: null,
      cliRemainderTokens: 144_982 - 36_000 - 100,
      cliRemainderShare: 0.751,
      mcpServers: {
        harvestedAt: new Date(HARVESTED_AT).toISOString(),
        names: ['codegraph', 'blender'],
      },
      mcpServersUnavailableReason: null,
    });
    expect(manager!.notMeasured.map((part) => part.part)).toEqual([
      'plugins',
      'skills',
      'builtInTools',
    ]);
    expect(harvested).toEqual([['claude', repo, '/profiles/price-field']]);
    expect(answer.runsRead).toBe(2);
  });

  it('says why for a CLI whose files and servers are not known, and gives a member with no start no base', async () => {
    const answer = await serviceOver([
      start('r-loose', {
        memberId: 'handyman',
        agent: 'cursor-agent',
        contextTokens: 119_207,
      }),
    ]).measure({ slug: 'dev-team', team: TEAM, settings: {} });

    const handyman = answer.members.find(
      (entry) => entry.memberId === 'handyman',
    );
    expect(handyman).toMatchObject({
      project: { projectId: null, name: 'scratch-folder' },
      baseTokens: 119_207,
      repoFiles: null,
      repoFilesUnavailableReason: expect.stringContaining('cursor-agent'),
      cliRemainderTokens: 119_207 - 18_000,
      mcpServers: null,
      mcpServersUnavailableReason: expect.any(String),
    });
    const reviewer = answer.members.find(
      (entry) => entry.memberId === 'reviewer',
    );
    expect(reviewer).toMatchObject({
      starts: 0,
      baseTokens: null,
      cliRemainderTokens: null,
      teamBlockTokens: 12_000,
      project: null,
    });
  });

  it('reads only the runs of the project asked for', async () => {
    const answer = await serviceOver([
      start('r-geniro', {}),
      start('r-loose', { contextTokens: 199_000 }),
    ]).measure({ slug: 'dev-team', team: TEAM, settings: {}, projectId: 'p1' });

    expect(readFor).toEqual([['r-geniro']]);
    expect(answer.runsRead).toBe(1);
    expect(
      answer.members
        .filter((entry) => entry.memberId === 'manager')
        .map((entry) => entry.baseTokens),
    ).toEqual([144_982]);
  });
  it('groups by the folder when a run’s project cannot be read', async () => {
    const answer = await serviceOver([start('r-geniro', {})], () =>
      Promise.reject(new Error('SQLITE_BUSY')),
    ).measure({ slug: 'dev-team', team: TEAM, settings: {} });

    expect(
      answer.members.find((entry) => entry.memberId === 'manager')!.project,
    ).toEqual({ projectId: null, name: basename(repo) });
  });

  it('reads the MCP servers of the pool member that ran the start, under its own profile', async () => {
    const pooled = teamOf([
      member('manager', {
        configDir: '/profiles/first',
        pool: [
          { agent: 'claude', configDir: '/profiles/second' },
          { agent: 'claude', configDir: '/profiles/third' },
        ],
      }),
    ]);

    await serviceOver([start('r-geniro', { poolMember: 3 })]).measure({
      slug: 'dev-team',
      team: pooled,
      settings: {},
    });

    expect(harvested).toEqual([['claude', repo, '/profiles/third']]);
  });

  it('measures no CLI remainder for a member no longer in the team, rather than counting its block as the CLI’s', async () => {
    const answer = await serviceOver([
      start('r-geniro', { memberId: 'retired' }),
    ]).measure({ slug: 'dev-team', team: TEAM, settings: {} });

    expect(
      answer.members.find((entry) => entry.memberId === 'retired'),
    ).toMatchObject({
      baseTokens: 144_982,
      teamBlockTokens: null,
      cliRemainderTokens: null,
      cliRemainderShare: null,
    });
  });
});
