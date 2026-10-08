/**
 * The parts of `codex app-server`'s wire this adapter reads, as it reads them.
 *
 * Deliberately narrower than the protocol: every field is what a parser here
 * pulls out of an `unknown` frame, never a claim about the whole message. The
 * full shapes are the CLI's own generated bindings (see `codex.const.ts`).
 */

/** One `TokenUsageBreakdown` — a request's, or a thread's running total. */
export interface CodexTokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/**
 * `thread/tokenUsage/updated`'s payload. `total` is the THREAD's running sum,
 * `last` the most recent request's own figures — and, measured right after a
 * compaction, `last.totalTokens` is the size the window was cut down to.
 */
export interface CodexTokenUsage {
  total: CodexTokenBreakdown;
  last: CodexTokenBreakdown;
  modelContextWindow: number | null;
}

/**
 * One `McpServerStatus` from `mcpServerStatus/list`, as this adapter reads it.
 * `runtimeStatus` is the THREAD's connection state, present when the listing
 * named a thread; `tools` is reduced to its count.
 */
export interface CodexMcpServerStatus {
  name: string;
  runtimeStatus: string | null;
  authStatus: string | null;
  pluginId: string | null;
  httpOrigin: string | null;
  toolCount: number;
  toolsError: string | null;
}

/**
 * Which config layer DEFINES an MCP server, read off `config/read`'s
 * `origins`: `user` is codex's own `config.toml` (the file `config/value/write`
 * writes), `project` a folder's `.codex/config.toml`, anything else a layer
 * this app never writes (system, managed, session flags).
 */
export type CodexMcpLayer = 'user' | 'project' | 'other';

/** What codex's config says about one server. */
export interface CodexMcpConfigEntry {
  layer: CodexMcpLayer;
  /** The server's own `enabled` field; null when the config does not say. */
  enabled: boolean | null;
}

/**
 * What one codex thread has reported about itself, kept so the context
 * readout can answer between turns without a request of its own: the newest
 * token reading, the instruction files the thread loaded, the model, and the
 * auto-compaction threshold its process was started with.
 */
export interface CodexThreadFacts {
  usage: CodexTokenUsage | null;
  instructionSources: string[];
  model: string | null;
  autoCompactTokens: number | null;
}

/** A codex `ThreadItem`: its discriminant, its id, and the raw record. */
export interface CodexItem {
  type: string;
  id: string;
  record: Readonly<Record<string, unknown>>;
}

/** `AskForApproval`, the subset this adapter ever sends. */
export type CodexApprovalPolicy = 'never' | 'untrusted';

/** `SandboxMode` — the string form `thread/start` takes. */
export type CodexSandboxMode =
  'read-only' | 'workspace-write' | 'danger-full-access';

/** `SandboxPolicy` — the object form `turn/start` takes. */
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

/** Everything one approval mode decides about a codex turn. */
export interface CodexTurnPolicy {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  sandboxPolicy: CodexSandboxPolicy;
  /** Run the turn in codex's plan collaboration mode. */
  plan: boolean;
  /** Answer a file-change approval request with `accept`, unasked. */
  autoAcceptFileChanges: boolean;
}

/** One `RateLimitWindow` of an `account/rateLimits` snapshot. */
export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
