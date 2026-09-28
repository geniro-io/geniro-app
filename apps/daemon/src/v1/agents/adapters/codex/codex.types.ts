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
