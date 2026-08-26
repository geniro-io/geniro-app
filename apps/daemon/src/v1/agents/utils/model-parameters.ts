/**
 * The run row's `modelParameters` column, read and written in ONE place.
 *
 * The column is TEXT holding a JSON object, following `Item.payload` rather
 * than reaching for a `json` column type: the `safe: true` schema sync adds a
 * TEXT column additively with no migration, which is this database's whole
 * contract (see `Run.effort`'s own note). What that costs is a parse, and this
 * module is where it is paid so the service, the wire projection and the turn
 * builder cannot disagree about the shape.
 *
 * ONE FLAT MAP of `{parameterId: value}`, both strings, because that is exactly
 * what the CLI's own config options are — an id and a value it accepts. Nothing
 * here validates either against a vocabulary: which values a model takes is the
 * model's answer, re-asked per model (`ModelParametersService`), and a value it
 * no longer offers is refused by the live agent on the turn with a sentence.
 * Checking here would mean holding a second copy of that vocabulary.
 */

/** How many parameters one run may carry, and how long a value may be. */
const MAX_PARAMETERS = 32;
const MAX_VALUE_LENGTH = 200;

/**
 * The stored column as a map — `{}` for null, blank, unparseable, or anything
 * that is not a flat object of strings.
 *
 * Lenient by design, on the rule the rest of this module follows: these values
 * are settings for the NEXT turn, and a row that cannot be read must cost the
 * user their picks rather than their conversation. A throw here would fail
 * every read of the chat.
 */
export function readModelParameters(
  raw: string | null,
): Record<string, string> {
  if (raw === null || raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return sanitizeModelParameters(parsed);
}

/**
 * A map as the column stores it — `null` for an empty one, so "no parameters"
 * is one state in the row rather than two (`null` and `'{}'`).
 */
export function writeModelParameters(
  parameters: Record<string, string> | null | undefined,
): string | null {
  const clean = sanitizeModelParameters(parameters);
  return Object.keys(clean).length === 0 ? null : JSON.stringify(clean);
}

/**
 * Keep only `{string: string}` entries, both non-empty, bounded in count and
 * in length.
 *
 * The bounds are not paranoia about this app's own writers — they are what
 * makes a value safe to hand to a CLI as a config option every turn, for the
 * life of the chat. Same reasoning as `CustomInstructionsSchema`'s ceiling.
 */
function sanitizeModelParameters(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_PARAMETERS) {
      break;
    }
    if (typeof raw !== 'string') {
      continue;
    }
    const key = id.trim();
    const entry = raw.trim();
    if (key === '' || entry === '' || entry.length > MAX_VALUE_LENGTH) {
      continue;
    }
    out[key] = entry;
  }
  return out;
}
