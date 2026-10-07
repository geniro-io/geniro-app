import type { CliKind } from '../../shared/contracts';

/**
 * Everything the Electron MAIN process knows about ONE agent CLI — the facts
 * its own probes need before any daemon exists (`detectClis` runs during
 * onboarding, with no `DaemonHandle`). The daemon's twin is that CLI's
 * `AdapterConfig`; the two apps share no code, so a fact a probe here needs
 * lives in that CLI's descriptor file and nowhere else in main. Nothing in
 * `cli-detect.ts`, `cli-update.ts` or `probe-env.ts` names a CLI.
 */
export interface CliAgentDescriptor {
  readonly kind: CliKind;
  /**
   * Env names this CLI OWNS — its credentials and the inherited settings that
   * identify its session. Withheld from every OTHER CLI's probe child and kept
   * for its own (`probe-env.ts`).
   *
   * TWIN PARSER: the daemon's `AdapterConfig.auth.isolatedEnvKeys` for the same
   * CLI. A credential added on either side belongs on the other.
   */
  readonly ownEnvKeys: readonly string[];
  /**
   * How to ask this CLI whether it is signed in, or null when it cannot be
   * asked — its card then reports `loggedIn: null` (unknown), never "signed
   * out", which would send a signed-in user to a control that fixes nothing.
   */
  readonly loginProbe: LoginProbe | null;
  /**
   * How to learn the newest version WITHOUT installing it — or, measured, why
   * this CLI cannot be asked, said on its card rather than left as a blank a
   * reader would take for "you are up to date".
   */
  readonly latestProbe:
    LatestProbe | RecordedLatestProbe | { readonly unavailableReason: string };
  /** The argv that runs this CLI's own updater. */
  readonly updateArgs: readonly string[];
  /**
   * True for the one CLI that could run under a config directory before
   * config directories were remembered PER CLI. A settings file written then
   * holds a single `configDir`, a flat `recentConfigDirs` and profiles naming
   * no agent, and `settings.ts` files all three under this CLI on read — no
   * other CLI could have been pointed at them.
   */
  readonly ownsUnscopedConfigDirs?: true;
}

/** One login-state question put to a CLI binary. */
export interface LoginProbe {
  readonly args: readonly string[];
  /**
   * The answer read out of the reply: true/false when the CLI said, null when
   * it did not. `exitCode` is passed because some CLIs answer "signed out" by
   * exiting non-zero, and `stderr` because some write their status there; a
   * reader that cannot tell must answer null.
   */
  readonly read: (reply: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }) => boolean | null;
  /**
   * The env var that points this CLI at a config directory, when that
   * directory also carries the ACCOUNT — so one probe per named configuration
   * answers whether THAT account is signed in.
   *
   * claude's and codex's: their credentials live inside the directory
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` — measured on 2.1.280 and 0.157.1, an
   * empty directory answers signed out and a signed-in profile signed in).
   * cursor keeps its account outside the directory it reads (see the daemon's
   * `configDir.unavailableReason`), so asking it per directory would report the
   * default account N times.
   */
  readonly configDirEnv?: string;
}

/** One "is there a newer version" question put to a CLI binary. */
export interface LatestProbe {
  readonly args: readonly string[];
  /**
   * `available` true/false only when the CLI vouched for the answer, null
   * otherwise — never derived by comparing two version strings, whose ordering
   * is the vendor's.
   */
  readonly read: (stdout: string) => {
    available: boolean | null;
    latestVersion: string | null;
  };
}

/**
 * A CLI with no check-only command that nonetheless RECORDS its own last check
 * in a file under its config home — so the answer is read off disk, and geniro
 * asks no server anything (the CLI did, on its own schedule).
 *
 * Every config home the user runs the CLI under is consulted and the freshest
 * record wins: the binary is one, so any profile's check is about it.
 */
export interface RecordedLatestProbe {
  /** The record's path for one config home; null is the CLI's own default. */
  readonly recordPath: (
    configHome: string | null,
    env: NodeJS.ProcessEnv,
    userHome: string,
  ) => string;
  /**
   * One record read against the installed `--version` line, or null when the
   * record is not one. `available` is null when the CLI's OWN comparison could
   * not order the two — the one case where comparing version strings is
   * allowed is mirroring the rule the vendor's own code applies to them.
   */
  readonly read: (
    record: string,
    installedVersion: string,
  ) => {
    available: boolean | null;
    latestVersion: string;
    checkedAt: number;
  } | null;
  /**
   * How long a record saying "nothing newer" is believed — the CLI's own
   * re-check interval. A "newer exists" answer needs no such bound: it is
   * read against the INSTALLED version, so updating is what retires it.
   */
  readonly freshForMs: number;
  /** Said on the card when no record answers — none, or a stale one. */
  readonly unansweredReason: string;
}

/** A CLI's JSON reply as an object, or null when it is not one. */
export function parseJsonObject(
  stdout: string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A login reader over ONE flat boolean field of the CLI's STRUCTURED reply —
 * never its prose, which grows states (cursor's `partially-authenticated`)
 * that match neither wording. A FLAT key, deliberately: a path spelled
 * `'auth.isAuthenticated'` would read `undefined` → null → a card that says
 * ready while signed out.
 *
 * The exit code is deliberately NOT consulted: claude 2.1.280 exits 1 for a
 * signed-out profile with the same well-formed `{"loggedIn": false, …}` body it
 * exits 0 with when signed in, so a reader that treated a non-zero exit as a
 * failed question would turn every signed-out account into UNKNOWN. A reply
 * carrying no such boolean — a crash, a timeout's empty output — is still null.
 */
export function jsonBooleanField(field: string): LoginProbe['read'] {
  return ({ stdout }) => {
    const value = parseJsonObject(stdout)?.[field];
    return typeof value === 'boolean' ? value : null;
  };
}
