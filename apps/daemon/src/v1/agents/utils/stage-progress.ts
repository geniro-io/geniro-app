import {
  type StageProgress,
  StageProgressSchema,
  type TaskStageLine,
} from '../chat.types';

export function readRunStageProgress(
  stored: string | null,
): StageProgress | null {
  if (stored === null) {
    return null;
  }
  try {
    const parsed = StageProgressSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeRunStageProgress(progress: StageProgress): string {
  return JSON.stringify(progress);
}

export function stageLineOf(progress: StageProgress): TaskStageLine {
  const current = progress.stages.find((s) => s.id === progress.current);
  return {
    title: current?.title ?? null,
    index: progress.position.index,
    total: progress.position.total,
  };
}
