import type { AgentMcpServer } from '../../agents/adapters/adapter.types';
import type { AgentKind } from '../../runs/runs.types';
import type {
  HealthProblem,
  MemberHealth,
  MemberHealthStatus,
  MemberSeat,
  Team,
  TeamHealth,
  TeamMember,
} from '../teams.types';
import { poolMembersOf } from './agent-pool';
import { validateTeam } from './team-validate';

/** What the daemon already knows of one configuration's MCP servers. */
export interface McpFacts {
  servers: readonly Pick<AgentMcpServer, 'name' | 'status'>[] | null;
  /** A read is still running behind these servers. */
  checking: boolean;
  /** When the servers were last read; null or absent when unknown. */
  checkedAt?: string | null;
}

/**
 * Everything gathered about ONE configuration a member can run under: the
 * member's own settings, or one pool member's. A `null` fact could not be
 * established cheaply and states no problem.
 */
export interface ConfigurationFacts {
  agent: AgentKind;
  /** The CLI's display name, for messages. */
  agentLabel: string;
  configDir: string | null;
  profileMissing: boolean;
  cli: 'installed' | 'missing' | 'unknown';
  model: string | null;
  modelOffered: boolean | null;
  effort: string | null;
  effortOffered: boolean | null;
  mcpDisabled: readonly string[];
  mcp: McpFacts;
}

/** Index 0 is the member itself, then its pool members in order (positions 2…). */
export interface MemberFacts {
  configurations: readonly ConfigurationFacts[];
  /**
   * Whether a run starts with this member (`startingLeadOf`). Another member
   * whose CLI is missing fails only when the run reaches it, so its missing
   * CLI never stops a run from starting.
   */
  leads: boolean;
}

export type TeamFacts = ReadonlyMap<string, MemberFacts>;

const TRIGGER_ISSUE_CODES = new Set([
  'TEAM_TRIGGER_COUNT',
  'TEAM_TRIGGER_UNKNOWN',
]);

function problem(
  fields: Pick<HealthProblem, 'kind' | 'level' | 'message'> &
    Partial<Omit<HealthProblem, 'kind' | 'level' | 'message'>>,
): HealthProblem {
  return {
    agent: null,
    poolMember: null,
    configDir: null,
    server: null,
    model: null,
    ...fields,
  };
}

const MCP_PROBLEM_KIND = {
  failed: 'mcp_failed',
  needs_auth: 'mcp_needs_auth',
  pending: 'mcp_disconnected',
  disabled: 'mcp_disconnected',
} as const;

const MCP_PROBLEM_TEXT = {
  failed: 'failed to connect',
  needs_auth: 'needs signing in',
  pending: 'is not connected until it is approved',
  disabled: "is switched off in the agent's own settings",
} as const;

/** Problems of the team itself: its trigger and its stages' responsible members. */
export function teamProblemsOf(team: Team): HealthProblem[] {
  const problems: HealthProblem[] = validateTeam(team)
    .errors.filter((issue) => TRIGGER_ISSUE_CODES.has(issue.code))
    .map((issue) =>
      problem({ kind: 'no_trigger', level: 'error', message: issue.message }),
    );
  const known = new Set(team.members.map((member) => member.id));
  for (const stage of team.stages ?? []) {
    for (const id of stage.responsible ?? []) {
      if (!known.has(id)) {
        problems.push(
          problem({
            kind: 'stage_member_missing',
            level: 'warning',
            message: `Stage "${stage.title}" names "${id}" as responsible, but no member has that id any more.`,
          }),
        );
      }
    }
  }
  return problems;
}

function configurationProblemsOf(
  facts: ConfigurationFacts,
  index: number,
  fallsBack: boolean,
  leads: boolean,
): HealthProblem[] {
  const poolMember = index === 0 ? null : index + 1;
  const who = index === 0 ? 'this member' : `pool agent ${poolMember}`;
  const about = {
    agent: facts.agent,
    poolMember,
    configDir: facts.configDir,
    model: facts.model,
  };
  const problems: HealthProblem[] = [];
  if (facts.cli === 'missing') {
    problems.push(
      problem({
        ...about,
        kind: 'cli_missing',
        level: !fallsBack && leads ? 'error' : 'warning',
        message: fallsBack
          ? `${facts.agentLabel} is not installed for ${who}; the pool falls back to its other agents.`
          : leads
            ? `${facts.agentLabel} is not installed, so ${who} cannot run.`
            : `${facts.agentLabel} is not installed, so ${who} fails when the run reaches it.`,
      }),
    );
  } else if (facts.cli === 'unknown') {
    problems.push(
      problem({
        ...about,
        kind: 'cli_unknown',
        level: 'warning',
        message: `Could not check whether ${facts.agentLabel} is installed for ${who}.`,
      }),
    );
  }
  if (facts.profileMissing) {
    problems.push(
      problem({
        ...about,
        kind: 'profile_missing',
        level: 'error',
        message: `The profile folder set for ${who} no longer exists.`,
      }),
    );
  }
  if (facts.model !== null && facts.modelOffered === false) {
    problems.push(
      problem({
        ...about,
        kind: 'model_not_offered',
        level: 'warning',
        message: `Model "${facts.model}" is not offered by ${facts.agentLabel} for ${who}.`,
      }),
    );
  }
  if (facts.effort !== null && facts.effortOffered === false) {
    problems.push(
      problem({
        ...about,
        kind: 'effort_not_offered',
        level: 'warning',
        message: `Reasoning effort "${facts.effort}" is not offered by ${facts.agentLabel} for ${who}.`,
      }),
    );
  }
  const off = new Set(facts.mcpDisabled);
  for (const server of facts.mcp.servers ?? []) {
    if (off.has(server.name)) {
      continue;
    }
    if (
      server.status === 'failed' ||
      server.status === 'needs_auth' ||
      server.status === 'pending' ||
      server.status === 'disabled'
    ) {
      problems.push(
        problem({
          ...about,
          kind: MCP_PROBLEM_KIND[server.status],
          level: 'warning',
          server: server.name,
          message: `MCP server "${server.name}" ${MCP_PROBLEM_TEXT[server.status]} for ${who}.`,
        }),
      );
    }
  }
  return problems;
}

/** The problems of one member, across its own settings and every pool member. */
export function memberProblemsOf(facts: MemberFacts): HealthProblem[] {
  const fallsBack = facts.configurations.some(
    (configuration) => configuration.cli !== 'missing',
  );
  return facts.configurations.flatMap((configuration, index) =>
    configurationProblemsOf(configuration, index, fallsBack, facts.leads),
  );
}

export function statusOf(
  problems: readonly HealthProblem[],
  checking: boolean,
): MemberHealthStatus {
  if (problems.some((entry) => entry.level === 'error')) {
    return 'error';
  }
  if (checking) {
    return 'checking';
  }
  return problems.length > 0 ? 'warning' : 'ok';
}

/** The member's own CLI and profile, then each pool member's. */
export function seatsOf(member: TeamMember): MemberSeat[] {
  return poolMembersOf(member).map((settings, index) => ({
    agent: settings.agent,
    configDir: settings.configDir ?? null,
    poolMember: index === 0 ? null : index + 1,
  }));
}

export function memberHealthOf(
  memberId: string,
  facts: MemberFacts,
  member?: TeamMember,
): MemberHealth {
  const problems = memberProblemsOf(facts);
  const checking = facts.configurations.some(
    (configuration) => configuration.mcp.checking,
  );
  const readAt = facts.configurations
    .map((configuration) => configuration.mcp.checkedAt ?? null)
    .filter((at): at is string => at !== null)
    .sort();
  return {
    memberId,
    seats: member === undefined ? [] : seatsOf(member),
    status: statusOf(problems, checking),
    checking,
    problems,
    mcpCheckedAt: readAt[0] ?? null,
  };
}

const NO_FACTS: MemberFacts = { configurations: [], leads: false };

export function healthOf(
  team: Team,
  slug: string,
  facts: TeamFacts,
  checkedAt: string,
): TeamHealth {
  const teamProblems = teamProblemsOf(team);
  const members = team.members.map((member) =>
    memberHealthOf(member.id, facts.get(member.id) ?? NO_FACTS, member),
  );
  return {
    slug,
    checkedAt,
    blocking:
      teamProblems.some((entry) => entry.level === 'error') ||
      members.some((member) => member.status === 'error'),
    team: teamProblems,
    members,
  };
}

/**
 * Only the problems that stop a run from starting, each member's message led
 * by its name, since the refusal is read away from the member's card.
 */
export function blockingProblemsOf(
  team: Team,
  facts: TeamFacts,
): HealthProblem[] {
  return [
    ...teamProblemsOf(team),
    ...team.members.flatMap((member) =>
      memberProblemsOf(facts.get(member.id) ?? NO_FACTS).map((entry) => ({
        ...entry,
        message: `${member.name || member.id}: ${entry.message}`,
      })),
    ),
  ].filter((entry) => entry.level === 'error');
}
