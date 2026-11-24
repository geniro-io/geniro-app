import { basename } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentRepoInstructions } from '../../agents/adapters/adapter.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { McpHarvestStore } from '../../agents/services/mcp-harvest.store';
import {
  measureRepoInstructionFiles,
  type RepoInstructionFiles,
} from '../../agents/utils/repo-instruction-files';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { type AgentKind, AgentKindSchema } from '../../runs/runs.types';
import {
  FRESH_SESSION_UNMEASURED_PARTS,
  type FreshSessionBase,
  type FreshSessionBasesWire,
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

const NOT_MEASURED_REASON: Record<
  (typeof FRESH_SESSION_UNMEASURED_PARTS)[number],
  string
> = {
  plugins:
    'not measured: a CLI names its plugins only in the event that starts a session, which geniro does not keep',
  skills:
    'not measured: a CLI names its skills only in the event that starts a session, which geniro does not keep',
  builtInTools:
    'not measured: a CLI lists its built-in tools only in the event that starts a session, which geniro does not keep',
};

const NO_START_REASON = 'no fresh session of this member in the runs read';

/**
 * What a member's fresh CLI session starts with: the context its sessions
 * opened at in the team's newest runs, beside the parts of it that can be
 * measured — Geniro's instruction block, the repository's instruction files on
 * disk and the MCP servers the CLI last reported in that folder. Reads only
 * what is already recorded; nothing is stored.
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
    const folds = foldFreshStarts(
      runs,
      await this.items.memberTurnReadings(runs.map((run) => run.id)),
    );
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
      minTokens: fold.minTokens,
      maxTokens: fold.maxTokens,
      medianRequests: fold.medianRequests,
      firstStartAt: fold.firstStartAt.toISOString(),
      lastStartAt: fold.lastStartAt.toISOString(),
      teamBlockTokens,
      teamBlockShare: shareOf(teamBlockTokens, base),
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
      notMeasured: notMeasured(),
    };
  }
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
    minTokens: null,
    maxTokens: null,
    medianRequests: null,
    firstStartAt: null,
    lastStartAt: null,
    teamBlockTokens,
    teamBlockShare: null,
    repoFiles: null,
    repoFilesUnavailableReason: NO_START_REASON,
    cliRemainderTokens: null,
    cliRemainderShare: null,
    mcpServers: null,
    mcpServersUnavailableReason: NO_START_REASON,
    notMeasured: notMeasured(),
  };
}

function notMeasured(): FreshSessionBase['notMeasured'] {
  return FRESH_SESSION_UNMEASURED_PARTS.map((part) => ({
    part,
    reason: NOT_MEASURED_REASON[part],
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
