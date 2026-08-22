import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  CLI_KINDS,
  type CliKind,
  hasControlCharacters,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_RUN_CONFIG_NAME,
  MAX_RUN_CONFIGS,
} from '../shared/contracts';

/**
 * Runtime validation for IPC payloads. The renderer is the only caller today,
 * but IPC input is untrusted by default (a compromised renderer, a future
 * frame), and some of it reaches privileged sinks — `cliPaths[kind]` becomes an
 * `execFile` target in cli-detect.ts, `projectFolder` is persisted. These
 * schemas are validated in the main process before any use.
 *
 * Kept main-side (not in shared/contracts.ts) on purpose: contracts.ts is
 * imported by the preload, which must stay dependency-free so its sandboxed
 * bundle pulls in nothing but `electron`.
 */

/**
 * A non-empty, absolute filesystem path. Bounded HERE rather than per-field, so
 * no persisted path can slip through unbounded; 1024 is generous against any
 * real `PATH_MAX`.
 */
const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => isAbsolute(p), 'must be an absolute path');

const cliKind = z.enum(CLI_KINDS as unknown as [CliKind, ...CliKind[]]);

/**
 * A git branch name. `git switch` takes this as an argv entry (no shell), so
 * the real risk is not injection but ARGUMENT injection: a name beginning with
 * `-` would be parsed as a flag. Git's own ref format forbids most of what is
 * rejected here anyway — this is the boundary that makes it true regardless of
 * what the renderer sends.
 *
 * Declared ABOVE `settingsPatchSchema`, which embeds it: `z.strictObject`
 * evaluates its shape immediately, so a reference to a `const` declared further
 * down is a temporal-dead-zone error at module load, not a type error.
 */
export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((b) => !b.startsWith('-'), 'must not start with a dash')
  // The characters git itself forbids in a refname. A dash is NOT among them —
  // `feat/some-branch` is the common case; only a LEADING dash is the hazard.
  // eslint-disable-next-line no-control-regex -- control characters are precisely what a refname may not contain
  .refine((b) => !/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(b), 'invalid refname')
  .refine((b) => !b.includes('..') && !b.includes('@{'), 'invalid refname');

/** The composer target: a CLI kind, or `wf:<slug>` for a library workflow. */
const chatTarget = z.union([
  cliKind,
  z
    .string()
    .max(128)
    .regex(/^wf:.+/),
]);

/**
 * One saved new-chat setup (`RunConfig` in shared/contracts.ts).
 *
 * Every field is bounded rather than merely typed: these are persisted, and two
 * reach privileged sinks — `cwd` is handed to the daemon and to `git`, and
 * `branch` becomes an argv entry of `git switch`, so it reuses that channel's
 * own refname schema rather than a looser copy. The daemon-vocabulary fields
 * stay OPAQUE, like their single-value counterparts above.
 */
const runConfigSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(MAX_RUN_CONFIG_NAME),
  cwd: absolutePath,
  branch: branchNameSchema.nullable(),
  target: chatTarget,
  model: z.string().min(1).max(64).nullable(),
  effort: z.string().min(1).max(64).nullable(),
  // `.default(null)` and not a bare `.nullable()`, unlike its neighbours: this
  // field arrived after users already had saved configurations on disk, and
  // `runConfigSchema` is strict — required, every entry written before it
  // would fail to parse and `salvageRunConfigs` would drop the lot. A
  // configuration is hand-made and unrecoverable, which is the whole reason
  // that salvage is entry-by-entry. The default reads an older file as "no
  // size chosen", which is what those entries mean.
  contextWindow: z.string().min(1).max(64).nullable().default(null),
  approval: z.string().min(1).max(32).nullable(),
  configDir: absolutePath.nullable(),
});

/**
 * A `Partial<Settings>` patch. `strictObject` rejects unknown keys, so the
 * renderer can't write arbitrary fields into settings.json.
 */
export const settingsPatchSchema = z.strictObject({
  onboardingComplete: z.boolean().optional(),
  projectFolder: absolutePath.nullable().optional(),
  recentFolders: z.array(absolutePath).max(10).optional(),
  // Nullable, not merely optional: `null` is how the composer says "no plugin
  // directory", which is a real choice and must be writable back.
  configDir: absolutePath.nullable().optional(),
  recentConfigDirs: z.array(absolutePath).max(10).optional(),
  // The user's saved new-chat setups. Hand-managed rather than auto-evicted, so
  // the cap is a guard against a renderer bug growing settings.json without
  // limit, set well above any plausible number of real configurations.
  runConfigs: z.array(runConfigSchema).max(MAX_RUN_CONFIGS).optional(),
  lastChatTarget: chatTarget.nullable().optional(),
  // The daemon's ChatApprovalMode, kept OPAQUE here: its vocabulary belongs to
  // the daemon, and the main process holds no daemon shapes. Bounded so a
  // renderer bug can't grow settings.json without limit; the renderer checks
  // the value against the generated enum before it reaches a run.
  lastApprovalMode: z.string().min(1).max(32).nullable().optional(),
  // Model aliases are the CLIs' vocabulary, not ours — bounded, not enumerated,
  // so a CLI adding an alias needs no change here.
  lastModels: z.partialRecord(cliKind, z.string().min(1).max(64)).optional(),
  // Effort levels are likewise the CLIs' own vocabulary (claude accepts one
  // its --help does not even list), so they are bounded, never enumerated.
  lastEfforts: z.partialRecord(cliKind, z.string().min(1).max(64)).optional(),
  // Window sizes are the CLIs' own words too (`300k`, `1m`, `272k`), and
  // per MODEL rather than per CLI — bounded here, never enumerated.
  lastContextWindows: z
    .partialRecord(cliKind, z.string().min(1).max(64))
    .optional(),
  // partialRecord, not record: in zod v4 z.record over an enum key is
  // exhaustive (would require every CliKind present); cliPaths is sparse.
  cliPaths: z.partialRecord(cliKind, absolutePath).optional(),
  checkForUpdates: z.boolean().optional(),
  sidebarCollapsed: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  claudeBrowserTools: z.boolean().optional(),
  // The user's own prose — bounded in SIZE because the value ends up in a
  // spawned CLI's argv (and, on ACP, is re-sent every turn), and screened for
  // CONTROL CHARACTERS for the same reason: node rejects a NUL in argv
  // synchronously, and the daemon refuses the whole range at its own edge.
  //
  // Both checks are mirrored here rather than left to the daemon because this
  // is the WRITE the user makes. A value stored here and refused there turns
  // one invisible pasted character (Word and Notes emit U+000B for a soft line
  // break) into a 400 on every new chat and workflow run, surfacing in the
  // composer with nothing pointing back at the settings box holding it.
  customInstructions: z
    .string()
    .max(MAX_CUSTOM_INSTRUCTIONS_CHARS)
    .refine(
      (value) => !hasControlCharacters(value),
      'must not contain control characters',
    )
    .optional(),
  // Nullable, not just optional: `null` is the "unchosen, resolve per build"
  // state, and it must be writable so a user can hand the choice back.
  daemonInspect: z.boolean().nullable().optional(),
});

/** A directory a git command may run in. */
export const gitDirSchema = absolutePath;

/**
 * A file the renderer asks to be revealed in Finder.
 *
 * Shape only — an absolute path. Being inside the daemon's log directory is
 * the SECURITY check and lives in `revealPath`, where the boundary it is
 * compared against is resolved: a schema cannot know where that directory is,
 * and one that pretended to would give a false sense of where the gate is.
 */
export const revealPathSchema = absolutePath;

/**
 * One system notification the renderer asks main to post.
 *
 * Bounded rather than merely typed, because both strings land in an OS surface
 * this process does not draw and cannot clip: a title is a thread's own name
 * (which the user typed) and a body is composed from it. The lengths are what
 * macOS will show anyway — a longer one is truncated by the notification
 * centre, so nothing is lost by refusing it here, and a renderer that has been
 * tampered with cannot hand the window server a megabyte.
 */
export const notificationSchema = z.strictObject({
  kind: z.enum(['question', 'turn-end']),
  runId: z.string().min(1).max(128),
  title: z.string().min(1).max(120),
  body: z.string().max(240),
});

/** Onboarding payload committed in a single IPC call. */
export const onboardingInputSchema = z.strictObject({
  // Per-agent binary overrides; each becomes an `execFile` target in
  // cli-detect.ts, so it must be a validated absolute path.
  cliPaths: z.partialRecord(cliKind, absolutePath).optional(),
});

/**
 * The handoff invocation, as DATA — a command, its arguments and a folder,
 * never a shell string. The main process writes them into a script it quotes
 * itself, so a renderer that has been tampered with cannot append a second
 * command to a line.
 */
export const openTerminalSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: absolutePath,
  /**
   * Env for that one invocation (the run's config directory). Validated in
   * SHAPE only — the daemon composed it and owns which vars mean what — but
   * bounded, since these become assignments in a script this process writes.
   *
   * The NAME is held to a shell identifier, not merely to a length. It is the
   * one field on this channel that reaches the generated script UNQUOTED (twice:
   * `NAME=value` and `export NAME`), because quoting an assignment's left side
   * would make the shell hunt for a command called `NAME=value`. A length bound
   * alone admitted a newline, so `A=1\nrm -rf …` was a well-formed name — and
   * the point of this schema is a renderer that has been tampered with.
   */
  env: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      z.string().max(4096),
    )
    .optional(),
});
