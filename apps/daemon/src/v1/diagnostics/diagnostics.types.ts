import { z } from 'zod';

/**
 * Where an entry came from. A CHANNEL, not a level: the panel's primary
 * question is "which plane is misbehaving", and severity is a second axis that
 * cuts across all of them.
 */
export const DebugChannelSchema = z
  .enum(['daemon', 'transcript', 'agent-stdio', 'ui'])
  .meta({ id: 'DebugChannel' });
export type DebugChannel = z.infer<typeof DebugChannelSchema>;

/** Every channel, in the order the panel offers them. */
export const DEBUG_CHANNELS = [
  'daemon',
  'transcript',
  'agent-stdio',
  'ui',
] as const satisfies readonly DebugChannel[];

/**
 * The channels a fresh daemon records.
 *
 * `agent-stdio` is deliberately OUT. It is the raw conversation with the
 * user's CLI — every file the agent read, every diff it wrote — at a volume of
 * megabytes per turn, and it is the one channel whose contents are the user's
 * source code rather than the daemon's own account of itself. Recording that
 * by default would be a decision made on their behalf; it is one toggle away
 * in the panel, and the toggle says what it turns on.
 */
export const DEFAULT_DEBUG_CHANNELS: readonly DebugChannel[] = [
  'daemon',
  'transcript',
  'ui',
];

export const DebugLevelSchema = z
  .enum(['trace', 'debug', 'info', 'warn', 'error'])
  .meta({ id: 'DebugLevel' });
export type DebugLevel = z.infer<typeof DebugLevelSchema>;

/**
 * One line in the debug log.
 *
 * `seq` is monotonic per daemon launch and is what the renderer polls with
 * (`afterSeq`) and de-dupes the live/replay seam by — the same shape the
 * transcript uses, for the same reason, and this time with ONE writer so it
 * cannot collide (see `ItemSeqAllocator` for what the two-writer version
 * cost).
 */
export const DebugEntrySchema = z.object({
  seq: z.number().int().describe('Monotonic within one daemon launch'),
  at: z.string().describe('ISO timestamp'),
  channel: DebugChannelSchema,
  level: DebugLevelSchema,
  message: z.string(),
  /**
   * Whatever identifies the thing this line is about — a run, a node, a pid, a
   * folder. Free-form ON PURPOSE: the channels have genuinely different
   * subjects (a transcript line has a run, a stdio line has a process), and a
   * union of every possible key would be a schema nobody could read.
   */
  context: z.record(z.string(), z.string()).nullable(),
});
export type DebugEntry = z.infer<typeof DebugEntrySchema>;

/** A page of entries plus where the reader has now caught up to. */
export const DebugLogPageSchema = z.object({
  entries: z.array(DebugEntrySchema),
  /** Highest seq the daemon has issued — a reader at this seq is current. */
  lastSeq: z.number().int(),
  /**
   * Entries dropped since the reader's cursor because the ring wrapped. Said
   * out loud rather than left as a silent gap: a debug log that quietly loses
   * the lines you were looking for is worse than one that admits it did.
   */
  dropped: z.number().int(),
  /** Which channels are being recorded right now. */
  channels: z.array(DebugChannelSchema),
  /** Absolute path of the file entries are also written to, or null. */
  filePath: z.string().nullable(),
});
export type DebugLogPage = z.infer<typeof DebugLogPageSchema>;

/** Which channels to record from now on. */
export const DebugSettingsSchema = z.object({
  channels: z.array(DebugChannelSchema),
});
export type DebugSettings = z.infer<typeof DebugSettingsSchema>;

/** One line the RENDERER recorded, handed to the daemon so it reaches the file. */
export const UiLogInputSchema = z.object({
  level: DebugLevelSchema,
  message: z.string().max(8_000),
  context: z.record(z.string(), z.string()).nullable().optional(),
});
export type UiLogInput = z.infer<typeof UiLogInputSchema>;

/**
 * The one-paste answer to "what is your setup and what just happened".
 *
 * Everything here is something a maintainer would otherwise ask for one
 * question at a time. It carries no secrets — `redact.ts` scrubs the entries,
 * and the fields below are versions and paths.
 */
export const DiagnosticsReportSchema = z.object({
  generatedAt: z.string(),
  daemon: z.object({
    version: z.string(),
    pid: z.number().int(),
    host: z.string(),
    port: z.number().int().nullable(),
    startedAt: z.string(),
    uptimeSeconds: z.number().int(),
    nodeVersion: z.string(),
    platform: z.string(),
    arch: z.string(),
    userDataDir: z.string(),
    logFilePath: z.string().nullable(),
  }),
  agents: z.array(
    z.object({
      kind: z.string(),
      binary: z.string(),
      version: z.string().nullable(),
      unavailableReason: z.string().nullable(),
    }),
  ),
  runs: z.object({
    total: z.number().int(),
    running: z.number().int(),
    liveTurns: z.number().int(),
    liveSessions: z.number().int(),
  }),
  /** The tail of the log, already redacted — the actual evidence. */
  recentEntries: z.array(DebugEntrySchema),
});
export type DiagnosticsReport = z.infer<typeof DiagnosticsReportSchema>;
