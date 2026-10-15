import type { AcpConfigOption } from '../../acp/acp.types';
import {
  CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
  CURSOR_EFFORT_PARAMETER_ID,
  CURSOR_EFFORT_PARAMETER_IDS,
  CURSOR_OWNED_PARAMETER_IDS,
  CURSOR_THOUGHT_LEVEL_CATEGORY,
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
 * geniro speaks only the parameterized namespace and never parses a composed
 * id. Nothing outside this directory reads a model id.
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
   * The ACP category this setting belongs to ({@link
   * AcpModelParameter.category}) — the driver's last resort when the model
   * spells the axis in a way no `alternateIds` entry names.
   */
  category?: string;
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
 * The stored model id, trimmed — null (an empty or whitespace-only id) means
 * "leave the agent's current model alone".
 */
export function cursorBareModel(
  modelId: string | null | undefined,
): string | null {
  const trimmed = (modelId ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * What this turn applies, from the run's stored model and its chosen effort.
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
  modelParameters?: Record<string, string> | null,
): CursorModelSelection {
  return withModelParameters(
    withContextWindow(
      withEffort({ model: cursorBareModel(modelId), parameters: [] }, effort),
      contextWindow,
    ),
    modelParameters,
  );
}

/**
 * The turn's OTHER model settings, layered last.
 *
 * Last because it is the only layer geniro holds no vocabulary for: the ids
 * come from the CLI's own handshake (`ModelParametersService`) and are sent
 * back verbatim. Anything the two layers above already own is dropped rather
 * than trusted — they are the axes with their own control, and letting one
 * through here would set the same option twice, once from the chip the user
 * pressed and once from a map that happened to carry the same key.
 *
 * Not `applyBeforePrompt`: nothing has measured any of these to bind at turn
 * start the way `context` does, and paying a round trip per parameter on a
 * guess would cost every turn.
 */
function withModelParameters(
  selection: CursorModelSelection,
  modelParameters: Record<string, string> | null | undefined,
): CursorModelSelection {
  const entries = Object.entries(modelParameters ?? {}).filter(
    ([id, value]) =>
      id.trim() !== '' &&
      value.trim() !== '' &&
      !CURSOR_OWNED_PARAMETER_IDS.includes(id),
  );
  if (entries.length === 0) {
    return selection;
  }
  return {
    model: selection.model,
    parameters: [
      ...selection.parameters,
      ...entries.map(([id, value]) => ({ id, value: value.trim() })),
    ],
  };
}

/**
 * The turn's chosen CONTEXT WINDOW; setting none leaves the model's own.
 *
 * Separate from the effort layer rather than folded into it, because the two
 * are independent axes and a turn may name either, both or neither.
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
      ...selection.parameters,
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

/**
 * WHICH enumerated option carries this model's reasoning-effort axis — the ONE
 * answer the listing and the subtraction beside it both read.
 *
 * One function rather than two conditions, because the two halves are the same
 * question asked from opposite ends: an option this adopts as the effort axis
 * must not ALSO be offered as a generic model setting, or the user is shown two
 * controls for one axis and each overwrites the other on the next turn. That is
 * exactly what `grok-4.7` did — see {@link CURSOR_EFFORT_PARAMETER_IDS}.
 *
 * A known spelling wins (the vendor has been seen to use it); failing that, the
 * sole GRADED option of the `thought_level` category is adopted — the reasoning
 * in {@link CURSOR_THOUGHT_LEVEL_CATEGORY}, including why a boolean pair is
 * excluded rather than counted. SOLE, because adopting one of two candidates
 * would be a coin flip on which axis the user's level is written to; with none
 * or several, this answers null and the model is treated as having no effort
 * axis, which is the state a reader can at least see.
 *
 * Never throws; an option the agent named with no values is not an axis.
 */
export function cursorEffortOption(
  options: readonly AcpConfigOption[],
): AcpConfigOption | null {
  for (const id of CURSOR_EFFORT_PARAMETER_IDS) {
    const named = options.find(
      (option) => option.id === id && option.options.length > 0,
    );
    if (named !== undefined) {
      return named;
    }
  }
  const graded = options.filter(
    (option) =>
      option.category === CURSOR_THOUGHT_LEVEL_CATEGORY &&
      option.options.length > 0 &&
      !isToggleOption(option),
  );
  return graded.length === 1 ? (graded[0] ?? null) : null;
}

/**
 * Whether an option is a TOGGLE rather than a graded axis — every value it
 * offers being one of the boolean pair.
 *
 * The values are the CLI's own strings (`"false"`/`"true"`, measured), so this
 * reads them as written rather than parsing them: a vocabulary of `off|on`
 * would be a different measurement and belongs here only once it is one.
 */
function isToggleOption(option: AcpConfigOption): boolean {
  return option.options.every(
    ({ value }) => value === 'true' || value === 'false',
  );
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
      ...selection.parameters,
      {
        id: CURSOR_EFFORT_PARAMETER_ID,
        value: wanted,
        // The driver replaces this default spelling with whichever one THIS
        // model enumerated. Without it a gpt-family turn sent `effort=` and was
        // answered `-32602 Unknown model config option`, so the picker on those
        // models never did anything.
        alternateIds: CURSOR_EFFORT_PARAMETER_IDS,
        // The same widening the LISTING takes, on the same terms: a spelling
        // nobody has measured yet is still recognisable as this axis by its
        // category, so the level the picker offered is the level that goes out.
        // Without it the two halves can disagree — the picker reading a model's
        // own levels off an option the turn then fails to write to.
        category: CURSOR_THOUGHT_LEVEL_CATEGORY,
      },
    ],
  };
}
