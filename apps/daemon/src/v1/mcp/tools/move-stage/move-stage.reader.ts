import { z } from 'zod';

import { StageMoveActionSchema } from '../../../agents/chat.types';
import type {
  StageMoveRequest,
  StageMoveResult,
  WorkflowNode,
} from '../../../graphs/graphs.types';
import { moveReply } from '../../../graphs/utils/stage-text';
import { readToolArgs } from '../tool-args';

const MoveStageArgsSchema = z
  .object({
    action: StageMoveActionSchema,
    stage: z.string().trim().min(1, 'stage is empty'),
    next: z.string().trim().min(1).optional(),
    text: z.string(),
  })
  .strict();

export function readMoveStage(
  args: Record<string, unknown>,
): StageMoveRequest | { error: string } {
  const read = readToolArgs(MoveStageArgsSchema, args);
  if (!read.ok) {
    return { error: read.error };
  }
  return {
    action: read.query.action,
    stage: read.query.stage,
    ...(read.query.next !== undefined ? { next: read.query.next } : {}),
    text: read.query.text,
  };
}

export function moveStageResultText(
  result: StageMoveResult,
  nodes: readonly WorkflowNode[],
): { text: string; isError: boolean } {
  if (!result.ok) {
    return { text: `${result.code}: ${result.message}`, isError: true };
  }
  return {
    text: moveReply(
      result.stages,
      nodes,
      {
        action: result.payload.action as StageMoveRequest['action'],
        stageId: result.payload.stageId,
        ...(result.payload.next !== undefined
          ? { next: result.payload.next }
          : {}),
      },
      result.progress,
      result.resets,
    ),
    isError: false,
  };
}
