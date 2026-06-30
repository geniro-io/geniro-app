/**
 * Contracts shared INSIDE the Electron shell (main ⇄ preload ⇄ renderer).
 *
 * These never cross to the daemon: the shell reaches the daemon only by reading
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
  projectFolder: string;
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
