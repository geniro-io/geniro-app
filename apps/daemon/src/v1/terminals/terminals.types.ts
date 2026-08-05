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
 * Wire shape of a terminal session as the HTTP/WS surfaces report it.
 *
 * There is exactly ONE kind of terminal: a `--resume` CLI process under a PTY,
 * showing the agent's own interactive TUI. A second, read-only `live` kind used
 * to exist — the raw stdio of the headless turn, tee'd as it happened — and was
 * deleted: it followed the conversation, but what it showed was the CLI's WIRE
 * format (claude's stream-json), which is not a terminal in any sense the user
 * asked for. The synchronisation it existed to provide is now
 * {@link TerminalSessionsService.refresh} — the resumed TUI is respawned when a
 * turn settles, so it re-reads the transcript instead of freezing at the moment
 * it opened.
 *
 * The consequence is deliberate: a CLI whose adapter declares no terminal
 * (cursor-agent's `terminal: null`) has no terminal at all, rather than a
 * JSON-stream stand-in.
 */
export const TerminalSessionWireSchema = z.object({
  id: z.string(),
  runId: z.string().describe('The chat/workflow run this terminal mirrors'),
  nodeId: z
    .string()
    .nullable()
    .describe('Graph node within the run; null for a single-agent chat'),
  resumeSessionId: z
    .string()
    .nullable()
    .describe(
      'The CLI session this mirror resumes — the node thread it targets',
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
