/**
 * The run row's `agentOptions` column, read and written in ONE place — the
 * user's per-CLI switches (`AdapterConfig.options`) as the run snapshotted
 * them, keyed by agent kind and then option id.
 *
 * TEXT holding a JSON object, on `model-parameters.ts`'s reasoning: the
 * `safe: true` schema sync adds a TEXT column additively with no migration,
 * and this module is where the parse is paid so the service, the executor and
 * the export cannot disagree about the shape.
 *
 * Nothing here checks an id against what an adapter declares: an id no adapter
 * reads is simply never read, and an option the snapshot does not carry falls
 * back to its declared default at the turn (`AgentAdapter.agentOption`).
 */

import { hasControlCharacters } from '../chat.types';

/** Per agent kind, per option id. */
export type AgentOptionsSnapshot = Record<string, Record<string, boolean>>;

/**
 * Bounds on what one run may carry. Generous next to any real set — two CLIs
 * with one switch each today — and there because the client is a separate
 * process whose input is untrusted.
 */
const MAX_AGENTS = 16;
const MAX_OPTIONS_PER_AGENT = 32;
const MAX_KEY_LENGTH = 128;

/**
 * The stored column as a snapshot — `{}` for null, blank, unparseable, or
 * anything that is not the expected nesting. Lenient on purpose: these are
 * settings for the next turn, and a row that cannot be read must cost the user
 * their switches (every option reads its default) rather than their chat.
 */
export function readAgentOptions(
  raw: string | null | undefined,
): AgentOptionsSnapshot {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return sanitizeAgentOptions(parsed);
}

/**
 * A snapshot as the column stores it — `null` for an empty one, so "the client
 * said nothing" is one state in the row rather than two.
 */
export function writeAgentOptions(
  value: AgentOptionsSnapshot | null | undefined,
): string | null {
  const clean = sanitizeAgentOptions(value);
  return Object.keys(clean).length === 0 ? null : JSON.stringify(clean);
}

/**
 * Keep only `{agent: {id: boolean}}` entries with non-empty, bounded keys free
 * of control characters, dropping an agent whose map comes out empty.
 */
export function sanitizeAgentOptions(value: unknown): AgentOptionsSnapshot {
  if (!isPlainObject(value)) {
    return {};
  }
  const out: AgentOptionsSnapshot = {};
  for (const [rawAgent, rawOptions] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_AGENTS) {
      break;
    }
    const agent = cleanKey(rawAgent);
    if (agent === null || !isPlainObject(rawOptions)) {
      continue;
    }
    const options: Record<string, boolean> = {};
    for (const [rawId, raw] of Object.entries(rawOptions)) {
      if (Object.keys(options).length >= MAX_OPTIONS_PER_AGENT) {
        break;
      }
      const id = cleanKey(rawId);
      if (id !== null && typeof raw === 'boolean') {
        options[id] = raw;
      }
    }
    if (Object.keys(options).length > 0) {
      out[agent] = options;
    }
  }
  return out;
}

function cleanKey(raw: string): string | null {
  const key = raw.trim();
  return key === '' || key.length > MAX_KEY_LENGTH || hasControlCharacters(key)
    ? null
    : key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
