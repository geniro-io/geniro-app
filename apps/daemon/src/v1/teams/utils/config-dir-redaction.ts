import { createHash } from 'node:crypto';

import type { AgentKind } from '../../runs/runs.types';
import type { Team, TeamMember } from '../teams.types';

/**
 * How `read_teams` shows an agent's `configDir`: the path of a profile
 * folder under the user's home never goes to the model's provider, so each
 * path is shown as a token naming it — `<set:` plus a short hash of the path,
 * `>`. The same path always reads as the same token, so a proposal that keeps
 * a token keeps that profile wherever it moves the agent ({@link
 * restoreConfigDirs}).
 */
export const CONFIG_DIR_TOKEN_PREFIX = '<set:';

/** The token `read_teams` shows in place of `path`. */
export function configDirToken(path: string): string {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 8);
  return `${CONFIG_DIR_TOKEN_PREFIX}${digest}>`;
}

/** The team with every member's and pool member's `configDir` tokenized. */
export function redactConfigDirs(team: Team): Team {
  return {
    ...team,
    members: team.members.map((member) => ({
      ...withToken(member),
      ...(member.pool === undefined
        ? {}
        : { pool: member.pool.map(withToken) }),
    })),
  };
}

/**
 * `text` with every real `configDir` of `team` replaced by its token — for
 * a refusal of a proposal whose paths were put back, which may quote one.
 */
export function redactConfigDirText(text: string, team: Team): string {
  return profilesOf(team).reduce(
    (redacted, { path }) => redacted.split(path).join(configDirToken(path)),
    text,
  );
}

/**
 * The first line of a message about a library file, for an agent: a YAML parse
 * error goes on to quote the file's lines around the fault, and a profile path
 * may be among them. The line it keeps names the fault and where it is.
 */
export function firstLineOf(message: string): string {
  return message.split('\n', 1)[0]!.replace(/:\s*$/, '');
}

export type RestoredConfigDirs =
  { ok: true; team: Team } | { ok: false; message: string };

/**
 * Put the real `configDir` back wherever a proposal kept a token: the path the
 * token names among the profiles of the team it replaces, matched by the
 * token alone — never by member id or pool position, which an edit moves — and
 * only for an agent of a CLI that profile served there. A token with nothing
 * behind it (a new team, an unknown token) or one moved onto another CLI
 * refuses the proposal rather than guessing, so the agent can tell the user.
 */
export function restoreConfigDirs(
  team: Team,
  current: Team | null,
): RestoredConfigDirs {
  const known = new Map<string, { path: string; agents: Set<AgentKind> }>();
  for (const { path, agent } of current === null ? [] : profilesOf(current)) {
    const token = configDirToken(path);
    const entry = known.get(token) ?? { path, agents: new Set<AgentKind>() };
    entry.agents.add(agent);
    known.set(token, entry);
  }
  let refusal: string | null = null;
  const restore = <T extends { agent: AgentKind; configDir?: string }>(
    holder: T,
  ): T => {
    // `<set` and not the whole prefix: a token the agent mangled is refused
    // like an unknown one, never handed on as a path.
    if (!holder.configDir?.startsWith(CONFIG_DIR_TOKEN_PREFIX.slice(0, -1))) {
      return holder;
    }
    const entry = known.get(holder.configDir);
    if (entry === undefined) {
      refusal ??=
        current === null
          ? `configDir "${holder.configDir}" keeps a profile of a library team, and a new team replaces none: leave configDir out, or replace that team`
          : `configDir "${holder.configDir}" names no profile of the team this replaces`;
      return holder;
    }
    if (!entry.agents.has(holder.agent)) {
      refusal ??= `configDir "${holder.configDir}" is a profile of ${[...entry.agents].join('/')} there, and this agent runs ${holder.agent}: leave configDir out`;
      return holder;
    }
    return { ...holder, configDir: entry.path };
  };
  const restored: Team = {
    ...team,
    members: team.members.map((member) => ({
      ...restore(member),
      ...(member.pool === undefined ? {} : { pool: member.pool.map(restore) }),
    })),
  };
  return refusal === null
    ? { ok: true, team: restored }
    : { ok: false, message: refusal };
}

/** Every profile a team names, with the CLI that runs under it. */
function profilesOf(team: Team): { path: string; agent: AgentKind }[] {
  return team.members.flatMap((member) =>
    [member, ...(member.pool ?? [])].flatMap((holder) =>
      holder.configDir === undefined
        ? []
        : [{ path: holder.configDir, agent: holder.agent }],
    ),
  );
}

function withToken<T extends Pick<TeamMember, 'configDir'>>(holder: T): T {
  return holder.configDir === undefined
    ? holder
    : { ...holder, configDir: configDirToken(holder.configDir) };
}
