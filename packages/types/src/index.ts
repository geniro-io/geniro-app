/**
 * Shared contracts between the geniro daemon (engine) and the Electron shell.
 *
 * This package is intentionally dependency-free and runtime-free: it carries
 * only types and small constants so the daemon and renderer agree on the wire,
 * IPC, and persistence shapes without importing each other.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Daemon handshake (pidfile + loopback auth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * On-disk daemon descriptor (the "pidfile"). Written only AFTER `/health` is
 * green so a reader never connects to a half-booted server. The bearer `token`
 * is a per-launch LOCAL session token (it gates other localhost processes, not
 * the user) — it is not a user secret and is allowed on disk. User credentials
 * live in the macOS Keychain only.
 */
export interface DaemonInfo {
  /** OS process id of the running daemon. */
  pid: number;
  /** Loopback port the daemon bound to (preferred port, else a free fallback). */
  port: number;
  /** Bearer token minted for this launch; required on every HTTP/WS request. */
  token: string;
  /** Daemon package version (semver). */
  version: string;
  /** ISO-8601 timestamp the daemon became healthy. */
  startedAt: string;
}

/** The subset of {@link DaemonInfo} the renderer needs to open an authed WS. */
export type DaemonHandle = Pick<DaemonInfo, 'port' | 'token' | 'version'>;

/** Header carrying the loopback bearer token on every daemon request. */
export const DAEMON_AUTH_HEADER = 'authorization' as const;

/** Host the daemon always binds to — loopback only, never a routable address. */
export const DAEMON_HOST = '127.0.0.1' as const;

/** Preferred loopback port; the daemon falls back to a free port if taken. */
export const DAEMON_PREFERRED_PORT = 47615;

/** Pidfile name under userData — single source so writer and reader agree. */
export const DAEMON_PIDFILE_NAME = 'daemon.json' as const;

/** Highest valid TCP port. */
export const MAX_TCP_PORT = 65535;

/** True when `value` is a bindable TCP port (integer in 1..65535). */
export function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TCP_PORT
  );
}

/**
 * Strictly parse a port from an env-style string. Rejects anything that isn't
 * pure decimal digits in range — so `'4e4'`, `'0x1234'`, `'80.5'`, `'99999999'`,
 * empty/whitespace all return null (caller falls back to a default). Lenient
 * `Number()` coercion would silently accept those.
 */
export function parsePort(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const port = Number(trimmed);
  return isValidPort(port) ? port : null;
}

/**
 * Validate an untrusted (parsed-JSON) value as a {@link DaemonInfo}. Single
 * source of truth for the pidfile shape so the daemon writer and the shell
 * reader cannot drift. Rejects a non-positive/non-integer pid and an
 * unbindable (non-integer / out-of-range) port — a corrupt pidfile must not
 * round-trip as valid.
 */
export function parseDaemonInfo(raw: unknown): DaemonInfo | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const v = raw as Record<string, unknown>;
  if (
    typeof v.pid === 'number' &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    isValidPort(v.port) &&
    typeof v.token === 'string' &&
    v.token.length > 0 &&
    typeof v.version === 'string' &&
    typeof v.startedAt === 'string'
  ) {
    return {
      pid: v.pid,
      port: v.port,
      token: v.token,
      version: v.version,
      startedAt: v.startedAt,
    };
  }
  return null;
}

/** Whether a process id could ever name a real running process. */
export function isPlausiblePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

/** Response body of `GET /health`. */
export interface HealthResponse {
  status: 'ok';
  version: string;
  /** Milliseconds since the daemon process started. */
  uptimeMs: number;
  /** Whether the SQLite store opened and is at the migration head. */
  db: 'ok' | 'error';
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings (non-secret app config — persisted as JSON in userData)
// ─────────────────────────────────────────────────────────────────────────────

/** Persisted, non-secret application settings. Secrets never live here. */
export interface Settings {
  /** First-run onboarding finished (gates the renderer's initial route). */
  onboardingComplete: boolean;
  /** Absolute path to the user's working project folder (agent cwd). */
  projectFolder: string | null;
  /** Default model id applied to new agent nodes. */
  defaultModel: string | null;
  /** Explicit overrides for CLI binary locations (else resolved on PATH). */
  cliPaths: Partial<Record<CliKind, string>>;
  /** Whether to check for app updates on launch (wired in M4). */
  checkForUpdates: boolean;
}

/** Default settings written on first launch when no settings file exists. */
export const DEFAULT_SETTINGS: Settings = {
  onboardingComplete: false,
  projectFolder: null,
  defaultModel: null,
  cliPaths: {},
  checkForUpdates: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI detection
// ─────────────────────────────────────────────────────────────────────────────

/** CLI agents geniro can drive in v1 (all headless). */
export type CliKind = 'claude' | 'cursor-agent';

/** Every CLI kind, in onboarding display order. */
export const CLI_KINDS: readonly CliKind[] = ['claude', 'cursor-agent'];

/** Result of probing the host for a single CLI agent. */
export interface CliDetection {
  kind: CliKind;
  /** True when the binary was located and reported a version. */
  found: boolean;
  /** Absolute path to the resolved binary, when found. */
  path: string | null;
  /** Version string the binary reported, when found. */
  version: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets (macOS Keychain — never written to disk or SQLite)
// ─────────────────────────────────────────────────────────────────────────────

/** Keychain service name under which all geniro secrets are stored. */
export const KEYCHAIN_SERVICE = 'io.geniro.app' as const;

/** Logical secret identifiers (Keychain "account" within the service). */
export type SecretName = 'cursor.apiKey';

// ─────────────────────────────────────────────────────────────────────────────
// Persistence (SQLite runtime/history — canonical row shapes)
// ─────────────────────────────────────────────────────────────────────────────

export type RunStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type NodeStatus = RunStatus | 'skipped';

/**
 * Conversation item kind. M1 stores items as opaque rows; the full normalized
 * taxonomy (mirroring the engine's event model) is refined in M2.
 */
export type ItemKind =
  'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'system' | 'error';

/** A single execution of a workflow (graph) or a single-agent chat. */
export interface RunRow {
  id: string;
  /** Workflow (graph) id this run executed; null for an ad-hoc single agent. */
  workflowId: string | null;
  status: RunStatus;
  title: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/** A persisted conversation/transcript item belonging to a run. */
export interface ItemRow {
  id: string;
  runId: string;
  /** Graph node that produced this item; null for single-agent runs. */
  nodeId: string | null;
  /** Monotonic ordering within the run. */
  seq: number;
  kind: ItemKind;
  role: string | null;
  /** JSON-encoded payload (shape depends on `kind`). */
  payload: string;
  createdAt: number;
}

/** Per-node execution status within a run (one row per graph node). */
export interface NodeStateRow {
  runId: string;
  nodeId: string;
  status: NodeStatus;
  /** Underlying CLI session id, for resume/inspection (populated in M2). */
  agentSessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC contract (window.geniro — exposed by the preload via contextBridge)
// ─────────────────────────────────────────────────────────────────────────────

/** Input captured by the onboarding flow and committed in one IPC call. */
export interface OnboardingInput {
  projectFolder: string;
  /** Optional Cursor API key; stored in the Keychain, never echoed back. */
  cursorApiKey?: string;
}

/** Live status the renderer polls/subscribes to for the connection banner. */
export interface DaemonStatus {
  connected: boolean;
  handle: DaemonHandle | null;
}

/**
 * The typed API surface the preload exposes on `window.geniro`. The renderer
 * never touches Node or Electron directly — every privileged action is one of
 * these channels.
 */
export interface GeniroApi {
  /** Current onboarding + daemon status. */
  getStatus(): Promise<{ onboardingComplete: boolean; daemon: DaemonStatus }>;
  /** Daemon connection handle (port + token) for opening an authed WS. */
  getDaemonHandle(): Promise<DaemonHandle | null>;
  /** Open the native folder picker; returns the chosen absolute path or null. */
  pickProjectFolder(): Promise<string | null>;
  /** Read the persisted settings. */
  getSettings(): Promise<Settings>;
  /** Merge a partial patch into settings; returns the updated settings. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Probe the host for each supported CLI agent. */
  detectClis(): Promise<CliDetection[]>;
  /** Store a secret in the Keychain. */
  saveSecret(name: SecretName, value: string): Promise<void>;
  /** Whether a secret exists in the Keychain (value is never returned). */
  hasSecret(name: SecretName): Promise<boolean>;
  /** Remove a secret from the Keychain. */
  deleteSecret(name: SecretName): Promise<void>;
  /** Persist onboarding input and mark onboarding complete. */
  completeOnboarding(input: OnboardingInput): Promise<Settings>;
}

/** IPC channel names — single source of truth for main ⇄ preload wiring. */
export const IPC = {
  getStatus: 'geniro:getStatus',
  getDaemonHandle: 'geniro:getDaemonHandle',
  pickProjectFolder: 'geniro:pickProjectFolder',
  getSettings: 'geniro:getSettings',
  updateSettings: 'geniro:updateSettings',
  detectClis: 'geniro:detectClis',
  saveSecret: 'geniro:saveSecret',
  hasSecret: 'geniro:hasSecret',
  deleteSecret: 'geniro:deleteSecret',
  completeOnboarding: 'geniro:completeOnboarding',
} as const satisfies Record<keyof GeniroApi, string>;
