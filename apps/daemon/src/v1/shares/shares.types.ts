import { z } from 'zod';

import type { ManagedCommandResult } from '../agents/utils/managed-command';

/**
 * Where an encrypted page is uploaded, as the user configured it in Settings.
 *
 * TWIN PARSER: `shareDestinationSchema` in `apps/ui/src/main/ipc-schemas.ts`
 * (the same limits), the `ShareDestination` type in
 * `apps/ui/src/shared/contracts.ts`, and the salvage in
 * `apps/ui/src/main/settings.ts`. Electron main owns these values in
 * settings.json and pushes them here (`PUT /v1/shares/config`); the daemon
 * never reads settings.json, so a field added on one side must be added on the
 * other.
 *
 * The upload always goes through the user's own CLI and login: geniro holds no
 * credential for any destination.
 */
const destinationBase = {
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  /**
   * The https origin (and optional path) the uploaded objects are served
   * from; the link is `<linkBase>/<object path>#k=<key>`.
   */
  linkBase: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), {
      message: 'linkBase must be an https URL',
    }),
};

/** A bucket or object prefix: no leading/trailing slash, no `..`, no blanks. */
const objectPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine((value) => !value.split('/').includes('..'));

const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/**
 * Characters that mean something only to a shell. The command runs as argv
 * with no shell, so a token holding one would not do what it reads as doing —
 * refused rather than passed through literally.
 */
const SHELL_METACHARACTERS = /[|;&$`<>\\\n\r*?(){}[\]!~#'"]/;

/** Shells, refused as the program: a destination command is argv, never a script. */
const SHELL_PROGRAMS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'env',
]);

/** Placeholders a command token may carry, each a whole-token or in-token substitution. */
const COMMAND_PLACEHOLDERS = ['{file}', '{object}'] as const;

const commandArgvSchema = z
  .array(z.string().min(1).max(500))
  .min(1)
  .max(40)
  .refine(
    (tokens) =>
      tokens.every(
        (token) =>
          !SHELL_METACHARACTERS.test(
            COMMAND_PLACEHOLDERS.reduce(
              (text, placeholder) => text.split(placeholder).join(''),
              token,
            ),
          ),
      ),
    { message: 'a command token may not contain shell characters' },
  )
  .refine((tokens) => !SHELL_PROGRAMS.has(tokens[0]?.split('/').pop() ?? ''), {
    message: 'a destination command may not be a shell',
  });

export const ShareDestinationSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('gcs'),
      ...destinationBase,
      bucket: z.string().regex(BUCKET_NAME_PATTERN),
      prefix: objectPathSchema.optional(),
    }),
    z.object({
      kind: z.literal('s3'),
      ...destinationBase,
      bucket: z.string().regex(BUCKET_NAME_PATTERN),
      prefix: objectPathSchema.optional(),
      profile: z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,64}$/)
        .optional(),
      region: z
        .string()
        .regex(/^[a-z0-9-]{1,32}$/)
        .optional(),
    }),
    z.object({
      kind: z.literal('command'),
      ...destinationBase,
      /**
       * argv for the upload, one token per entry; `{file}` is replaced by the
       * envelope's temp path and `{object}` by the object path. Never a shell.
       */
      upload: commandArgvSchema,
      /** argv for a revoke; `{object}` substitutes as above. */
      remove: commandArgvSchema,
    }),
  ])
  .meta({ id: 'ShareDestination' });
export type ShareDestination = z.infer<typeof ShareDestinationSchema>;

/**
 * TWIN PARSER: the body `apps/ui/src/main/share-config-push.ts` sends, built
 * from `Settings.sharing` (`sharingSchema` in `apps/ui/src/main/ipc-schemas.ts`).
 */
export const ShareConfigSchema = z
  .object({
    destinations: z.array(ShareDestinationSchema).max(20),
    defaultDestinationId: z.string().nullable(),
    agentsMayShare: z.boolean(),
  })
  .meta({ id: 'ShareConfig' });
export type ShareConfig = z.infer<typeof ShareConfigSchema>;

export const ShareActorSchema = z
  .enum(['user', 'agent'])
  .meta({ id: 'ShareActor' });
export type ShareActor = z.infer<typeof ShareActorSchema>;

/**
 * `revoke-failed`: the remote delete did not succeed, so the object (and the
 * link) may still work. The row and the Keychain key are kept so a retry can
 * delete it.
 */
export const ShareStatusSchema = z
  .enum(['live', 'revoke-failed'])
  .meta({ id: 'ShareStatus' });
export type ShareStatus = z.infer<typeof ShareStatusSchema>;

/** One shared page on the wire. Never carries the key or the link. */
export const ShareSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    artifactId: z.string(),
    title: z.string(),
    destinationId: z.string(),
    destinationName: z.string(),
    sharedVersion: z.number().int(),
    sharedBy: ShareActorSchema,
    status: ShareStatusSchema,
    lastError: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Share' });
export type Share = z.infer<typeof ShareSchema>;

/**
 * CSS custom properties (`--geniro-*`) the renderer computed for its current
 * theme, baked into the shared page because a static host has no window to
 * hand them over.
 */
export const ShareThemeVarsSchema = z
  .record(z.string().regex(/^--geniro-[a-z0-9-]{1,60}$/), z.string().max(200))
  .meta({ id: 'ShareThemeVars' });
export type ShareThemeVars = z.infer<typeof ShareThemeVarsSchema>;

/**
 * What an agent's `show_artifact(share: true)` came to: the link, or the
 * reason there is none, which the receipt tells the agent so it never invents
 * a link.
 */
export type AgentShareOutcome =
  { kind: 'shared'; url: string } | { kind: 'not-shared'; reason: string };

export type RevokeOutcome =
  { status: 'revoked' } | { status: 'revoke-failed'; detail: string };

/** One destination CLI invocation, as argv. */
export interface DestinationCommand {
  command: string;
  args: string[];
}

/** The DI token of the {@link ShareCommandRunner}. */
export const SHARE_COMMAND_RUNNER = Symbol('SHARE_COMMAND_RUNNER');

/** Runs one share-side CLI command (a destination's, or `security`) under the daemon's process rules. */
export type ShareCommandRunner = (
  command: DestinationCommand & {
    label: string;
    timeoutMs: number;
    stdin?: string;
  },
) => Promise<ManagedCommandResult>;
