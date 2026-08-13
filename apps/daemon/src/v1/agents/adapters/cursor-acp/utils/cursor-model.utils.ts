import { CURSOR_EFFORT_PARAMETER_ID } from '../cursor-acp.const';

/**
 * Reading and composing a cursor ACP model selection.
 *
 * This CLI has two id namespaces for the same models, and which one a session
 * speaks depends on the handshake:
 *
 * - **`variants`** (no client `_meta` flag) — ONE opaque composed id per model
 *   family: `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`.
 *   The agent accepts only the ids it enumerated, which is what made the effort
 *   unselectable.
 * - **`parameterized`** (what geniro declares now) — a BARE name
 *   (`claude-opus-5`) plus one config option per parameter, each with its own
 *   vocabulary. See {@link CURSOR_ACP_CLIENT_META} for the source and probes.
 *
 * Both live here because both are this CLI's own syntax. Nothing outside this
 * directory reads a model id.
 */

/** One `<id>=<value>` parameter of a cursor model selection. */
export interface CursorModelParameter {
  id: string;
  value: string;
}

/**
 * What a turn should apply: the bare model name (null = leave the agent on its
 * current one) and the parameters to set after it, in order.
 */
export interface CursorModelSelection {
  model: string | null;
  parameters: CursorModelParameter[];
}

/**
 * The `effort=` parameter of a cursor model id, or null when it states none.
 *
 * Two spellings share the axis and only one is called `effort`: the anthropic
 * and grok ids say `effort=high`, the OpenAI-family ids say `reasoning=medium`,
 * and several state neither (`gemini-3.1-pro[]`,
 * `claude-opus-4-5[thinking=true]`). All three are read here — the value is the
 * model's effort whichever key carried it, since the distinction is a vendor's
 * naming and not something a reader needs to know.
 *
 * Matched only at a parameter BOUNDARY (`[` or `,`), so a future parameter
 * ending in the same letters (`max_effort=…`) cannot be read as this one. The
 * value is returned verbatim: it is the CLI's own vocabulary
 * (`low`/`medium`/`high`/`xhigh`/`max`) and normalizing it here would invent
 * words the CLI never said.
 *
 * Never throws.
 */
export function cursorModelEffort(modelId: string): string | null {
  const match = /(?:^|[,[])\s*(?:effort|reasoning)=([^,\]]+)/.exec(modelId);
  const effort = match?.[1]?.trim();
  return effort !== undefined && effort !== '' ? effort : null;
}

/**
 * Split a stored model id into a bare name and its parameters.
 *
 * A LEGACY id is one carrying a bracket, and existing chats are full of them:
 * every cursor run created before the parameterized handshake stored the
 * composed form, and that form is `-32602 Invalid params` in the mode the turn
 * now speaks. Splitting it is what keeps those chats running on exactly the
 * settings they were created with — no migration, no silent fallback to a
 * different model.
 *
 * A bare id (`claude-opus-5`, or claude's `opus`) parses to itself with no
 * parameters. An empty or whitespace-only id is `null`, meaning "leave the
 * agent's current model alone".
 *
 * Never throws; a malformed bracket degrades to the name before it plus
 * whatever pairs could be read.
 */
export function splitCursorModelId(
  modelId: string | null | undefined,
): CursorModelSelection {
  const trimmed = (modelId ?? '').trim();
  if (trimmed === '') {
    return { model: null, parameters: [] };
  }
  const open = trimmed.indexOf('[');
  if (open < 0) {
    return { model: trimmed, parameters: [] };
  }
  const name = trimmed.slice(0, open).trim();
  const inner = trimmed.slice(open + 1).replace(/\]\s*$/, '');
  const parameters: CursorModelParameter[] = [];
  for (const pair of inner.split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) {
      continue;
    }
    const id = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (id !== '' && value !== '') {
      parameters.push({ id, value });
    }
  }
  return { model: name === '' ? null : name, parameters };
}

/**
 * What this turn applies, from the run's stored model and its chosen effort.
 *
 * The turn's own `effort` WINS over any the stored id carried. That ordering is
 * the whole point of the feature: a chat created before the effort picker
 * existed stores `…effort=high…` in its model id, and the value the user has now
 * picked in the composer must not be overridden by the one baked into a string
 * months ago. Set to the same value it is a no-op; set to a different one it is
 * the change the user asked for.
 *
 * An effort with no model is legitimate and deliberately allowed: a run on the
 * CLI's default model still has a current model in the seeded profile, and its
 * `effort` option is set on that. Refusing it here would make the picker inert
 * for exactly the runs that never named a model.
 */
export function cursorModelSelection(
  modelId: string | null | undefined,
  effort: string | null | undefined,
): CursorModelSelection {
  const selection = splitCursorModelId(modelId);
  const wanted = (effort ?? '').trim();
  if (wanted === '') {
    return selection;
  }
  return {
    model: selection.model,
    parameters: [
      ...selection.parameters.filter(
        (parameter) => parameter.id !== CURSOR_EFFORT_PARAMETER_ID,
      ),
      { id: CURSOR_EFFORT_PARAMETER_ID, value: wanted },
    ],
  };
}
