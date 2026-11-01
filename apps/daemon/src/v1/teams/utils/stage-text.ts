import {
  HOST_MOVE_STAGE_TOOL,
  type StageMoveAction,
  type StageProgress,
} from '../../agents/chat.types';
import type { Team, TeamMember, TeamStage } from '../teams.types';
import { walkableStages } from './stage-validate';

export const MAX_AGENT_STAGE_TEXT_LINES = 3;
export const MAX_STAGE_TEXT_LENGTH = 600;

function titleOf(stages: readonly TeamStage[], id: string): string {
  return stages.find((s) => s.id === id)?.title ?? id;
}

function named(stages: readonly TeamStage[], id: string): string {
  return `${titleOf(stages, id)} (${id})`;
}

/** The stage's responsible members by name, the first marked as leading; null when it names none of the team's. */
function responsibleOf(
  stage: TeamStage,
  members: readonly TeamMember[],
): string | null {
  const named = (stage.responsible ?? []).flatMap((id) => {
    const member = members.find((m) => m.id === id);
    return member === undefined ? [] : [member.name];
  });
  if (named.length === 0) {
    return null;
  }
  const [lead, ...rest] = named;
  return [named.length > 1 ? `${lead} (leads)` : lead, ...rest].join(', ');
}

export function stageMapPrompt(
  stages: readonly TeamStage[],
  members: readonly TeamMember[],
): string {
  const lines = stages.map((stage, i) => {
    const parts = [`${i + 1}. ${named(stages, stage.id)}`];
    const next = stage.next ?? [];
    if (next.length === 1) {
      parts.push(`then ${named(stages, next[0]!)}`);
    } else if (next.length > 1) {
      parts.push(
        `then ONE of: ${next.map((id) => named(stages, id)).join(' | ')}`,
      );
    } else {
      parts.push('final stage');
    }
    const responsible = responsibleOf(stage, members);
    if (responsible !== null) {
      parts.push(`responsible: ${responsible}`);
    }
    const head = parts.join(' — ');
    const body = [
      stage.howToWork?.trim()
        ? `   How to work: ${stage.howToWork.trim()}`
        : null,
      `   Goal: ${stage.goal.trim()}`,
    ].filter((line): line is string => line !== null);
    return [head, ...body].join('\n');
  });
  return [
    'This team has stages every run walks, in order:',
    ...lines,
    '',
    `Each of your turns starts with the current stage. When the current stage's goal is met, mark it with ${HOST_MOVE_STAGE_TOOL} (action "complete", a one-line summary). Skip a stage that does not apply with action "skip" and the reason; at a stage with ONE-of branches, name the branch you take as "next". If an earlier stage turns out unfinished, reopen it with action "reopen" and the reason — that also reopens every stage after it.`,
    'Any member of the run may move a stage; the responsible members are who usually do it, not the only ones allowed to. Move only the stage you finished, and only when it is the current one.',
  ].join('\n');
}

export function stageMapOf(
  team: Pick<Team, 'stages' | 'members'>,
): string | null {
  const stages = walkableStages(team);
  return stages === null ? null : stageMapPrompt(stages, team.members);
}

export function stageNotice(
  stages: readonly TeamStage[],
  progress: StageProgress,
): string {
  const { index, total } = progress.position;
  if (progress.current === null) {
    return `<stage>Every stage of this run is done (${index}/${total}).</stage>`;
  }
  const stage = stages.find((s) => s.id === progress.current);
  const goal = stage === undefined ? '' : ` — goal: ${stage.goal.trim()}`;
  return `<stage>Current stage: ${named(stages, progress.current)} (${index}/${total})${goal}</stage>`;
}

export function stageLabel(
  stages: readonly TeamStage[],
  progress: StageProgress,
): string {
  const { index, total } = progress.position;
  return progress.current === null
    ? `all stages done (${index}/${total})`
    : `${named(stages, progress.current)}, ${index}/${total}`;
}

export function currentStageBrief(
  stages: readonly TeamStage[],
  members: readonly TeamMember[],
  progress: StageProgress,
): string {
  const { index, total } = progress.position;
  if (progress.current === null) {
    return `Every stage is done (${index}/${total}).`;
  }
  const stage = stages.find((s) => s.id === progress.current);
  if (stage === undefined) {
    return `Now: ${progress.current} (${index}/${total}).`;
  }
  const lines = [`Now: ${named(stages, stage.id)} (${index}/${total}).`];
  if (stage.howToWork?.trim()) {
    lines.push(`How to work: ${stage.howToWork.trim()}`);
  }
  lines.push(`Goal: ${stage.goal.trim()}`);
  const next = stage.next ?? [];
  if (next.length > 1) {
    lines.push(
      `Then ONE of: ${next.map((id) => named(stages, id)).join(' | ')} — name it as "next" when you complete or skip this stage.`,
    );
  }
  const responsible = responsibleOf(stage, members);
  if (responsible !== null) {
    lines.push(`Responsible: ${responsible}.`);
  }
  return lines.join('\n');
}

const VERB: Record<StageMoveAction, string> = {
  complete: 'Done',
  skip: 'Skipped',
  reopen: 'Reopened',
};

export function moveReply(
  stages: readonly TeamStage[],
  members: readonly TeamMember[],
  move: { action: StageMoveAction; stageId: string; next?: string },
  progress: StageProgress,
  resets: readonly string[],
): string {
  let what = `${VERB[move.action]}: ${titleOf(stages, move.stageId)}`;
  const forks = stages.find((s) => s.id === move.stageId)?.next ?? [];
  if (move.action !== 'reopen' && forks.length > 1 && move.next) {
    const untaken = forks.filter((id) => id !== move.next);
    what += ` → took ${titleOf(stages, move.next)} (${untaken.map((id) => titleOf(stages, id)).join(', ')} not taken)`;
  }
  if (move.action === 'reopen' && resets.length > 0) {
    what += ` (back to pending: ${resets.map((id) => titleOf(stages, id)).join(', ')})`;
  }
  return `${what}.\n${currentStageBrief(stages, members, progress)}`;
}

const USER_VERB: Record<StageMoveAction, string> = {
  complete: 'marked done',
  skip: 'skipped',
  reopen: 'reopened',
};

export function userMoveWake(
  stages: readonly TeamStage[],
  members: readonly TeamMember[],
  move: {
    action: StageMoveAction;
    stageId: string;
    next?: string;
    text: string;
  },
  progress: StageProgress,
  resets: readonly string[],
): string {
  let head = `The user ${USER_VERB[move.action]} the stage ${titleOf(stages, move.stageId)}`;
  if (move.next !== undefined) {
    head += `, taking ${titleOf(stages, move.next)}`;
  }
  if (move.action === 'reopen' && resets.length > 0) {
    head += ` (back to pending: ${resets.map((id) => titleOf(stages, id)).join(', ')})`;
  }
  return [
    `[geniro] ${head}. Their reason: "${move.text}"`,
    currentStageBrief(stages, members, progress),
  ].join('\n');
}
