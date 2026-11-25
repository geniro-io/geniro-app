import {
  MAX_CHAT_TEAM_MEMBERS,
  MAX_RUN_TEAM_PLAN_LINES,
} from '../../../teams/teams.types';
import { toolInputSchema } from '../tool-args';
import { ListedArgsSchema } from './run-team.reader';

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
 * `run_team`'s arguments, GENERATED from the schema a call is read against, so
 * the shape shown cannot drift from the one held. ONE schema for both forms: a
 * claude chat that becomes a team keeps the schema it loaded as a chat, and a
 * schema per form left its lead calling the start form's.
 */
export function runTeamSchema(): Record<string, unknown> {
  const schema = described(toolInputSchema(ListedArgsSchema), {
    summary:
      'One line for the card: what the team will do, or what the change does',
    reason: 'Why, for the card: what the user asked for',
    plan: `To START a team from an ordinary chat: the plan, one short step per line, at most ${MAX_RUN_TEAM_PLAN_LINES}. Never sent by a team's lead`,
    team: `To START a team from an ordinary chat: a short name, and the agents who join this chat (at most ${MAX_CHAT_TEAM_MEMBERS}). This chat leads them; do not list it. Never sent by a team's lead`,
    edits: `To CHANGE the team you lead: one edit per agent — {op: 'add', member} with the same fields a team member takes; {op: 'remove', memberId}; {op: 'update', memberId, role?, task?, instructions?, model?, effort?} with only the fields that change. Ids are the ones your "May call" block names. Never sent from an ordinary chat`,
  });
  const team = (schema.properties as Record<string, Record<string, unknown>>)
    .team as Record<string, unknown>;
  const members = (team.properties as Record<string, Record<string, unknown>>)
    .members as Record<string, unknown>;
  described(members.items as Record<string, unknown>, MEMBER_FIELDS);
  return schema;
}
