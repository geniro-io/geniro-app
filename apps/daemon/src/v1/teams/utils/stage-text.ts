import {
  HOST_MOVE_STAGE_TOOL,
  HOST_TEAM_NOTES_TOOL,
  type StageActor,
  type StageMoveAction,
  type StageProgress,
} from '../../agents/chat.types';
import { hiddenTextAsSpaces } from '../../agents/utils/hidden-text';
import type { Team, TeamMember, TeamMode, TeamStage } from '../teams.types';
import { walkableStages } from './stage-validate';
import { stageLeadOf } from './team-roster';

export const MAX_AGENT_STAGE_TEXT_LINES = 3;
export const MAX_STAGE_TEXT_LENGTH = 600;
export const MAX_HANDOFF_BRIEF_LENGTH = 4000;
export const MAX_HANDOFF_REQUEST_LENGTH = 1200;
export const MAX_HANDOFF_HOW_TO_WORK_LENGTH = 1000;

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

export function memberName(
  members: readonly Pick<TeamMember, 'id' | 'name'>[],
  id: string,
): string {
  return members.find((m) => m.id === id)?.name ?? id;
}

/** A relay stage's lead ({@link stageLeadOf}) and the other members it involves, by name; null when it has no lead. */
function relayRolesOf(
  stage: TeamStage,
  members: readonly TeamMember[],
): { lead: string; involve: string[] } | null {
  const lead = stageLeadOf(stage, members);
  if (lead === null) {
    return null;
  }
  const involve = (stage.responsible ?? []).flatMap((id) => {
    const member = members.find((m) => m.id === id);
    return member === undefined || id === lead ? [] : [member.name];
  });
  return { lead: memberName(members, lead), involve };
}

export function stageMapPrompt(
  stages: readonly TeamStage[],
  members: readonly TeamMember[],
  mode: TeamMode = 'lead',
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
    if (mode === 'relay') {
      const roles = relayRolesOf(stage, members);
      if (roles !== null) {
        parts.push(`led by ${roles.lead}`);
        if (roles.involve.length > 0) {
          parts.push(`involve: ${roles.involve.join(', ')}`);
        }
      }
    } else {
      const responsible = responsibleOf(stage, members);
      if (responsible !== null) {
        parts.push(`responsible: ${responsible}`);
      }
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
    mode === 'relay'
      ? "Stages run as a relay: each stage's lead owns it end to end — it coordinates the work, calls any other member for help, and is the one who moves the stage. Other members help when called. When the lead moves a stage on, geniro hands the run to the next stage's lead with a brief, and the user's messages go to that lead from then on."
      : 'Any member of the run may move a stage; the responsible members are who usually do it, not the only ones allowed to. Move only the stage you finished, and only when it is the current one.',
  ].join('\n');
}

export function stageMapOf(
  team: Pick<Team, 'stages' | 'members' | 'mode'>,
): string | null {
  const stages = walkableStages(team);
  return stages === null
    ? null
    : stageMapPrompt(stages, team.members, team.mode);
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
  mode: TeamMode = 'lead',
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
  if (mode === 'relay') {
    const roles = relayRolesOf(stage, members);
    if (roles !== null) {
      lines.push(`Led by: ${roles.lead}.`);
      if (roles.involve.length > 0) {
        lines.push(
          `Involve: ${roles.involve.join(', ')} — guidance, not a limit: any member may be called.`,
        );
      }
    }
    return lines.join('\n');
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
  relay?: { mode: TeamMode; lead: string | null; previousLead: string | null },
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
  const brief = currentStageBrief(
    stages,
    members,
    progress,
    relay?.mode ?? 'lead',
  );
  if (
    relay?.mode === 'relay' &&
    relay.lead !== null &&
    relay.lead !== relay.previousLead
  ) {
    return `${what}.\n${brief}\ngeniro hands the run to ${memberName(members, relay.lead)} with a brief; they lead from here. Finish this turn with a short wrap-up — do not start the next stage's work.`;
  }
  return `${what}.\n${brief}`;
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
  mode: TeamMode = 'lead',
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
    currentStageBrief(stages, members, progress, mode),
  ].join('\n');
}

function actorName(by: StageActor, members: readonly TeamMember[]): string {
  switch (by.kind) {
    case 'agent':
      return memberName(members, by.nodeId);
    case 'user':
      return 'the user';
    case 'system':
      return 'geniro';
  }
}

/**
 * An agent's words as one quotable line: every line break, control, format
 * or invisible character becomes a space (`hiddenTextAsSpaces`), and a
 * straight double quote a closing curly one, so the text can neither start a
 * line of its own, close the quotes around it, nor reorder itself on screen.
 */
export function quotedLine(text: string): string {
  return hiddenTextAsSpaces(text)
    .replace(/"/g, '\u201d')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function capped(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export interface HandOffBriefInput {
  stages: readonly TeamStage[];
  members: readonly TeamMember[];
  progress: StageProgress;
  lead: string;
  previousLead: string | null;
  request: string | null;
  unreadTeamNotes: number;
  userReason?: { action: StageMoveAction; stageId: string; text: string };
}

/**
 * What the next stage's lead is woken with when a relay run is handed to it:
 * the stage, the run's request, what each finished stage left, the unread
 * team notes and its mandate — at most {@link MAX_HANDOFF_BRIEF_LENGTH}
 * characters, the oldest finished stages left out first.
 */
export function handOffBrief(input: HandOffBriefInput): string {
  const { stages, members, progress, lead, previousLead } = input;
  const from =
    previousLead !== null && previousLead !== lead
      ? `, handed over from ${memberName(members, previousLead)}`
      : '';
  const head =
    progress.current === null
      ? `[geniro] The run is handed to you (${memberName(members, lead)})${from}. Every stage is done.`
      : `[geniro] You (${memberName(members, lead)}) lead the run now${from}.`;
  const opening: string[] = [head];
  if (input.userReason !== undefined) {
    opening.push(
      `The user ${USER_VERB[input.userReason.action]} the stage ${titleOf(stages, input.userReason.stageId)}. Their reason: "${capped(input.userReason.text, MAX_STAGE_TEXT_LENGTH)}"`,
    );
  }
  const briefed = stages.map((stage) =>
    stage.id === progress.current && stage.howToWork !== undefined
      ? {
          ...stage,
          howToWork: capped(stage.howToWork, MAX_HANDOFF_HOW_TO_WORK_LENGTH),
        }
      : stage,
  );
  opening.push(currentStageBrief(briefed, members, progress, 'relay'));
  if (input.request !== null && input.request.trim() !== '') {
    opening.push(
      `The run's request: "${capped(input.request, MAX_HANDOFF_REQUEST_LENGTH)}"`,
    );
  }
  const closing: string[] = [];
  if (input.unreadTeamNotes > 0) {
    closing.push(
      `Unread team notes: ${input.unreadTeamNotes} — read them with ${HOST_TEAM_NOTES_TOOL}.`,
    );
  }
  closing.push(
    progress.current === null
      ? 'Wrap the run up for the user.'
      : `You lead this stage end to end: call other members for help, and finish it with ${HOST_MOVE_STAGE_TOOL}.`,
  );
  const finished = progress.stages
    .filter(
      (entry) =>
        (entry.status === 'done' || entry.status === 'skipped') &&
        entry.rev !== undefined,
    )
    .sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0))
    .map((entry) => {
      const verb = entry.status === 'done' ? 'done' : 'skipped';
      const by =
        entry.by === undefined ? '' : ` by ${actorName(entry.by, members)}`;
      const said = quotedLine(entry.text ?? '');
      const text = said === '' ? '' : `: "${said}"`;
      return `- ${entry.title} — ${verb}${by}${text}`;
    });
  const tail = closing.join('\n');
  const render = (kept: readonly string[]): string => {
    const left = finished.length - kept.length;
    const done =
      finished.length === 0
        ? []
        : [
            'Stages so far:',
            ...(left > 0 ? [`(${left} earlier stages left out)`] : []),
            ...kept,
          ];
    return [...opening, ...done].join('\n');
  };
  const room = MAX_HANDOFF_BRIEF_LENGTH - tail.length - 1;
  let kept = finished;
  while (kept.length > 0 && render(kept).length > room) {
    kept = kept.slice(1);
  }
  return `${capped(render(kept), room)}\n${tail}`;
}

/** The transcript line a hand-off row carries. */
export function handOffLine(
  stages: readonly TeamStage[],
  members: readonly TeamMember[],
  progress: StageProgress,
  lead: string,
): string {
  return progress.current === null
    ? `${memberName(members, lead)} leads the run now.`
    : `${memberName(members, lead)} leads ${titleOf(stages, progress.current)} now.`;
}
