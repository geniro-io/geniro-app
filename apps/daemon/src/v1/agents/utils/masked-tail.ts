import { redactSecrets } from '../../diagnostics/utils/redact';

/**
 * Output read past the tail that is kept, so a registered secret the cut
 * would split is still whole when it is masked.
 */
export const SECRET_MARGIN = 4096;

/**
 * The end of what a command printed, masked before it is cut — it is shown
 * to the user and may be handed to an agent's model. Read `max` +
 * {@link SECRET_MARGIN} characters of output to call it.
 */
export function maskedTail(output: string, max: number): string {
  const masked = redactSecrets(output);
  // Masks are shorter than what they hide: past the cap, the margin's start
  // (possibly a secret the window cut through) must never move into the tail.
  return (
    output.length >= max + SECRET_MARGIN ? masked.slice(SECRET_MARGIN) : masked
  ).slice(-max);
}
