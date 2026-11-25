import {
  MAX_CHAT_TEAM_MEMBERS,
  MAX_RUN_TEAM_PLAN_LINES,
} from '../../../teams/teams.types';
import { toolInputSchema } from '../tool-args';
import { ChangeArgsSchema, StartArgsSchema } from './run-team.reader';

/** Which form a turn is offered: an ordinary chat starts, a team's lead changes. */
export type RunTeamForm = 'start' | 'change';

const MEMBER_FIELDS: Record<string, string> = {
  id: "Short id, unique in the team (letters, digits, dashes); never 'agent', which is this chat",
  name: 'Display name, how the other agents address it',
  role: 'What it does, in one or two sentences — every other agent reads this to decide whom to call',
  task: 'Its own part of this job, shown to the user on the card and handed to it when you call it',
  instructions:
    'How it works: its private standing instructions, its own turns only',
  agent: 'The CLI it runs — an installed one; pick the one that fits the work',
  model: 'A model that CLI knows; leave it out for the CLI default',
  effort: 'Reasoning effort that CLI takes; leave it out for its default',
};

/** Puts each field's description on a generated schema's properties. */
function described(
  schema: Record<string, unknown>,
  descriptions: Record<string, string>,
): Record<string, unknown> {
  const properties = schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  for (const [key, description] of Object.entries(descriptions)) {
    if (properties[key] !== undefined) {
      properties[key] = { ...properties[key], description };
    }
  }
  return schema;
}

/**
 * `run_team`'s arguments for the form this turn is offered, GENERATED from the
 * schemas a call is read with, so the shape shown cannot drift from the one
 * held.
 */
export function runTeamSchema(form: RunTeamForm): Record<string, unknown> {
  if (form === 'start') {
    const schema = described(toolInputSchema(StartArgsSchema), {
      summary: 'One line for the card: what this team will do',
      reason: 'Why a team, for the card: what the user asked for',
      plan: `The plan, one short step per line, at most ${MAX_RUN_TEAM_PLAN_LINES}`,
      team: `The team: a short name, and the agents who join this chat (at most ${MAX_CHAT_TEAM_MEMBERS}). This chat leads them; do not list it`,
    });
    const team = (schema.properties as Record<string, Record<string, unknown>>)
      .team as Record<string, unknown>;
    const members = (team.properties as Record<string, Record<string, unknown>>)
      .members as Record<string, unknown>;
    described(members.items as Record<string, unknown>, MEMBER_FIELDS);
    return schema;
  }
  return described(toolInputSchema(ChangeArgsSchema), {
    summary: 'One line for the card: what the change does',
    reason: 'Why, for the card: what the user asked for',
    edits: `What changes, one edit per agent: {op: 'add', member} with the same fields a start takes; {op: 'remove', memberId}; {op: 'update', memberId, role?, task?, instructions?, model?, effort?} — only the fields that change. Ids are the ones your "May call" block names`,
  });
}
