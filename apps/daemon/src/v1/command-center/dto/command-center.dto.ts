import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  CommandCenterBoardSchema,
  CommandCenterChatsDiscardedSchema,
  CommandCenterStartsSchema,
  START_FAILURE_MAX_CHARS,
  StartCommandCenterChatSchema,
} from '../command-center.types';

/** The most run ids one subset re-read may name. */
const BOARD_RUN_IDS_MAX = 200;

export const commandCenterBoardQuerySchema = z.object({
  runIds: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id !== ''),
    )
    .pipe(z.array(z.string()).max(BOARD_RUN_IDS_MAX).optional())
    .describe(
      'Only these runs, comma-separated — a re-read of the cards that moved',
    ),
});
export class CommandCenterBoardQueryDto extends createZodDto(
  commandCenterBoardQuerySchema,
) {}

export class CommandCenterBoardDto extends createZodDto(
  CommandCenterBoardSchema,
) {}

export class StartCommandCenterChatDto extends createZodDto(
  StartCommandCenterChatSchema,
) {}

export class CommandCenterChatsDiscardedDto extends createZodDto(
  CommandCenterChatsDiscardedSchema,
) {}

export const commandCenterStartsQuerySchema = z.object({
  state: z.literal('approved'),
});
export class CommandCenterStartsQueryDto extends createZodDto(
  commandCenterStartsQuerySchema,
) {}

export class CommandCenterStartsDto extends createZodDto(
  CommandCenterStartsSchema,
) {}

/** TWIN PARSER: `MAX_PREPARE_FAILURE_CHARS` in `apps/ui/src/main/task-run-start.ts` cuts to the same length. */
export const commandCenterStartFailedSchema = z.object({
  reason: z.string().min(1).max(START_FAILURE_MAX_CHARS),
});
export class CommandCenterStartFailedDto extends createZodDto(
  commandCenterStartFailedSchema,
) {}
