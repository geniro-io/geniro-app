import type { resolveAgentVersion } from '../../utils/agent-version';
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
  resolveVersionFn?: typeof resolveAgentVersion;
}
