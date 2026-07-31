import type { ChildProcess, execFile } from 'node:child_process';

import type { resolveAgentVersion } from '../../utils/agent-version';

/**
 * Every type that belongs to the `cursor-agent` adapter alone — the shapes of
 * its `.cursor/mcp.json` merge lifecycle and of its MCP-trust probe. Nothing
 * here is adapter-agnostic; the shared contract types live in
 * `adapters/adapter.types.ts`.
 */

// ── The `.cursor/mcp.json` server entry ───────────────────────────────────

/** The one server entry geniro ever writes into a `.cursor/mcp.json`. */
export interface CursorMcpServerEntry {
  url: string;
  headers: Record<string, string>;
  /**
   * Headless cursor-agent silently drops MCP tools that are not approved;
   * scoping auto-approval to OUR tool names (never `--approve-mcps`, which
   * would blanket-approve the user's other servers too) keeps the trust
   * expansion bounded to what geniro itself serves.
   */
  autoApprove: string[];
}

// ── The merge's file state ────────────────────────────────────────────────

export interface CursorMcpMergeState {
  /** True when geniro created the file (restore may delete the empty shell). */
  created: boolean;
  /** Original file mode to restore (absent when geniro created the file). */
  mode?: number;
}

export type CursorMcpMergeResult =
  ({ ok: true } & CursorMcpMergeState) | { ok: false; reason: string };

// ── The crash journal ─────────────────────────────────────────────────────

export interface CursorMergeJournalEntry {
  cwd: string;
  /** Mirror of the merge state — restore may delete a file geniro created. */
  created: boolean;
  /** Original file mode to restore (merged-into-existing files only). */
  mode?: number;
  ts: number;
}

// ── `cursor-agent mcp enable` ─────────────────────────────────────────────

export interface EnableGeniroMcpOptions {
  timeoutMs?: number;
  /** Replacement execFile for tests. */
  execFileFn?: typeof execFile;
  /** Called with the spawned child so the caller can register it. */
  onSpawn?: (child: ChildProcess) => void;
}

// ── The merge service ─────────────────────────────────────────────────────

export interface CursorMcpMergeOptions {
  /** Crash journal (test seam); default `<userData>/cursor-mcp-journal.json`. */
  journalPath?: string;
  lockWaitMs?: number;
  /** Replacement execFile for tests (`mcp enable` + git children). */
  execFileFn?: typeof execFile;
  /** Replacement restore for failure-path tests. */
  restoreFn?: (cwd: string, state: CursorMcpMergeState) => boolean;
}

export type CursorMcpAcquireResult =
  | {
      ok: true;
      /** `.cursor/mcp.json` is git-tracked — surface the commit warning. */
      gitTracked: boolean;
      /** Restore the file, clear the journal, free the cwd. Idempotent. */
      release: () => void;
    }
  | { ok: false; reason: string };

// ── The MCP-trust probe ───────────────────────────────────────────────────

export interface CursorProbeOptions {
  /** Temp workspaces root (test seam); default `<userData>/cursor-probe`. */
  probeRootDir?: string;
  /** Verdict cache file (test seam); default `<userData>/cursor-probe.json`. */
  cachePath?: string;
  turnTimeoutMs?: number;
  /** Replacement execFile for tests (the `mcp enable` child). */
  execFileFn?: typeof execFile;
  /** Replacement version resolver for tests. */
  resolveVersionFn?: typeof resolveAgentVersion;
}
