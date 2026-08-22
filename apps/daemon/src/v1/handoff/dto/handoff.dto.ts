import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { HandoffTargetSchema } from '../handoff.types';

/**
 * The root schema deliberately carries NO `.meta({ id })`: nestjs-zod would
 * then register the component under that id while the response still points at
 * the DTO class name, and `setupSwagger` fails the boot on the dangling `$ref`.
 */
export class HandoffTargetDto extends createZodDto(HandoffTargetSchema) {}

export const HandoffQuerySchema = z.object({
  runId: z.string().min(1),
  /** The graph node; omitted for a single-agent chat. */
  nodeId: z.string().min(1).optional(),
  /**
   * A specific thread of that node — a call thread's own resume id. Omitted
   * means the node's latest session.
   */
  sessionId: z.string().min(1).optional(),
});
export class HandoffQueryDto extends createZodDto(HandoffQuerySchema) {}
