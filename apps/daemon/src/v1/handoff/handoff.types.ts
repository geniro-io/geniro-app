import { z } from 'zod';

/**
 * How the user takes THIS conversation over — the wire half of
 * `AgentAdapter.handoffTarget`.
 *
 * There is no live mirror any more. A mirror was a SECOND process rendering the
 * same transcript, and keeping it in step meant re-spawning the CLI on a
 * cadence: probe-measured, an already-open TUI grows by 0 bytes while another
 * process writes the session, and even two interactive CLIs on one session do
 * not see each other. What the user actually wanted from it — "let me carry on
 * in the CLI from here" — needs no syncing at all, because the CLI is started
 * at the moment they ask and renders the conversation as it stands then.
 *
 * FLAT, with a `kind` discriminator rather than a zod union: the renderer reads
 * this through the generated client, and one object with nullable fields keeps
 * the generated type readable. `kind: 'command'` fills `command`/`args`/`cwd`;
 * `kind: 'unavailable'` fills `unavailableReason` and nothing else. A future
 * delivery (a deeplink, a hosted session URL) is a new `kind` plus its own
 * field — not a new endpoint.
 */
export const HandoffTargetSchema = z.object({
  kind: z
    .enum(['command', 'unavailable'])
    .describe('Which delivery applies; anything else is unavailable'),
  command: z.string().nullable().describe('Binary to run, for kind=command'),
  args: z.array(z.string()).describe('Arguments; empty unless kind=command'),
  cwd: z.string().nullable().describe('Folder to run it in, for kind=command'),
  /**
   * The same invocation as ONE shell-ready line, quoted where it has to be.
   * Composed here rather than in the renderer because the quoting rule belongs
   * with the thing being quoted, and because it is what the user copies.
   */
  display: z.string().nullable(),
  unavailableReason: z
    .string()
    .nullable()
    .describe('Why this conversation cannot be opened, for kind=unavailable'),
});
export type HandoffTarget = z.infer<typeof HandoffTargetSchema>;
