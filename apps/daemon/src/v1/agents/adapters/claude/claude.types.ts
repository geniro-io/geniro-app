import type { AgentVersionService } from '../../services/agent-version.service';
import type { AgentAdapterOptions } from '../agent-adapter';

/**
 * The types that are `claude`'s alone.
 *
 * Anything a SECOND adapter could hold lives in `adapters/adapter.types.ts`;
 * what sits here is shaped by this one CLI — its option bag, the content-block
 * shape its stream-json stdin takes, the projection of its own question tool's
 * payload, and the shapes of its permission-mode probe.
 */

/** Claude-specific constructor options (the bag stays a test seam). */
export interface ClaudeAdapterOptions extends AgentAdapterOptions {
  /**
   * Directory for the per-turn `--mcp-config` files (the daemon passes its
   * userData tmp dir); falls back to the OS tmpdir for standalone/spec use.
   */
  mcpConfigDir?: string;
  /** Home dir holding `.claude.json` (test seam); defaults to the real one. */
  homeDir?: string;
  /**
   * Whether a session's first prompt waits for the CLI's MCP servers to finish
   * dialling (`ClaudeTurnDriver.awaitPromptReady`). Defaults to ON — the wait
   * is the fix, and turning it off restores the defect.
   *
   * A test seam, and one with a narrow purpose: the gate makes the opening
   * write ASYNCHRONOUS, so a spec about argv or about what lands on stdin
   * would otherwise have to answer a whole `mcp_status` conversation before it
   * could observe a single byte. Those specs set it false and assert what they
   * are about; the gate has its own specs (`claude-turn.driver.spec.ts`) and
   * the seam that carries it has its own (`spawn-cli.session.spec.ts`).
   */
  waitForMcpServers?: boolean;
}

/** One Messages-API image content block, as claude's stream-json input takes it. */
export interface ClaudeImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/** One question of an AskUserQuestion payload, projected defensively. */
export interface ClaudeQuestion {
  question: string;
  /** The CLI's short tab title for this question; null when it sent none. */
  header: string | null;
  options: string[];
  multiSelect: boolean;
}

// ── The permission-mode probe ─────────────────────────────────────────────

/** The permission modes whose headless support is empirical, not assumed. */
export type ClaudeProbedMode = 'acceptEdits' | 'plan';

export interface ClaudeProbeOptions {
  /** Temp workspaces root (test seam); default `<userData>/claude-probe`. */
  probeRootDir?: string;
  /** Verdict cache file (test seam); default `<userData>/claude-probe.json`. */
  cachePath?: string;
  turnTimeoutMs?: number;
  /** Replacement version resolver for tests. */
  resolveVersionFn?: AgentVersionService['resolve'];
}
