import { basename } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentRepoInstructions } from '../../agents/adapters/adapter.types';
import {
  ContextBreakdownWireSchema,
  type MemberTurnReading,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { SessionContextReadingDao } from '../../agents/dao/session-context-reading.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { McpHarvestStore } from '../../agents/services/mcp-harvest.store';
import {
  measureRepoInstructionFiles,
  type RepoInstructionFiles,
} from '../../agents/utils/repo-instruction-files';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { SessionContextReading } from '../../runs/entity/session-context-reading.entity';
import { type AgentKind, AgentKindSchema } from '../../runs/runs.types';
import {
  FRESH_SESSION_UNMEASURED_PARTS,
  type FreshSessionBase,
  type FreshSessionBasesWire,
  type FreshSessionContextReading,
  type Team,
} from '../teams.types';
import {
  foldFreshStarts,
  FRESH_SESSION_RUNS_READ,
  type FreshSessionGroup,
  type FreshSessionRun,
  type FreshStartFold,
} from '../utils/fresh-session-base';
import {
  type InstructionSizesInput,
  InstructionSizesService,
} from './instruction-sizes.service';

const NO_READING_REASON =
  'not measured: no fresh session in the group stored its CLI’s own breakdown — it is asked when a session opens, on a CLI that can answer';

const PLUGINS_UNATTRIBUTED_REASON =
  'not measured: the CLI ties a plugin’s skills and agents to it, but not what its hooks add, and plugin skills share one listing budget with every other skill, so a sum per plugin is not what a plugin costs';

const NO_START_REASON = 'no fresh session of this member in the runs read';

const LEFT_TEAM_REASON =
  'the member is no longer in the team, so its instruction block cannot be composed';

const NO_BLOCK_REASON =
  "it is the base less Geniro's instruction block, which was not measured";

/**
 * What a member's fresh CLI session starts with: the context its sessions
 * opened at in the team's newest runs, beside the parts of it that can be
 * measured — Geniro's instruction block, the repository's instruction files on
 * disk, the MCP servers the CLI last reported in that folder, and the CLI's
 * own breakdown stored when the newest session opened.
 */
@Injectable()
export class FreshSessionBaseService {
  private readonly logger = new Logger(FreshSessionBaseService.name);

  constructor(
    private readonly runs: RunDao,
    private readonly items: ItemDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly harvest: McpHarvestStore,
    private readonly projects: ProjectScopeService,
    private readonly sizes: InstructionSizesService,
    private readonly contextReadings: SessionContextReadingDao,
  ) {}

  async measure(input: {
    slug: string;
    team: Team;
    settings: Omit<InstructionSizesInput, 'team'>;
    projectId?: string | null;
  }): Promise<FreshSessionBasesWire> {
    const read = await this.runs.newestTeamRuns(
      input.slug,
      FRESH_SESSION_RUNS_READ,
      null,
    );
    const placed = await Promise.all(
      read.map(async (run): Promise<FreshSessionRun> => ({
        id: run.id,
        cwd: run.cwd,
        group: await this.groupOf(run),
      })),
    );
    const runs =
      input.projectId === undefined || input.projectId === null
        ? placed
        : placed.filter((run) => run.group.projectId === input.projectId);
    const runIds = runs.map((run) => run.id);
    const [turnReadings, stored] = await Promise.all([
      this.items.memberTurnReadings(runIds),
      this.contextReadings.listOfRuns(runIds),
    ]);
    const folds = foldFreshStarts(runs, turnReadings);
    const groupOfRun = new Map(runs.map((run) => [run.id, run.group]));
    const blockTokens = new Map(
      this.sizes
        .measure({ ...input.settings, team: input.team })
        .members.map((member) => [member.memberId, member.approxTokens]),
    );
    const measuredAt = new Date().toISOString();
    const repoReadings = new Map<string, Promise<RepoInstructionFiles>>();
    const members: FreshSessionBase[] = [];
    for (const fold of folds) {
      members.push(
        await this.entryOf(
          fold,
          input.team,
          blockTokens,
          measuredAt,
          repoReadings,
          contextReadingOf(fold, stored, groupOfRun, turnReadings),
        ),
      );
    }
    const started = new Set(folds.map((fold) => fold.memberId));
    for (const member of input.team.members) {
      if (!started.has(member.id)) {
        members.push(
          unstartedEntry(
            member.id,
            member.agent,
            blockTokens.get(member.id) ?? null,
          ),
        );
      }
    }
    return { runsRead: runs.length, measuredAt, members };
  }

  private async groupOf(
    run: Parameters<ProjectScopeService['projectOfRun']>[0],
  ): Promise<FreshSessionGroup> {
    try {
      const project = await this.projects.projectOfRun(run);
      if (project !== null) {
        return { projectId: project.id, name: project.name };
      }
    } catch (error) {
      this.logger.warn(
        `project of a run not read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      projectId: null,
      name: run.cwd === null ? 'no folder' : basename(run.cwd),
    };
  }

  private async entryOf(
    fold: FreshStartFold,
    team: Team,
    blockTokens: ReadonlyMap<string, number>,
    measuredAt: string,
    repoReadings: Map<string, Promise<RepoInstructionFiles>>,
    contextReading: FreshSessionContextReading | null,
  ): Promise<FreshSessionBase> {
    const agent = agentKindOf(fold.agent);
    const adapter = agent === null ? undefined : this.adapters.all().get(agent);
    const teamBlockTokens = blockTokens.get(fold.memberId) ?? null;
    const repo =
      agent === null || adapter === undefined
        ? unavailable(
            'the CLI these starts ran on is not one geniro drives now',
          )
        : fold.newestCwd === null
          ? unavailable('the run named no folder')
          : await repoFilesOf(
              agent,
              adapter.getConfig().repoInstructions,
              fold.newestCwd,
              repoReadings,
            );
    const mcp =
      agent === null || fold.newestCwd === null
        ? null
        : this.harvest.getStaleReading(
            agent,
            fold.newestCwd,
            configDirOf(team, fold.memberId, fold.poolMember),
          );
    const base = fold.baseTokens;
    const repoTokens = repo.kind === 'measured' ? repo.approxTokens : null;
    const remainder =
      teamBlockTokens === null
        ? null
        : base - teamBlockTokens - (repoTokens ?? 0);
    return {
      memberId: fold.memberId,
      poolMember: fold.poolMember,
      agent: fold.agent,
      model: fold.model,
      project: fold.group,
      starts: fold.starts,
      baseTokens: base,
      baseSource: fold.baseSource,
      minTokens: fold.minTokens,
      maxTokens: fold.maxTokens,
      medianRequests: fold.medianRequests,
      firstStartAt: fold.firstStartAt.toISOString(),
      lastStartAt: fold.lastStartAt.toISOString(),
      teamBlockTokens,
      teamBlockShare: shareOf(teamBlockTokens, base),
      teamBlockUnavailableReason:
        teamBlockTokens === null ? LEFT_TEAM_REASON : null,
      repoFiles:
        repo.kind === 'measured'
          ? {
              measuredAt,
              root: repo.root,
              chars: repo.chars,
              approxTokens: repo.approxTokens,
              share: shareOf(repo.approxTokens, base),
              files: repo.files,
            }
          : null,
      repoFilesUnavailableReason: repo.kind === 'measured' ? null : repo.reason,
      cliRemainderTokens: remainder,
      cliRemainderShare: remainder === null ? null : shareOf(remainder, base),
      cliRemainderUnavailableReason:
        remainder === null ? NO_BLOCK_REASON : null,
      mcpServers:
        mcp === null
          ? null
          : {
              harvestedAt: new Date(mcp.harvestedAt).toISOString(),
              names: mcp.servers.map((server) => server.name),
            },
      mcpServersUnavailableReason:
        mcp === null
          ? 'no turn of this CLI in that folder has reported its MCP servers'
          : null,
      contextReading,
      notMeasured: notMeasured(contextReading !== null),
    };
  }
}

function contextReadingOf(
  fold: FreshStartFold,
  stored: readonly SessionContextReading[],
  groupOfRun: ReadonlyMap<string, FreshSessionGroup>,
  turnReadings: readonly MemberTurnReading[],
): FreshSessionContextReading | null {
  const groupKey = groupKeyOf(fold.group);
  for (const row of stored) {
    const group = groupOfRun.get(row.runId);
    if (
      row.memberId !== fold.memberId ||
      (row.poolMember ?? 1) !== (fold.poolMember ?? 1) ||
      group === undefined ||
      groupKeyOf(group) !== groupKey
    ) {
      continue;
    }
    const breakdown = parseBreakdown(row.breakdown);
    if (breakdown === null) {
      continue;
    }
    const firstRequestTokens = openingFirstRequest(
      turnReadings,
      row.runId,
      row.sessionId,
    );
    return {
      runId: row.runId,
      measuredAt: row.createdAt.toISOString(),
      breakdown,
      firstRequestTokens,
      unattributedTokens:
        firstRequestTokens === null || breakdown.totalTokens === null
          ? null
          : firstRequestTokens - breakdown.totalTokens,
    };
  }
  return null;
}

function groupKeyOf(group: FreshSessionGroup): string {
  return group.projectId ?? `folder:${group.name}`;
}

function parseBreakdown(
  text: string,
): FreshSessionContextReading['breakdown'] | null {
  try {
    const parsed = ContextBreakdownWireSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function openingFirstRequest(
  turnReadings: readonly MemberTurnReading[],
  runId: string,
  sessionId: string,
): number | null {
  let opening: MemberTurnReading | null = null;
  for (const reading of turnReadings) {
    if (
      reading.runId === runId &&
      reading.sessionId === sessionId &&
      (opening === null || reading.seq < opening.seq)
    ) {
      opening = reading;
    }
  }
  const tokens = opening?.firstRequestContextTokens ?? null;
  return tokens !== null && Number.isFinite(tokens) && tokens > 0
    ? tokens
    : null;
}

function repoFilesOf(
  agent: AgentKind,
  spec: AgentRepoInstructions,
  cwd: string,
  readings: Map<string, Promise<RepoInstructionFiles>>,
): Promise<RepoInstructionFiles> {
  const key = `${agent}\u0000${cwd}`;
  let reading = readings.get(key);
  if (reading === undefined) {
    reading = measureRepoInstructionFiles(spec, cwd);
    readings.set(key, reading);
  }
  return reading;
}

function unstartedEntry(
  memberId: string,
  agent: string,
  teamBlockTokens: number | null,
): FreshSessionBase {
  return {
    memberId,
    poolMember: null,
    agent,
    model: null,
    project: null,
    starts: 0,
    baseTokens: null,
    baseSource: null,
    minTokens: null,
    maxTokens: null,
    medianRequests: null,
    firstStartAt: null,
    lastStartAt: null,
    teamBlockTokens,
    teamBlockShare: null,
    teamBlockUnavailableReason:
      teamBlockTokens === null ? LEFT_TEAM_REASON : null,
    repoFiles: null,
    repoFilesUnavailableReason: NO_START_REASON,
    cliRemainderTokens: null,
    cliRemainderShare: null,
    cliRemainderUnavailableReason: NO_START_REASON,
    mcpServers: null,
    mcpServersUnavailableReason: NO_START_REASON,
    contextReading: null,
    notMeasured: notMeasured(false),
  };
}

function notMeasured(hasReading: boolean): FreshSessionBase['notMeasured'] {
  if (hasReading) {
    return [{ part: 'plugins', reason: PLUGINS_UNATTRIBUTED_REASON }];
  }
  return FRESH_SESSION_UNMEASURED_PARTS.map((part) => ({
    part,
    reason: NO_READING_REASON,
  }));
}

function unavailable(reason: string): RepoInstructionFiles {
  return { kind: 'unavailable', reason };
}

function agentKindOf(agent: string | null): AgentKind | null {
  const parsed = AgentKindSchema.safeParse(agent);
  return parsed.success ? parsed.data : null;
}

function configDirOf(
  team: Team,
  memberId: string,
  poolMember: number | null,
): string | null {
  const member = team.members.find((candidate) => candidate.id === memberId);
  if (member === undefined) {
    return null;
  }
  const runner =
    poolMember === null || poolMember <= 1
      ? member
      : member.pool?.[poolMember - 2];
  return runner?.configDir ?? null;
}

function shareOf(part: number | null, whole: number): number | null {
  return part === null || whole <= 0
    ? null
    : Math.round((part / whole) * 1000) / 1000;
}
