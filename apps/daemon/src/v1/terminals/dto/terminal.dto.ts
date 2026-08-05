import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  MAX_COLS,
  MAX_ROWS,
  TerminalKindSchema,
  TerminalSessionWireSchema,
} from '../terminals.types';

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
   * Which mirror to open. Defaults to `live` — following the run's own turns
   * is what a terminal on a running agent is for, and the `interactive`
   * `--resume` session cannot do it (a separate process cannot advance while
   * the chat's headless turn holds the conversation).
   *
   * `.default()` rather than `.optional()` so the default is part of the
   * PUBLISHED schema: this is a request-only DTO, so it never faces the
   * request/response duplication that keeps `WorkflowSchema` default-free, and
   * without it the generated client states the field is optional while saying
   * nothing about what omitting it means.
   */
  kind: TerminalKindSchema.default('live'),
  /**
   * Mirror one SPECIFIC CLI session of the node (a call thread's resume id
   * from its `call_result` item) instead of the node's latest session.
   * Shape-checked here; the agent's own adapter (`AgentAdapter.terminalCommand`)
   * re-validates against ITS session-id shape before argv.
   */
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .optional(),
  cols: z.coerce.number().int().min(1).max(MAX_COLS).optional(),
  rows: z.coerce.number().int().min(1).max(MAX_ROWS).optional(),
});
export class CreateTerminalDto extends createZodDto(createTerminalSchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** A live PTY mirror session. */
export class TerminalSessionDto extends createZodDto(
  TerminalSessionWireSchema,
) {}

/** Acknowledgement of a terminal kill. */
export class DisposedDto extends createZodDto(
  z.object({ disposed: z.boolean() }),
) {}
