import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { CLI_KINDS, type CliKind } from '../shared/contracts';

/**
 * Runtime validation for IPC payloads. The renderer is the only caller today,
 * but IPC input is untrusted by default (a compromised renderer, a future
 * frame), and some of it reaches privileged sinks — `cliPaths[kind]` becomes an
 * `execFile` target in cli-detect.ts, `projectFolder` is persisted, secrets hit
 * the Keychain. These schemas are validated in the main process before any use.
 *
 * Kept main-side (not in shared/contracts.ts) on purpose: contracts.ts is
 * imported by the preload, which must stay dependency-free so its sandboxed
 * bundle pulls in nothing but `electron`.
 */

/** A non-empty, absolute filesystem path. */
const absolutePath = z
  .string()
  .min(1)
  .refine((p) => isAbsolute(p), 'must be an absolute path');

const cliKind = z.enum(CLI_KINDS as unknown as [CliKind, ...CliKind[]]);

/**
 * A `Partial<Settings>` patch. `strictObject` rejects unknown keys, so the
 * renderer can't write arbitrary fields into settings.json.
 */
export const settingsPatchSchema = z.strictObject({
  onboardingComplete: z.boolean().optional(),
  projectFolder: absolutePath.nullable().optional(),
  recentFolders: z.array(absolutePath).max(10).optional(),
  // A CLI kind or a `wf:<slug>` workflow reference (the composer target).
  lastChatTarget: z
    .union([cliKind, z.string().regex(/^wf:.+/)])
    .nullable()
    .optional(),
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
  // partialRecord, not record: in zod v4 z.record over an enum key is
  // exhaustive (would require every CliKind present); cliPaths is sparse.
  cliPaths: z.partialRecord(cliKind, absolutePath).optional(),
  checkForUpdates: z.boolean().optional(),
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
 * A git branch name. `git switch` takes this as an argv entry (no shell), so
 * the real risk is not injection but ARGUMENT injection: a name beginning with
 * `-` would be parsed as a flag. Git's own ref format forbids most of what is
 * rejected here anyway — this is the boundary that makes it true regardless of
 * what the renderer sends.
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

/** The only valid Keychain secret identifier. */
export const secretNameSchema = z.enum(['cursor.apiKey']);

/** A non-empty secret value. */
export const secretValueSchema = z.string().min(1);

/** Onboarding payload committed in a single IPC call. */
export const onboardingInputSchema = z.strictObject({
  // Per-agent binary overrides; each becomes an `execFile` target in
  // cli-detect.ts, so it must be a validated absolute path.
  cliPaths: z.partialRecord(cliKind, absolutePath).optional(),
  cursorApiKey: z.string().min(1).optional(),
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
});
