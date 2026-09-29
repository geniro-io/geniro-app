import { longestSecretLength, redactSecrets } from './redact';

/** Longest a transcript payload preview runs before the sink truncates it. */
export const PAYLOAD_PREVIEW = 400;

/** How much of a payload is masked before it is cut: eight previews' worth. */
export const PAYLOAD_WINDOW = PAYLOAD_PREVIEW * 8;

/**
 * A short, single-line rendering of an item payload.
 *
 * Masked BEFORE the whitespace is collapsed and the text cut: a secret that
 * straddles the cut, or holds whitespace of its own, would otherwise reach the
 * sink in a form the registry no longer matches.
 *
 * Masking scans its input once per registered secret and only the start of the
 * payload survives, so a payload past the window is masked over the window
 * alone. A secret that window cuts is left half-scanned at its end, showing its
 * first characters raw. Nothing here works out how many masked characters those
 * are, since masking can make text longer as well as shorter: the window is
 * masked a second time, one longest secret further, which completes every
 * secret the first cut left half-scanned. The preview is taken from the short
 * window only when the two agree on the whole of it; any disagreement, or a
 * window that collapses to no more than a preview, masks the whole payload
 * instead. So the result is what masking all of it would have shown — short of
 * a registered value that itself contains another value's mask text, which
 * nothing registers.
 */
export function payloadPreview(
  payload: unknown,
  redact: (text: string) => string = redactSecrets,
  longestSecret: number = longestSecretLength(),
): string {
  if (payload === null || payload === undefined) {
    return '';
  }
  const text = serialize(payload);
  if (text.length > PAYLOAD_WINDOW + longestSecret) {
    const head = flatten(redact(text.slice(0, PAYLOAD_WINDOW)));
    const longer = flatten(
      redact(text.slice(0, PAYLOAD_WINDOW + longestSecret)),
    );
    if (
      head.length > PAYLOAD_PREVIEW &&
      head.slice(0, PAYLOAD_PREVIEW) === longer.slice(0, PAYLOAD_PREVIEW)
    ) {
      return `${head.slice(0, PAYLOAD_PREVIEW)}…`;
    }
  }
  const flat = flatten(redact(text));
  return flat.length > PAYLOAD_PREVIEW
    ? `${flat.slice(0, PAYLOAD_PREVIEW)}…`
    : flat;
}

function serialize(payload: unknown): string {
  try {
    return typeof payload === 'string'
      ? payload
      : (JSON.stringify(payload) ?? String(payload));
  } catch {
    return String(payload);
  }
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}
