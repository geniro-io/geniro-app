/**
 * Lifecycle of one live PTY mirror session (in-memory only — never SQLite).
 * `closing` = kill requested, PTY not yet exited — the session stays mapped so
 * an instant reopen can't race a second `--resume` onto the same CLI session.
 * Mirrored in the UI wire contract (apps/ui/src/shared/contracts.ts).
 */
export type TerminalStatus = 'running' | 'closing' | 'exited';

/** Wire shape of a terminal session as the HTTP/WS surfaces report it. */
export interface TerminalSessionWire {
  id: string;
  /** The chat/workflow run this terminal mirrors. */
  runId: string;
  /** Graph node within the run, or null for a single-agent chat. */
  nodeId: string | null;
  /** The CLI session this mirror resumes — the node thread it targets. */
  resumeSessionId: string | null;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: number;
}

/** One streamed terminal event: raw PTY output bytes, or the final exit. */
export type TerminalEvent =
  { kind: 'data'; data: string } | { kind: 'exit'; exitCode: number | null };

/**
 * Terminal-size bounds shared by the HTTP DTO's validation and the PTY
 * service's runtime clamp, so the two can never diverge.
 */
export const MAX_COLS = 500;
export const MAX_ROWS = 300;
