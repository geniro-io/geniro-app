/**
 * Contracts shared INSIDE the Electron UI app (main ⇄ preload ⇄ renderer).
 *
 * These never cross to the daemon: the UI reaches the daemon only by reading
 * its pidfile (see `main/daemon-pidfile.ts`) and over loopback HTTP/WS. Daemon
 * wire shapes (M2) come from the daemon's generated OpenAPI client, not here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Daemon connection (read from the pidfile by main, passed to the renderer)
// ─────────────────────────────────────────────────────────────────────────────

/** Connection coordinates the renderer needs to open an authed WS/HTTP call. */
export interface DaemonHandle {
  /** Loopback host the daemon reported binding to (from the pidfile). */
  host: string;
  /** Loopback port the daemon reported binding to. */
  port: number;
  /** Per-launch bearer token; required on every daemon request. */
  token: string;
  /** Daemon version (semver). */
  version: string;
}

/** Live status the renderer polls/subscribes to for the connection banner. */
export interface DaemonStatus {
  connected: boolean;
  handle: DaemonHandle | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat (daemon wire shapes — hand-mirrored from the daemon's chat.types until
// an OpenAPI client is generated; keep in sync with apps/daemon v1/agents)
// ─────────────────────────────────────────────────────────────────────────────

/** Run lifecycle status (mirrors the daemon `RunStatus`). */
export type ChatRunStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Normalized transcript item kind (mirrors the daemon's 11-kind `ItemKind`). */
export type ChatItemKind =
  | 'message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'turn_complete'
  | 'turn_cancelled'
  | 'usage'
  | 'system'
  | 'error'
  | 'attachment'
  | 'status'
  | 'approval_request'
  | 'approval_verdict';

/** A run — a single-agent chat or a workflow (graph) execution. */
export interface ChatRun {
  id: string;
  status: ChatRunStatus;
  title: string | null;
  agentKind: CliKind | null;
  /** Workflow slug for a graph run; null for a single-agent chat. */
  workflowId: string | null;
  cwd: string | null;
  model: string | null;
  createdAt: string;
}

/** A persisted transcript item streamed over `/ws` and read back over REST. */
export interface ChatItem {
  id: string;
  runId: string;
  nodeId: string | null;
  seq: number;
  kind: ChatItemKind;
  role: string | null;
  payload: unknown;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflows (mirrors the daemon's v1/graphs wire shapes)
// ─────────────────────────────────────────────────────────────────────────────

/** Tool-approval mode of one workflow node. */
export type WorkflowApproval = 'auto' | 'ask';

/** One agent node of a workflow DAG. */
export interface WorkflowNode {
  id: string;
  name?: string;
  agent: CliKind;
  model?: string;
  role?: string;
  approval: WorkflowApproval;
}

/** Directed edge: `from`'s final text feeds `to`'s prompt context. */
export interface WorkflowEdge {
  from: string;
  to: string;
  label?: string;
}

/** Canvas position per node id. */
export type WorkflowLayout = Record<string, { x: number; y: number }>;

/** A complete workflow definition (the `*.geniro.yaml` shape). */
export interface Workflow {
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout?: WorkflowLayout;
}

/** A workflow as listed from the library. */
export interface WorkflowSummary {
  slug: string;
  name: string;
  description: string | null;
  nodeCount: number;
  updatedAt: string;
}

/** One workflow definition addressed by its library slug. */
export interface WorkflowWire {
  slug: string;
  workflow: Workflow;
}

/** Node lifecycle status within a run (mirrors the daemon `NodeStatus`). */
export type NodeRunStatus = ChatRunStatus | 'skipped';

/** Per-node execution state of one workflow run. */
export interface NodeStateWire {
  runId: string;
  nodeId: string;
  status: NodeRunStatus;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
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
export const KEYCHAIN_SERVICE = 'io.geniro.app';

/** Logical secret identifiers (Keychain "account" within the service). */
export type SecretName = 'cursor.apiKey';

// ─────────────────────────────────────────────────────────────────────────────
// IPC contract (window.geniro — exposed by the preload via contextBridge)
// ─────────────────────────────────────────────────────────────────────────────

/** Input captured by the onboarding flow and committed in one IPC call. */
export interface OnboardingInput {
  /** Per-agent binary path overrides (absolute paths); omitted keys auto-detect. */
  cliPaths?: Partial<Record<CliKind, string>>;
  /** Optional Cursor API key; stored in the Keychain, never echoed back. */
  cursorApiKey?: string;
}

/**
 * The typed API surface the preload exposes on `window.geniro`. The renderer
 * never touches Node or Electron directly — every privileged action is one of
 * these channels.
 */
export interface GeniroApi {
  /** Current onboarding + daemon status. */
  getStatus(): Promise<{ onboardingComplete: boolean; daemon: DaemonStatus }>;
  /** Daemon connection handle (host + port + token) for opening an authed WS. */
  getDaemonHandle(): Promise<DaemonHandle | null>;
  /** Open the native folder picker; returns the chosen absolute path or null. */
  pickProjectFolder(): Promise<string | null>;
  /** Open the native file picker for an agent binary; returns the path or null. */
  pickAgentBinary(): Promise<string | null>;
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
  /** Open a native picker for a workflow YAML to import; path or null. */
  pickWorkflowImport(): Promise<string | null>;
  /** Open a native save dialog for a workflow export; target path or null. */
  pickWorkflowExport(defaultName: string): Promise<string | null>;
}

/** IPC channel names — single source of truth for main ⇄ preload wiring. */
export const IPC = {
  getStatus: 'geniro:getStatus',
  getDaemonHandle: 'geniro:getDaemonHandle',
  pickProjectFolder: 'geniro:pickProjectFolder',
  pickAgentBinary: 'geniro:pickAgentBinary',
  getSettings: 'geniro:getSettings',
  updateSettings: 'geniro:updateSettings',
  detectClis: 'geniro:detectClis',
  saveSecret: 'geniro:saveSecret',
  hasSecret: 'geniro:hasSecret',
  deleteSecret: 'geniro:deleteSecret',
  completeOnboarding: 'geniro:completeOnboarding',
  pickWorkflowImport: 'geniro:pickWorkflowImport',
  pickWorkflowExport: 'geniro:pickWorkflowExport',
} as const satisfies Record<keyof GeniroApi, string>;
