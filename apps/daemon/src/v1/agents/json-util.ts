/**
 * Tiny defensive accessors for parsing untrusted/version-volatile JSON from a
 * CLI's stream-json output. Each returns a typed value or a safe fallback
 * instead of throwing — the adapters lean on these so a missing or wrong-typed
 * field degrades gracefully rather than crashing the turn.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Return the first string value among the given keys of a record. Used to read
 * a session id from CLIs that name the field differently across versions
 * (`session_id` vs `chatId` vs `chat_id`).
 */
export function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== null && value.length > 0) {
      return value;
    }
  }
  return null;
}
