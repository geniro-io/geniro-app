import { z } from 'zod';

import { SINGLE_AGENT_NODE } from '../../../agents/chat.types';
import { AgentKindSchema } from '../../../runs/runs.types';
import {
  argvSafe,
  MAX_CHAT_TEAM_MEMBERS,
  MAX_MEMBER_NAME_LENGTH,
  MAX_RUN_TEAM_PLAN_LINES,
  type ProposalOutcome,
  type RunTeamChangeRequest,
  type RunTeamStartRequest,
  SLUG_RE,
} from '../../../teams/teams.types';
import type { ToolArgs } from '../../mcp.types';
import { reasonField, summaryField } from '../propose-team/propose-team.reader';
import { readToolArgs } from '../tool-args';

export const RUN_TEAM_TASK_MAX = 4000;
export const RUN_TEAM_TEXT_MAX = 20_000;
export const RUN_TEAM_PLAN_LINE_MAX = 300;

const visible = (max: number) =>
  z.string().min(1).max(max).refine(argvSafe, 'must not contain NUL');

const memberIdField = z
  .string()
  .min(1)
  .max(40)
  .regex(SLUG_RE, 'letters, digits, dashes and underscores')
  .refine(
    (id) => id !== SINGLE_AGENT_NODE,
    `'${SINGLE_AGENT_NODE}' is this chat's own id`,
  );

const MemberArgsSchema = z
  .object({
    id: memberIdField,
    name: visible(MAX_MEMBER_NAME_LENGTH),
    role: visible(RUN_TEAM_TEXT_MAX),
    task: visible(RUN_TEAM_TASK_MAX),
    instructions: visible(RUN_TEAM_TEXT_MAX),
    agent: AgentKindSchema,
    model: visible(200).optional(),
    effort: visible(40).optional(),
  })
  .strict();

export const StartArgsSchema = z
  .object({
    summary: summaryField,
    reason: reasonField,
    plan: z
      .array(visible(RUN_TEAM_PLAN_LINE_MAX))
      .min(1)
      .max(MAX_RUN_TEAM_PLAN_LINES),
    team: z
      .object({
        name: visible(MAX_MEMBER_NAME_LENGTH),
        members: z.array(MemberArgsSchema).min(1).max(MAX_CHAT_TEAM_MEMBERS),
      })
      .strict(),
  })
  .strict();

const EditArgsSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), member: MemberArgsSchema }).strict(),
  z.object({ op: z.literal('remove'), memberId: z.string().min(1) }).strict(),
  z
    .object({
      op: z.literal('update'),
      memberId: z.string().min(1),
      role: visible(RUN_TEAM_TEXT_MAX).optional(),
      task: visible(RUN_TEAM_TASK_MAX).optional(),
      instructions: visible(RUN_TEAM_TEXT_MAX).optional(),
      model: visible(200).optional(),
      effort: visible(40).optional(),
    })
    .strict(),
]);

export const ChangeArgsSchema = z
  .object({
    summary: summaryField,
    reason: reasonField,
    edits: z
      .array(EditArgsSchema)
      .min(1)
      .max(MAX_CHAT_TEAM_MEMBERS * 2),
  })
  .strict();

/** Both forms' arguments in one shape: what the tool lists, whatever the form. */
export const ListedArgsSchema = z
  .object({
    summary: summaryField,
    reason: reasonField,
    plan: StartArgsSchema.shape.plan.optional(),
    team: StartArgsSchema.shape.team.optional(),
    edits: ChangeArgsSchema.shape.edits.optional(),
  })
  .strict();

/** The start form's arguments, or what is wrong with them. Never throws. */
export function readRunTeamStartArgs(
  args: Record<string, unknown>,
): ToolArgs<RunTeamStartRequest> {
  if ('edits' in args) {
    return {
      ok: false,
      error:
        'this chat runs no team yet — to start one send plan and team; edits change a running team, from its lead only',
    };
  }
  const read = readToolArgs(StartArgsSchema, args);
  if (!read.ok) {
    return read;
  }
  const ids = read.query.team.members.map((member) => member.id);
  const twice = ids.find((id, at) => ids.indexOf(id) !== at);
  if (twice !== undefined) {
    return { ok: false, error: `two agents share the id '${twice}'` };
  }
  return { ok: true, query: read.query };
}

/** The change form's arguments, or what is wrong with them. Never throws. */
export function readRunTeamChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<RunTeamChangeRequest> {
  if ('plan' in args || 'team' in args) {
    return {
      ok: false,
      error:
        'you lead a running team — change it with edits (one per agent); plan and team only start a team from an ordinary chat',
    };
  }
  const read = readToolArgs(ChangeArgsSchema, args);
  if (!read.ok) {
    return read;
  }
  const touched = read.query.edits.map((edit) =>
    edit.op === 'add' ? edit.member.id : edit.memberId,
  );
  const twice = touched.find((id, at) => touched.indexOf(id) !== at);
  if (twice !== undefined) {
    return {
      ok: false,
      error: `'${twice}' is named by two edits — put everything for one agent in one edit`,
    };
  }
  return { ok: true, query: read.query };
}

/** What the agent is told once its call is answered. */
export function runTeamResultText(outcome: ProposalOutcome): string {
  if (outcome.status === 'refused') {
    return `Not proposed — ${outcome.code}: ${outcome.message}. No card was shown.`;
  }
  const { proposal } = outcome;
  const what =
    proposal.mode === 'run-start'
      ? `a team of ${proposal.members.length} agent${proposal.members.length === 1 ? '' : 's'} led by this chat. Nothing starts until they press Start`
      : 'a change to the running team. Nothing changes until they press Apply';
  return `Shown to the user on a card: ${what}. End your turn now — their verdict arrives as your next message.`;
}
