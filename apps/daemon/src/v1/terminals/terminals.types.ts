/** Lifecycle of one live PTY mirror session (in-memory only — never SQLite). */
export type TerminalStatus = 'running' | 'exited';

/** Wire shape of a terminal session as the HTTP/WS surfaces report it. */
export interface TerminalSessionWire {
  id: string;
  /** The chat/workflow run this terminal mirrors. */
  runId: string;
  /** Graph node within the run, or null for a single-agent chat. */
  nodeId: string | null;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: number;
}

/** One streamed terminal event: raw PTY output bytes, or the final exit. */
export type TerminalEvent =
  { kind: 'data'; data: string } | { kind: 'exit'; exitCode: number | null };
