import { z } from 'zod';

import type { Run } from '../../runs/entity/run.entity';
import { SINGLE_AGENT_NODE } from '../chat.types';
import { isChatTeamRun } from './run-kind';

/** One member removed from a run's team while it ran (`Run.teamDeparted`). */
export const RunTeamDepartureSchema = z.object({
  memberId: z.string(),
  leftAt: z.string(),
});
export type RunTeamDeparture = z.infer<typeof RunTeamDepartureSchema>;

/** `Run.teamDeparted` as it stands; an unreadable column reads as none. */
export function readTeamDepartures(column: string | null): RunTeamDeparture[] {
  if (column === null) {
    return [];
  }
  try {
    const parsed = z
      .array(RunTeamDepartureSchema)
      .safeParse(JSON.parse(column));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const SnapshotMembersSchema = z.object({
  members: z.array(z.object({ id: z.string() })),
});

/**
 * How many agents a chat team runs beside the chat's own (its lead), the ones
 * removed while it ran left out; null for any other run. Counted off the run's
 * own copy, without the team schema `v1/teams` owns.
 */
export function chatTeamSizeOf(
  run: Pick<Run, 'teamOrigin' | 'teamSnapshot' | 'teamDeparted'>,
): number | null {
  if (!isChatTeamRun(run) || run.teamSnapshot === null) {
    return null;
  }
  let members: { id: string }[];
  try {
    const parsed = SnapshotMembersSchema.safeParse(
      JSON.parse(run.teamSnapshot),
    );
    if (!parsed.success) {
      return null;
    }
    members = parsed.data.members;
  } catch {
    return null;
  }
  const departed = new Set(
    readTeamDepartures(run.teamDeparted).map((left) => left.memberId),
  );
  return members.filter(
    (member) => member.id !== SINGLE_AGENT_NODE && !departed.has(member.id),
  ).length;
}
