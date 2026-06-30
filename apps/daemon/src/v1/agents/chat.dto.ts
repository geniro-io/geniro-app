import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * HTTP input DTOs for the chat routes, validated by the global
 * `ZodValidationPipe` the http-server installs. `agentKind` mirrors the
 * `AgentKind` union; `cwd` is the user's project folder the daemon spawns the
 * CLI in (further validated server-side: must exist and be a directory).
 */
export const createChatSchema = z.object({
  agentKind: z.enum(['claude', 'cursor-agent']),
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});
export class CreateChatDto extends createZodDto(createChatSchema) {}

export const sendMessageSchema = z.object({
  text: z.string().min(1),
});
export class SendMessageDto extends createZodDto(sendMessageSchema) {}

export const historyQuerySchema = z.object({
  /** Replay cursor — return only items with seq greater than this. */
  afterSeq: z.coerce.number().int().optional(),
});
export class HistoryQueryDto extends createZodDto(historyQuerySchema) {}
