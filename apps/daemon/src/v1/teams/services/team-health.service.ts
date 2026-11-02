import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { AgentMcpServer } from '../../agents/adapters/adapter.types';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentMcpService } from '../../agents/services/agent-mcp.service';
import { AgentVersionService } from '../../agents/services/agent-version.service';
import { ModelsService } from '../../agents/services/models.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { resolveAgentBinary } from '../../agents/utils/agent-binary';
import { childProcessHandle } from '../../agents/utils/child-handle';
import { effortListed } from '../../agents/utils/effort-listed';
import { isExecutableOnPath } from '../../agents/utils/executable-on-path';
import { OLLAMA_MODEL_PREFIX } from '../../agents/utils/ollama';
import { resolveValidConfigDir } from '../../agents/utils/resolve-config-dir';
import type { AgentKind } from '../../runs/runs.types';
import type {
  HealthProblem,
  MemberHealth,
  Team,
  TeamAgentPoolMember,
  TeamHealth,
  TeamMember,
} from '../teams.types';
import { poolMembersOf } from '../utils/agent-pool';
import {
  blockingProblemsOf,
  type ConfigurationFacts,
  healthOf,
  type McpFacts,
  type MemberFacts,
  memberHealthOf,
  type TeamFacts,
} from '../utils/member-health';
import { startingLeadOf } from '../utils/team-roster';
import { TeamStoreService } from './team-store.service';

type McpMode = 'none' | 'known' | 'probe';

interface InstallAnswer {
  state: 'installed' | 'missing' | 'unknown';
  version: string | null;
}

/** One gathering's memo: each CLI is asked once and each (agent, profile) listed once. */
interface Gathering {
  mcp: McpMode;
  installs: Map<AgentKind, Promise<InstallAnswer>>;
  listings: Map<string, Promise<McpFacts>>;
}

const NO_MCP: McpFacts = { servers: null, checking: false };

/**
 * Whether each team member is set up to run: its CLI is installed, its
 * profile folder exists, its model and effort are offered, its MCP servers
 * are healthy. The cheap path (every call) answers from memoized and cached
 * facts and never dials an MCP server; only `probe` asks `AgentMcpService` to
 * list, which is single-flight, cached and non-blocking.
 */
@Injectable()
export class TeamHealthService {
  constructor(
    private readonly store: TeamStoreService,
    private readonly adapters: AgentAdapterRegistry,
    private readonly versions: AgentVersionService,
    private readonly mcp: AgentMcpService,
    private readonly processes: ProcessRegistry,
    private readonly models: ModelsService,
  ) {}

  async health(slug: string, probe: boolean): Promise<TeamHealth> {
    const { team } = await this.store.get(slug);
    const facts = await this.gather(
      team,
      team.members,
      probe ? 'probe' : 'known',
    );
    return healthOf(team, slug, facts, new Date().toISOString());
  }

  async memberHealth(
    slug: string,
    memberId: string,
    probe: boolean,
  ): Promise<MemberHealth> {
    const { team } = await this.store.get(slug);
    const member = team.members.find((entry) => entry.id === memberId);
    if (member === undefined) {
      throw new NotFoundException(
        'MEMBER_NOT_FOUND',
        `Team '${slug}' has no member '${memberId}'`,
      );
    }
    const facts = await this.gather(team, [member], probe ? 'probe' : 'known');
    return memberHealthOf(memberId, facts.get(memberId) as MemberFacts, member);
  }

  /** The problems that stop a run from starting; the cheap path only, no MCP read. */
  async blockingProblems(team: Team): Promise<HealthProblem[]> {
    return blockingProblemsOf(
      team,
      await this.gather(team, team.members, 'none'),
    );
  }

  private async gather(
    team: Team,
    members: readonly TeamMember[],
    mcp: McpMode,
  ): Promise<TeamFacts> {
    const lead = startingLeadOf(team);
    const gathering: Gathering = {
      mcp,
      installs: new Map(),
      listings: new Map(),
    };
    const entries = await Promise.all(
      members.map(async (member): Promise<[string, MemberFacts]> => [
        member.id,
        {
          configurations: await Promise.all(
            poolMembersOf(member).map((settings) =>
              this.configurationFacts(settings, gathering),
            ),
          ),
          leads: member.id === lead,
        },
      ]),
    );
    return new Map(entries);
  }

  private async configurationFacts(
    settings: TeamAgentPoolMember,
    gathering: Gathering,
  ): Promise<ConfigurationFacts> {
    const { agent } = settings;
    const adapter = this.adapters.for(agent);
    const config = adapter.getConfig();
    const install = await this.installOf(agent, gathering);
    const profileSupported = config.configDir.unavailableReason === null;
    const configDir = profileSupported ? (settings.configDir ?? null) : null;
    let profile: string | null = null;
    let profileMissing = false;
    if (configDir !== null) {
      try {
        profile = resolveValidConfigDir(configDir);
      } catch {
        profileMissing = true;
      }
    }
    const runnable = install.state !== 'missing' && !profileMissing;
    const model = settings.model ?? null;
    const effort = settings.effort ?? null;
    return {
      agent,
      agentLabel: config.identity.displayName,
      configDir,
      profileMissing,
      cli: install.state,
      model,
      modelOffered:
        runnable && model !== null
          ? this.modelOffered(agent, profile, install.version, model)
          : null,
      effort,
      effortOffered: effort === null ? null : effortListed(adapter, effort),
      mcpDisabled: settings.mcpDisabled ?? [],
      mcp: runnable ? await this.mcpOf(agent, profile, gathering) : NO_MCP,
    };
  }

  private installOf(
    agent: AgentKind,
    gathering: Gathering,
  ): Promise<InstallAnswer> {
    let answer = gathering.installs.get(agent);
    if (answer === undefined) {
      answer = this.versions
        .resolve(agent, {
          onSpawn: (child, spawnInfo) =>
            this.processes.register(
              `health:version:${randomUUID()}`,
              childProcessHandle(child, spawnInfo),
            ),
        })
        .then(
          (version): InstallAnswer => ({
            state:
              version !== null
                ? 'installed'
                : isExecutableOnPath(resolveAgentBinary(agent))
                  ? 'unknown'
                  : 'missing',
            version,
          }),
          (): InstallAnswer => ({ state: 'unknown', version: null }),
        );
      gathering.installs.set(agent, answer);
    }
    return answer;
  }

  /**
   * Answered only from a list already filed. A list with no entry the CLI
   * itself reported is a documented fallback, not the CLI's word, so it
   * proves nothing about a model.
   */
  private modelOffered(
    agent: AgentKind,
    profile: string | null,
    version: string | null,
    model: string,
  ): boolean | null {
    if (model.startsWith(OLLAMA_MODEL_PREFIX)) {
      return null;
    }
    const listed = this.models.cachedModels(agent, profile, version);
    if (listed === null || !listed.some((entry) => entry.source === 'cli')) {
      return null;
    }
    return listed.some(
      (entry) => entry.id === model || entry.resolvedModel === model,
    );
  }

  private mcpOf(
    agent: AgentKind,
    profile: string | null,
    gathering: Gathering,
  ): Promise<McpFacts> {
    if (gathering.mcp === 'none') {
      return Promise.resolve(NO_MCP);
    }
    if (gathering.mcp === 'known') {
      return Promise.resolve(this.knownMcp(agent, profile));
    }
    const key = `${agent}\u0000${profile ?? ''}`;
    let listing = gathering.listings.get(key);
    if (listing === undefined) {
      listing = this.mcp.list(agent, null, { configDir: profile }).then(
        (answer): McpFacts =>
          answer.unavailableReason === null
            ? {
                servers: answer.servers as AgentMcpServer[],
                checking: answer.pending,
                checkedAt: answer.pending ? null : new Date().toISOString(),
              }
            : NO_MCP,
        (): McpFacts => this.knownMcp(agent, profile),
      );
      gathering.listings.set(key, listing);
    }
    return listing;
  }

  private knownMcp(agent: AgentKind, profile: string | null): McpFacts {
    const known = this.mcp.knownStatus(agent, profile);
    return {
      servers: known.servers,
      checking: false,
      checkedAt: known.checkedAt,
    };
  }
}
