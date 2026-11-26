import { z } from 'zod';

import {
  applyArgSynonyms,
  type ArgSynonyms,
  leadWithCall,
} from '../../../../utils/tool-arg-synonyms';
import { StageMoveActionSchema } from '../../../agents/chat.types';
import type {
  StageMoveRequest,
  StageMoveResult,
  TeamMember,
} from '../../../teams/teams.types';
import { moveReply } from '../../../teams/utils/stage-text';
import { readToolArgs } from '../tool-args';

export const MOVE_STAGE_SYNONYMS: ArgSynonyms = {
  summary: 'text',
  reason: 'text',
};

const MOVE_STAGE_CALL =
  'call move_stage({action: "complete", stage: "<stage id>", text: "<what was done>"}).';

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
  const renamed = applyArgSynonyms(args, MOVE_STAGE_SYNONYMS);
  const read = renamed.ok
    ? readToolArgs(MoveStageArgsSchema, renamed.args)
    : renamed;
  if (!read.ok) {
    return { error: leadWithCall(MOVE_STAGE_CALL, read.error) };
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
  members: readonly TeamMember[],
): { text: string; isError: boolean } {
  if (!result.ok) {
    return { text: `${result.code}: ${result.message}`, isError: true };
  }
  return {
    text: moveReply(
      result.stages,
      members,
      {
        action: result.payload.action as StageMoveRequest['action'],
        stageId: result.payload.stageId,
        ...(result.payload.next !== undefined
          ? { next: result.payload.next }
          : {}),
      },
      result.progress,
      result.resets,
      {
        mode: result.team.mode,
        lead: result.lead,
        previousLead: result.previousLead,
      },
    ),
    isError: false,
  };
}
