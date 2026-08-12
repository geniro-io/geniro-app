/**
 * Secret removal for anything on its way to the debug log.
 *
 * This is not optional hygiene, it is what makes the feature shippable. The
 * debug log writes to a FILE the user can open, copy and paste into a bug
 * report, and two of its sources carry credentials as a matter of course: the
 * daemon hands claude a per-turn `--mcp-config` holding a call token, and the
 * renderer sends the per-launch bearer token on every request. Neither is a
 * user secret in the Keychain sense, but both grant full control of this
 * machine's daemon for as long as it is running — so neither may leave the
 * process in plain text.
 *
 * Registration, not pattern-matching, is the mechanism. A regex for
 * "something that looks like a token" both misses real ones and mangles
 * innocent hex (a git sha, a run id), whereas the daemon KNOWS its own secrets
 * exactly — it minted them. Values are registered at boot and replaced by
 * fixed labels, so a reader can still see that a token was present and tell
 * two different ones apart without learning either.
 *
 * REGISTER AT THE MINT SITE, not at boot, for anything minted later. The two
 * launch-time credentials are registered in `main.ts`; a call token is minted
 * per caller node while a run starts, long after boot, so `CallTokenRegistry`
 * registers each one as it issues it. That is not a stylistic choice — this
 * block claimed coverage of the call token for a full release while nothing
 * registered it, and the gap was invisible precisely because the claim read as
 * a guarantee. A new credential added later must register itself at the one
 * place it comes into existence.
 */

/** What a redacted value is replaced with, by the label it was registered as. */
const MASK = (label: string): string => `‹${label} redacted›`;

/**
 * Below this length a registered value is IGNORED rather than redacted.
 *
 * A short secret would match everywhere — redacting the three-character string
 * "abc" out of every log line destroys the log to protect nothing. Every real
 * credential here is far longer (the launch token is 64 hex chars), so this
 * only ever excludes a value that was never worth registering.
 */
const MIN_SECRET_LENGTH = 12;

/** Registered secrets, longest first — see {@link redactSecrets}. */
const secrets: { value: string; label: string }[] = [];

/**
 * Register one value to be scrubbed from every future entry.
 *
 * Idempotent per (value, label): boot paths run more than once in tests, and a
 * duplicate registration would only cost a redundant pass.
 */
export function registerSecret(
  value: string | null | undefined,
  label: string,
): void {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length < MIN_SECRET_LENGTH) {
    return;
  }
  if (secrets.some((s) => s.value === trimmed && s.label === label)) {
    return;
  }
  secrets.push({ value: trimmed, label });
  // Longest first, so a secret that CONTAINS another (a token and a URL
  // carrying it) is masked as the more specific one rather than being left
  // half-scrubbed and half-labelled.
  secrets.sort((a, b) => b.value.length - a.value.length);
}

/** Drop every registered secret — test hygiene, never called in production. */
export function clearSecrets(): void {
  secrets.length = 0;
}

/** How many secrets are currently registered (for the diagnostics report). */
export function registeredSecretCount(): number {
  return secrets.length;
}

/**
 * Replace every registered secret in `text` with its label.
 *
 * Plain `split`/`join` rather than a RegExp: the values are arbitrary strings,
 * so a regex would need escaping, and a mis-escaped one silently stops
 * matching — which is the failure mode where the secret ships.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { value, label } of secrets) {
    if (out.includes(value)) {
      out = out.split(value).join(MASK(label));
    }
  }
  return out;
}
