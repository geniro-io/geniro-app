import type { StageProgress } from '../../agents/chat.types';
import type { Team, TeamMember, TeamStage } from '../teams.types';
import { foldStages } from './stage-fold';
import { walkableStages } from './stage-validate';

/** The member that handles the first message, or null for a team without a usable trigger. */
export function triggerMemberId(
  team: Pick<Team, 'members' | 'triggers'>,
): string | null {
  const id = team.triggers[0]?.member;
  return id !== undefined && team.members.some((member) => member.id === id)
    ? id
    : null;
}

export function triggerMemberOf(
  team: Pick<Team, 'members' | 'triggers'>,
): TeamMember | null {
  const id = triggerMemberId(team);
  return team.members.find((member) => member.id === id) ?? null;
}

type LeadTeam = Pick<Team, 'members' | 'triggers' | 'mode' | 'stages'>;

/** The member that leads a stage — its first responsible member — or null when it names none of the team's. */
export function stageLeadOf(
  stage: Pick<TeamStage, 'responsible'>,
  members: readonly Pick<TeamMember, 'id'>[],
): string | null {
  const id = stage.responsible?.[0];
  return id !== undefined && members.some((member) => member.id === id)
    ? id
    : null;
}

/**
 * Who leads a run now: in `relay` mode the current stage's lead, failing that
 * the previous lead, failing that the trigger's member; in `lead` mode always
 * the trigger's member.
 */
export function leadOf(
  team: LeadTeam,
  progress: Pick<StageProgress, 'current'> | null,
  previousLead: string | null,
): string | null {
  const trigger = triggerMemberId(team);
  if (team.mode !== 'relay') {
    return trigger;
  }
  const stage =
    progress?.current == null
      ? undefined
      : team.stages?.find((s) => s.id === progress.current);
  const own = stage === undefined ? null : stageLeadOf(stage, team.members);
  if (own !== null) {
    return own;
  }
  if (
    previousLead !== null &&
    team.members.some((member) => member.id === previousLead)
  ) {
    return previousLead;
  }
  return trigger;
}

/**
 * {@link leadOf} with the previous lead read off the progress itself — the
 * lead of the stage finished or skipped most recently that names one — so a
 * restart that refolds the rows answers the same member.
 */
export function currentLeadOf(
  team: LeadTeam,
  progress: Pick<StageProgress, 'current' | 'stages'> | null,
): string | null {
  const resolved = (progress?.stages ?? [])
    .filter(
      (entry) =>
        (entry.status === 'done' || entry.status === 'skipped') &&
        entry.rev !== undefined,
    )
    .sort((a, b) => (b.rev ?? 0) - (a.rev ?? 0));
  let previous: string | null = null;
  for (const entry of resolved) {
    const stage = team.stages?.find((s) => s.id === entry.id);
    const lead = stage === undefined ? null : stageLeadOf(stage, team.members);
    if (lead !== null) {
      previous = lead;
      break;
    }
  }
  return leadOf(team, progress, previous);
}

/**
 * Who leads a new run of the team: its first stage's lead in `relay` mode,
 * else the trigger's member.
 *
 * TWIN PARSER: `firstMessageMemberOf` in apps/ui/src/renderer/chats/team-root.ts.
 */
export function startingLeadOf(team: Team): string | null {
  const stages = walkableStages(team);
  return currentLeadOf(team, stages === null ? null : foldStages(stages, []));
}

/** Every member that can lead a run of the team: the trigger's member, and in `relay` mode each stage's lead. */
export function possibleLeadsOf(team: LeadTeam): Set<string> {
  const leads = new Set<string>();
  const trigger = triggerMemberId(team);
  if (trigger !== null) {
    leads.add(trigger);
  }
  if (team.mode === 'relay') {
    for (const stage of team.stages ?? []) {
      const lead = stageLeadOf(stage, team.members);
      if (lead !== null) {
        leads.add(lead);
      }
    }
  }
  return leads;
}

/**
 * The members that run only when called: every member that cannot lead a run
 * of the team (see {@link possibleLeadsOf}).
 */
export function onDemandMemberIds(team: LeadTeam): Set<string> {
  const leads = possibleLeadsOf(team);
  return new Set(
    team.members.map((member) => member.id).filter((id) => !leads.has(id)),
  );
}

/**
 * Every member a member may call: all the others. A team of one has nobody
 * to call, so it maps no caller and runs no call runtime.
 */
export function calleesOf(
  members: readonly TeamMember[],
): Map<string, readonly TeamMember[]> {
  return members.length < 2
    ? new Map()
    : new Map(
        members.map((member) => [
          member.id,
          members.filter((other) => other.id !== member.id),
        ]),
      );
}
