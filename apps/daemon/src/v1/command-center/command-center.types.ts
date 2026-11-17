import { z } from 'zod';

import { RunWireSchema } from '../agents/chat.types';
import { TaskStatusSchema } from '../tasks/tasks.types';
import { chatChipsSchema } from '../teams/teams.types';

const HOUR_MS = 60 * 60_000;

/** How far back the board reaches for threads that are neither working nor waiting. */
export const CommandCenterWindowSchema = z
  .enum(['24h', '7d'])
  .meta({ id: 'CommandCenterWindow' });
export type CommandCenterWindow = z.infer<typeof CommandCenterWindowSchema>;

export const COMMAND_CENTER_WINDOW_MS: Record<CommandCenterWindow, number> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
};

/** The stretch each card's timeline strip covers (user decision: the last 8 hours). */
export const STRIP_SPAN_MS = 8 * HOUR_MS;

/** How long a reply credit lasts after the manager's message. */
export const REPLY_CREDIT_MS = 2 * HOUR_MS;

/** How often roster removals may change the manager's brief with no addition beside them. */
export const ROSTER_REMOVAL_INTERVAL_MS = 6 * HOUR_MS;

/** The status table's caps: the lines a manager turn reads, and their width. */
export const STATUS_SUFFIX_MAX_LINES = 40;
export const STATUS_SUFFIX_LINE_MAX = 160;

/** The most markers one strip carries — the newest are kept. */
export const STRIP_MAX_MARKERS = 80;

/** The board's computed columns; never dragged. */
export const CommandCenterColumnSchema = z
  .enum(['working', 'waiting', 'idle', 'in_review', 'done'])
  .meta({ id: 'CommandCenterColumn' });
export type CommandCenterColumn = z.infer<typeof CommandCenterColumnSchema>;

export const StripSpanSchema = z
  .object({
    kind: z.enum(['work', 'waiting']),
    start: z.string(),
    end: z.string().nullable().describe('Null while the span is still open'),
  })
  .meta({ id: 'CommandCenterStripSpan' });
export type StripSpan = z.infer<typeof StripSpanSchema>;

export const StripMarkerKindSchema = z
  .enum([
    'user_message',
    'question',
    'pr_opened',
    'stage',
    'failure',
    'manager_out',
    'manager_in',
  ])
  .meta({ id: 'CommandCenterStripMarkerKind' });
export type StripMarkerKind = z.infer<typeof StripMarkerKindSchema>;

export const StripMarkerSchema = z
  .object({
    kind: StripMarkerKindSchema,
    at: z.string(),
    label: z.string().nullable(),
  })
  .meta({ id: 'CommandCenterStripMarker' });
export type StripMarker = z.infer<typeof StripMarkerSchema>;

export const ThreadStripSchema = z
  .object({
    spans: z.array(StripSpanSchema),
    markers: z.array(StripMarkerSchema),
  })
  .meta({ id: 'CommandCenterStrip' });
export type ThreadStrip = z.infer<typeof ThreadStripSchema>;

export const CommandCenterCardSchema = z
  .object({
    run: RunWireSchema,
    handle: z
      .string()
      .nullable()
      .describe("The thread's roster handle (t3) on the manager, or null"),
    note: z.string().nullable().describe("The manager's own note on it"),
    column: CommandCenterColumnSchema,
    activity: z
      .string()
      .nullable()
      .describe('What the thread is doing now, one line'),
    strip: ThreadStripSchema,
    contact: z.object({
      lastAt: z
        .string()
        .nullable()
        .describe('The newest message between it and the manager'),
      awaitingReply: z
        .boolean()
        .describe('The manager waits on its reply to a message'),
    }),
  })
  .meta({ id: 'CommandCenterCard' });
export type CommandCenterCard = z.infer<typeof CommandCenterCardSchema>;

// No `.meta({ id })` — a RESPONSE DTO ROOT.
export const CommandCenterBoardSchema = z.object({
  generatedAt: z.string(),
  stripStart: z.string(),
  managerRunId: z.string().nullable(),
  cards: z.array(CommandCenterCardSchema),
});
export type CommandCenterBoard = z.infer<typeof CommandCenterBoardSchema>;

/** The composer settings the manager's chat opens with. */
export const StartCommandCenterChatSchema = chatChipsSchema.meta({
  id: 'StartCommandCenterChat',
});
export type StartCommandCenterChatInput = z.infer<
  typeof StartCommandCenterChatSchema
>;

export const CommandCenterChatsDiscardedSchema = z.object({
  deleted: z.number().int(),
});

/** One approved start Electron main's drain starts. */
export const CommandCenterStartSchema = z
  .object({
    taskId: z.string(),
    projectId: z.string(),
    title: z.string(),
    status: TaskStatusSchema,
    folder: z
      .string()
      .describe(
        "The card's folder, else its project's — where the worktree is cut",
      ),
  })
  .meta({ id: 'CommandCenterStart' });
export type CommandCenterStart = z.infer<typeof CommandCenterStartSchema>;

// No `.meta({ id })` — a RESPONSE DTO ROOT.
export const CommandCenterStartsSchema = z.object({
  starts: z.array(CommandCenterStartSchema),
});

/** The longest failure reason a start drain reports. */
export const START_FAILURE_MAX_CHARS = 1000;

/** Why the roster holds a thread. */
export const RosterReasonSchema = z.enum(['auto', 'manager', 'user']);
export type RosterReason = z.infer<typeof RosterReasonSchema>;

/**
 * TWIN PARSER: `parseCommandCenterChanged` in
 * `apps/ui/src/renderer/daemon-client.ts`.
 */
export interface CommandCenterChangedEvent {
  runIds: string[];
  reason: 'status' | 'items' | 'roster' | 'task';
}

/**
 * TWIN PARSER: `parseCommandCenterContact` in
 * `apps/ui/src/renderer/daemon-client.ts`.
 */
export interface CommandCenterContactEvent {
  messageId: string;
  fromRunId: string;
  toRunId: string;
  at: string;
  awaitingReply: boolean;
}
