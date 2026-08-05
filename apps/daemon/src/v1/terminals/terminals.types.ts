import { z } from 'zod';

/**
 * Lifecycle of one live PTY mirror session (in-memory only — never SQLite).
 * `closing` = kill requested, PTY not yet exited — the session stays mapped so
 * an instant reopen can't race a second `--resume` onto the same CLI session.
 */
export const TerminalStatusSchema = z
  .enum(['running', 'closing', 'exited'])
  .meta({ id: 'TerminalStatus' });
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

/**
 * What a terminal session actually shows.
 *
 * `live` mirrors the run's OWN turns — the raw stdio of the headless child the
 * chat is already driving, tee'd as it happens. It follows the conversation and
 * is read-only: there is no second process to type into.
 *
 * `interactive` spawns a SEPARATE `--resume` CLI process on the same stored
 * conversation. It accepts input, but it is a different process: it replays the
 * transcript at startup and then cannot advance while the chat's own turn runs.
 * That gap is precisely what `live` exists to close, so `live` is the default
 * and `interactive` is the deliberate pick.
 */
export const TerminalKindSchema = z
  .enum(['live', 'interactive'])
  .meta({ id: 'TerminalKind' });
export type TerminalKind = z.infer<typeof TerminalKindSchema>;

/** Wire shape of a terminal session as the HTTP/WS surfaces report it. */
export const TerminalSessionWireSchema = z.object({
  id: z.string(),
  kind: TerminalKindSchema,
  runId: z.string().describe('The chat/workflow run this terminal mirrors'),
  nodeId: z
    .string()
    .nullable()
    .describe('Graph node within the run; null for a single-agent chat'),
  resumeSessionId: z
    .string()
    .nullable()
    .describe(
      'The CLI session an interactive mirror resumes — the node thread it ' +
        'targets. Always null for a live mirror, which follows the node itself ' +
        'rather than any one CLI session',
    ),
  cwd: z.string(),
  status: TerminalStatusSchema,
  exitCode: z.number().int().nullable(),
  createdAt: z.number(),
});
export type TerminalSessionWire = z.infer<typeof TerminalSessionWireSchema>;

/** One streamed terminal event: raw PTY output bytes, or the final exit. */
export type TerminalEvent =
  { kind: 'data'; data: string } | { kind: 'exit'; exitCode: number | null };

/**
 * Terminal-size bounds shared by the HTTP DTO's validation and the PTY
 * service's runtime clamp, so the two can never diverge.
 */
export const MAX_COLS = 500;
export const MAX_ROWS = 300;
