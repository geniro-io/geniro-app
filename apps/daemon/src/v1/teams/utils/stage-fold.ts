import type {
  StageActor,
  StageProgress,
  StageProgressEntry,
} from '../../agents/chat.types';
import { writeRunStageProgress } from '../../agents/utils/stage-progress';
import type { StageMove, Team, TeamStage } from '../teams.types';
import { startStageId, walkableStages } from './stage-validate';

interface Resolution {
  status: 'done' | 'skipped';
  by: StageActor;
  text: string;
  at: string;
  rev: number;
  chosen?: string;
}

export function foldStages(
  stages: readonly TeamStage[],
  moves: readonly StageMove[],
): StageProgress {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const resolved = new Map<string, Resolution>();
  const reopenedAt = new Map<string, number>();
  let current: string | null = startStageId(stages);
  let rev = 0;

  for (const move of moves) {
    const stage = byId.get(move.stageId);
    if (stage === undefined) {
      continue;
    }
    if (move.action === 'reopen') {
      if (!resolved.has(stage.id)) {
        continue;
      }
      rev += 1;
      for (const id of [stage.id, ...descendantsOf(stage.id, byId)]) {
        resolved.delete(id);
        reopenedAt.set(id, rev);
      }
      current = stage.id;
      continue;
    }
    if (current !== stage.id) {
      continue;
    }
    const next = stage.next ?? [];
    const chosen =
      next.length === 1
        ? next[0]
        : next.length > 1 && move.next !== undefined && next.includes(move.next)
          ? move.next
          : undefined;
    if (next.length > 1 && chosen === undefined) {
      continue;
    }
    rev += 1;
    resolved.set(stage.id, {
      status: move.action === 'complete' ? 'done' : 'skipped',
      by: move.by,
      text: move.text,
      at: move.at,
      rev,
      ...(next.length > 1 && chosen !== undefined ? { chosen } : {}),
    });
    current = chosen ?? null;
  }

  const ahead =
    current === null ? new Set<string>() : reachableFrom(current, byId);
  const entries: StageProgressEntry[] = stages.map((stage) => {
    const resolution = resolved.get(stage.id);
    const reopened = reopenedAt.get(stage.id);
    const base = {
      id: stage.id,
      title: stage.title,
      next: stage.next ?? [],
      ...(reopened !== undefined ? { rev: reopened } : {}),
    };
    if (resolution !== undefined) {
      return {
        ...base,
        status: resolution.status,
        by: resolution.by,
        text: resolution.text,
        at: resolution.at,
        rev: resolution.rev,
        ...(resolution.chosen !== undefined
          ? { chosen: resolution.chosen }
          : {}),
      };
    }
    if (stage.id === current) {
      return { ...base, status: 'current' };
    }
    return { ...base, status: ahead.has(stage.id) ? 'pending' : 'not_taken' };
  });

  const finished = resolved.size;
  const path = current === null ? 0 : firstBranchLength(current, byId);
  return {
    rev,
    current,
    position: {
      index: current === null ? finished : finished + 1,
      total: finished + path,
    },
    stages: entries,
  };
}

function reachableFrom(
  id: string,
  byId: ReadonlyMap<string, TeamStage>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (seen.has(at)) {
      continue;
    }
    seen.add(at);
    queue.push(...(byId.get(at)?.next ?? []));
  }
  return seen;
}

function descendantsOf(
  id: string,
  byId: ReadonlyMap<string, TeamStage>,
): Set<string> {
  const all = reachableFrom(id, byId);
  all.delete(id);
  return all;
}

function firstBranchLength(
  id: string,
  byId: ReadonlyMap<string, TeamStage>,
): number {
  let length = 0;
  let at: string | undefined = id;
  const seen = new Set<string>();
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    length += 1;
    at = byId.get(at)?.next?.[0];
  }
  return length;
}

/** TWIN: stagesReopenResets in apps/ui/src/renderer/chats/stage-progress.ts. */
export function stagesReopenResets(
  stages: readonly TeamStage[],
  progress: StageProgress,
  id: string,
): string[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const resets = descendantsOf(id, byId);
  return progress.stages
    .filter(
      (s) =>
        resets.has(s.id) &&
        (s.status === 'done' ||
          s.status === 'skipped' ||
          s.status === 'current'),
    )
    .map((s) => s.id);
}

export function initialStageProgress(
  team: Pick<Team, 'stages' | 'nodes'>,
): string | null {
  const stages = walkableStages(team);
  return stages === null ? null : writeRunStageProgress(foldStages(stages, []));
}
