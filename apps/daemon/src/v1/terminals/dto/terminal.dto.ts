import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MAX_COLS, MAX_ROWS } from '../terminals.types';

/**
 * HTTP input for opening a terminal mirror. `nodeId` is required for workflow
 * runs (each node is its own agent session) and omitted for single-agent
 * chats; initial cols/rows are optional — the client sends a `resize` over the
 * WS channel as soon as xterm measures its container. The size bounds reuse the
 * module's shared clamp constants so HTTP validation and the runtime clamp
 * can't diverge.
 */
export const createTerminalSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  /**
   * Mirror one SPECIFIC CLI session of the node (a call thread's resume id
   * from its `call_result` item) instead of the node's latest session.
   * Shape-checked here; `terminalCommand` re-validates before argv.
   */
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .optional(),
  cols: z.coerce.number().int().min(1).max(MAX_COLS).optional(),
  rows: z.coerce.number().int().min(1).max(MAX_ROWS).optional(),
});
export class CreateTerminalDto extends createZodDto(createTerminalSchema) {}
