import { z } from 'zod';

import { AgentKindSchema } from '../runs/runs.types';

/**
 * How long a daemon-run sign-in may stay open before the group is reaped.
 *
 * Generous on purpose: the whole point is that the user leaves for a browser,
 * signs in, and comes back. Five minutes is long enough for a password manager
 * and a 2FA prompt, and short enough that a forgotten flow does not hold a
 * detached child until the app quits.
 */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * Where a sign-in the daemon is running has got to.
 *
 * - `waiting` — the CLI is up and the browser round-trip has not finished.
 * - `needs_code` — the CLI has reached the point where a pasted code would be
 *   accepted (`AdapterConfig.auth.loginCodePromptMarkers`). Only claude reaches
 *   this; cursor polls to completion.
 * - `succeeded` / `failed` — the CLI exited. NEITHER asserts the user is signed
 *   in: only the CLI's own status probe can say that, and the renderer re-asks
 *   it. `succeeded` means "the command completed cleanly", which is a different
 *   claim and the only one an exit code supports.
 * - `cancelled` — the caller gave up, or the deadline reaped the group.
 */
export const LoginStatusSchema = z.enum([
  'waiting',
  'needs_code',
  'succeeded',
  'failed',
  'cancelled',
]);
export type LoginStatus = z.infer<typeof LoginStatusSchema>;

/**
 * One in-flight (or just-finished) sign-in.
 *
 * `url` is the sign-in link the CLI printed. Both CLIs open the browser
 * themselves, so this is a FALLBACK rather than the mechanism — for the run
 * where the browser did not open, or opened in the wrong profile. It is
 * surfaced, never auto-opened a second time: two browser tabs for one flow, one
 * of them with a stale challenge, is worse than none.
 *
 * Deliberately carries NO `.meta({ id })`, and neither does {@link
 * LogoutResultSchema}: both are the ROOT of a response DTO
 * (`LoginSessionDto` / `LogoutResultDto`), and nestjs-zod then names the DTO's
 * own component after the zod id AND registers the id's component under that
 * same name — two different bodies under one name. nestjs-zod 5.5 throws on
 * that (`[cleanupOpenApiDoc] Found multiple schemas with name
 * \`LogoutResult_Output\``) and the daemon never finishes booting, which is
 * how a shipped release lost its whole API. An id belongs on the nested and
 * shared schemas only — `AgentKindSchema` below still has one.
 */
export const LoginSessionSchema = z.object({
  id: z.string(),
  agent: AgentKindSchema,
  status: LoginStatusSchema,
  /** The sign-in URL the CLI printed, or null before it has printed one. */
  url: z.string().nullable(),
  /**
   * What to show the user about this attempt — the CLI's own last meaningful
   * line, or the reason it failed. Never the raw output: a sign-in's stdout is
   * the one place a code or a token could appear.
   */
  message: z.string().nullable(),
});
export type LoginSession = z.infer<typeof LoginSessionSchema>;

/** The answer to a sign-out, which is over as soon as the CLI exits. */
export const LogoutResultSchema = z.object({
  agent: AgentKindSchema,
  ok: z.boolean(),
  /** Why it could not be done here, or null on success. */
  unavailableReason: z.string().nullable(),
});
export type LogoutResult = z.infer<typeof LogoutResultSchema>;
