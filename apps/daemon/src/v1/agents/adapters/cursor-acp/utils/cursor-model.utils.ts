/**
 * Reading a cursor ACP model id.
 *
 * cursor-agent has no `--effort` equivalent over ACP: effort rides INSIDE the
 * model id, as one parameter of a bracket list —
 * `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`. The
 * friendly name the agent reports alongside it ("Opus 5") omits that half
 * entirely, so without this the effort is invisible everywhere.
 *
 * Lives here, in this CLI's own utils, because the syntax is this CLI's. It was
 * previously a renderer helper reading the same bracket, which put one CLI's
 * id format in the composer and forced the chip that showed it to branch on
 * `agentKind === 'cursor-agent'`.
 */

/**
 * The `effort=` parameter of a cursor model id, or null when it states none.
 *
 * Two spellings share the axis and only one is called `effort`: the anthropic
 * and grok ids say `effort=high`, the OpenAI-family ids say `reasoning=medium`,
 * and several state neither (`gemini-3.1-pro[]`,
 * `claude-opus-4-5[thinking=true]`). All three are read here — the value is
 * shown to the user as the model's effort whichever key carried it, since the
 * distinction is a vendor's naming and not something a reader of the picker
 * needs to know.
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
