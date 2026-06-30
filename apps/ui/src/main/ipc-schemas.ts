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
  defaultModel: z.string().nullable().optional(),
  // partialRecord, not record: in zod v4 z.record over an enum key is
  // exhaustive (would require every CliKind present); cliPaths is sparse.
  cliPaths: z.partialRecord(cliKind, absolutePath).optional(),
  checkForUpdates: z.boolean().optional(),
});

/** The only valid Keychain secret identifier. */
export const secretNameSchema = z.enum(['cursor.apiKey']);

/** A non-empty secret value. */
export const secretValueSchema = z.string().min(1);

/** Onboarding payload committed in a single IPC call. */
export const onboardingInputSchema = z.strictObject({
  projectFolder: absolutePath,
  cursorApiKey: z.string().min(1).optional(),
});
