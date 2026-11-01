import {
  HOST_MOVE_STAGE_TOOL,
  type StageMoveAction,
  type StageProgress,
} from '../../agents/chat.types';
import type { Team, TeamNode, TeamStage } from '../teams.types';
import { walkableStages } from './stage-validate';

export const MAX_AGENT_STAGE_TEXT_LINES = 3;
export const MAX_STAGE_TEXT_LENGTH = 600;

function titleOf(stages: readonly TeamStage[], id: string): string {
  return stages.find((s) => s.id === id)?.title ?? id;
}

function named(stages: readonly TeamStage[], id: string): string {
  return `${titleOf(stages, id)} (${id})`;
}

function ownerOf(stage: TeamStage, nodes: readonly TeamNode[]): string | null {
  if (stage.ownerHint === undefined) {
    return null;
  }
  const node = nodes.find(
    (n) => n.id === stage.ownerHint && n.kind === 'agent',
  );
  return node === undefined ? null : node.id;
}

export function stageMapPrompt(
  stages: readonly TeamStage[],
  nodes: readonly TeamNode[],
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
    const owner = ownerOf(stage, nodes);
    if (owner !== null) {
      parts.push(`usually done by ${owner}`);
    }
    const head = parts.join(' — ');
    const body = [
      stage.instructions?.trim()
        ? `   What to do: ${stage.instructions.trim()}`
        : null,
      `   Done when: ${stage.doneWhen.trim()}`,
    ].filter((line): line is string => line !== null);
    return [head, ...body].join('\n');
  });
  return [
    'This team has stages every run walks, in order:',
    ...lines,
    '',
    `Each of your turns starts with the current stage. When the current stage's "done when" holds, mark it with ${HOST_MOVE_STAGE_TOOL} (action "complete", a one-line summary). Skip a stage that does not apply with action "skip" and the reason; at a stage with ONE-of branches, name the branch you take as "next". If an earlier stage turns out unfinished, reopen it with action "reopen" and the reason — that also reopens every stage after it.`,
    'Any agent of the run may move a stage; "usually done by" is a hint, not a rule. Move only the stage you finished, and only when it is the current one.',
  ].join('\n');
}

export function stageMapOf(
  team: Pick<Team, 'stages' | 'nodes'>,
): string | null {
  const stages = walkableStages(team);
  return stages === null ? null : stageMapPrompt(stages, team.nodes);
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
  const doneWhen =
    stage === undefined ? '' : ` — done when: ${stage.doneWhen.trim()}`;
  return `<stage>Current stage: ${named(stages, progress.current)} (${index}/${total})${doneWhen}</stage>`;
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
  nodes: readonly TeamNode[],
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
  if (stage.instructions?.trim()) {
    lines.push(`What to do: ${stage.instructions.trim()}`);
  }
  lines.push(`Done when: ${stage.doneWhen.trim()}`);
  const next = stage.next ?? [];
  if (next.length > 1) {
    lines.push(
      `Then ONE of: ${next.map((id) => named(stages, id)).join(' | ')} — name it as "next" when you complete or skip this stage.`,
    );
  }
  const owner = ownerOf(stage, nodes);
  if (owner !== null) {
    lines.push(`Usually done by: ${owner}.`);
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
  nodes: readonly TeamNode[],
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
  return `${what}.\n${currentStageBrief(stages, nodes, progress)}`;
}

const USER_VERB: Record<StageMoveAction, string> = {
  complete: 'marked done',
  skip: 'skipped',
  reopen: 'reopened',
};

export function userMoveWake(
  stages: readonly TeamStage[],
  nodes: readonly TeamNode[],
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
    currentStageBrief(stages, nodes, progress),
  ].join('\n');
}
