import {
  CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
  CURSOR_EFFORT_PARAMETER_ID,
  CURSOR_EFFORT_PARAMETER_IDS,
} from '../cursor-acp.const';

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

/**
 * One `<id>=<value>` parameter of a cursor model selection.
 *
 * `alternateIds` is the agent-agnostic driver's contract ({@link
 * AcpModelParameter}): the same setting can be spelled differently by different
 * models of this CLI, so the adapter names every spelling and the driver sends
 * whichever one the model actually offers.
 */
export interface CursorModelParameter {
  id: string;
  value: string;
  alternateIds?: readonly string[];
  /**
   * Whether the prompt must wait for this frame's reply — the driver's
   * {@link AcpModelParameter.applyBeforePrompt}, set here because WHICH
   * settings this CLI binds at turn start is a fact about this CLI.
   */
  applyBeforePrompt?: boolean;
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
  contextWindow?: string | null,
): CursorModelSelection {
  return withContextWindow(
    withEffort(splitCursorModelId(modelId), effort),
    contextWindow,
  );
}

/**
 * The turn's chosen CONTEXT WINDOW, layered on the same rule the effort follows:
 * the value picked now beats any the stored id carried, and setting none leaves
 * whatever the id already said.
 *
 * Separate from the effort layer rather than folded into it, because the two
 * are independent axes and a turn may name either, both or neither — and
 * because a legacy composed id routinely carries `context=300k` from a chat
 * created before there was a picker for it (`splitCursorModelId`'s own doc
 * block). Dropping the old pair before writing the new one is what keeps the
 * axis from being set twice.
 */
function withContextWindow(
  selection: CursorModelSelection,
  contextWindow: string | null | undefined,
): CursorModelSelection {
  const wanted = (contextWindow ?? '').trim();
  if (wanted === '') {
    return selection;
  }
  return {
    model: selection.model,
    parameters: [
      ...selection.parameters.filter(
        (parameter) => parameter.id !== CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
      ),
      // ONE spelling, so no `alternateIds` — see the constant for the sweep
      // that measured that, and for what would turn this into a list.
      //
      // `applyBeforePrompt` because this CLI binds the window when the TURN
      // begins, not per request: measured on 2026.08.11-e8db854, the identical
      // frames pipelined behind the prompt leave the turn on the model's
      // default (300,000) while awaited they give the 1,000,000 that was asked
      // for — and the reply confirms `context = 1m` either way, so nothing
      // short of the timing distinguishes them.
      {
        id: CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
        value: wanted,
        applyBeforePrompt: true,
      },
    ],
  };
}

/** The effort half of {@link cursorModelSelection} — see its doc block. */
function withEffort(
  selection: CursorModelSelection,
  effort: string | null | undefined,
): CursorModelSelection {
  const wanted = (effort ?? '').trim();
  if (wanted === '') {
    return selection;
  }
  return {
    model: selection.model,
    parameters: [
      // EVERY spelling is dropped, not just the one about to be written: a
      // legacy composed id can carry `reasoning=medium`, and leaving that in
      // beside a fresh `effort=high` would set the same axis twice — once to
      // the value the user just picked and once to a months-old one.
      ...selection.parameters.filter(
        (parameter) =>
          !CURSOR_EFFORT_PARAMETER_IDS.some((id) => id === parameter.id),
      ),
      {
        id: CURSOR_EFFORT_PARAMETER_ID,
        value: wanted,
        // …and the driver replaces that default with whichever spelling THIS
        // model enumerated. Without it a gpt-family turn sent `effort=` and was
        // answered `-32602 Unknown model config option`, so the picker on those
        // models never did anything.
        alternateIds: CURSOR_EFFORT_PARAMETER_IDS,
      },
    ],
  };
}
