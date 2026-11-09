import { z } from 'zod';

import {
  GOAL_EVIDENCE_MAX,
  GOAL_HIDDEN_TEXT,
  GOAL_TEXT_MAX,
  GoalClosingStatusSchema,
  type GoalDraft,
  GOALS_PER_RUN,
  GoalSourceSchema,
  type GoalsWriteOutcome,
  type RunGoal,
} from '../../../agents/chat.types';
import { hasHiddenText } from '../../../agents/utils/hidden-text';
import { readToolArgs } from '../tool-args';

export const GOAL_ACTIONS = [
  'list',
  'set',
  'add',
  'update',
  'remove',
  'complete',
  'reopen',
] as const;

const GoalTextSchema = z
  .string()
  .trim()
  .min(1, 'a goal text is empty')
  .max(
    GOAL_TEXT_MAX,
    `a goal is over ${GOAL_TEXT_MAX} characters — state the outcome, not the plan`,
  )
  .refine((text) => !hasHiddenText(text, false), `a goal ${GOAL_HIDDEN_TEXT}`);

export const GoalsArgsSchema = z
  .object({
    action: z.enum(GOAL_ACTIONS),
    goals: z
      .array(
        z.object({ text: GoalTextSchema, source: GoalSourceSchema }).strict(),
      )
      .min(1)
      .max(GOALS_PER_RUN)
      .optional(),
    id: z.string().trim().min(1).optional(),
    text: GoalTextSchema.optional(),
    status: GoalClosingStatusSchema.optional(),
    evidence: z
      .string()
      .trim()
      .max(
        GOAL_EVIDENCE_MAX,
        `evidence is over ${GOAL_EVIDENCE_MAX} characters — point to where the proof lives`,
      )
      .refine(
        (evidence) => !hasHiddenText(evidence, true),
        'evidence holds a control or format character',
      )
      .optional(),
  })
  .strict();

export type GoalsCall =
  | { action: 'list' }
  | { action: 'set' | 'add'; goals: GoalDraft[] }
  | { action: 'update'; id: string; text: string }
  | { action: 'remove' | 'reopen'; id: string }
  | {
      action: 'complete';
      id: string;
      status: z.infer<typeof GoalClosingStatusSchema>;
      evidence: string;
    };

/** The call, or what is wrong with it. Never throws. */
export function readGoals(
  args: Record<string, unknown>,
): GoalsCall | { error: string } {
  const read = readToolArgs(GoalsArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  const { action, goals, id, text, status, evidence } = read.query;
  switch (action) {
    case 'list':
      return { action };
    case 'set':
    case 'add':
      return goals === undefined
        ? { error: `${action} needs "goals": [{ text, source }]` }
        : { action, goals };
    case 'update':
      return id === undefined || text === undefined
        ? { error: 'update needs "id" and the new "text"' }
        : { action, id, text };
    case 'remove':
    case 'reopen':
      return id === undefined
        ? { error: `${action} needs "id"` }
        : { action, id };
    case 'complete':
      if (id === undefined || status === undefined) {
        return { error: 'complete needs "id" and "status"' };
      }
      if (evidence === undefined || evidence.length === 0) {
        return {
          error:
            'complete needs "evidence" for every status: what shows the goal was met, missed or why it was dropped — a test run, a command and its result, a link, a file',
        };
      }
      return { action, id, status, evidence };
  }
}

/** The goal list as the agent reads it back. */
export function goalsListText(goals: readonly RunGoal[]): string {
  if (goals.length === 0) {
    return 'This run has no goals yet. Record them with action "set".';
  }
  const open = goals.filter((goal) => goal.status === 'open').length;
  return [
    `${goals.length} ${goals.length === 1 ? 'goal' : 'goals'}, ${open} open:`,
    ...goals.map(
      (goal) =>
        `- ${goal.id} [${goal.status}] ${goal.text}${goal.evidence === null ? '' : ` — evidence: ${goal.evidence}`}`,
    ),
  ].join('\n');
}

/** The receipt for a write. */
export function goalsResultText(
  action: GoalsCall['action'],
  outcome: GoalsWriteOutcome,
): { text: string; isError: boolean } {
  if (outcome.status === 'refused') {
    return {
      text: `Not changed (${outcome.code}): ${outcome.reason}.`,
      isError: true,
    };
  }
  const head =
    action === 'remove'
      ? 'Removed.'
      : action === 'complete'
        ? `Closed ${outcome.changed.map((goal) => `${goal.id} as ${goal.status}`).join(', ')}.`
        : action === 'reopen'
          ? `Reopened ${outcome.changed.map((goal) => goal.id).join(', ')}.`
          : `Saved ${outcome.changed.map((goal) => goal.id).join(', ')}.`;
  return { text: `${head}\n${goalsListText(outcome.goals)}`, isError: false };
}
