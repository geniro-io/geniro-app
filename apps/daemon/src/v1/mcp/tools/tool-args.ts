import { z } from 'zod';

import type { ToolArgs } from '../mcp.types';

/**
 * A tool's arguments read with the zod schema they are parsed with. Readers
 * pass it STRICT — a misspelt `run_id` must not quietly widen a search to
 * every project, nor a misspelt field slip past a card's checks. A model routinely sends `null` for an
 * optional argument it leaves unset; reading that as absent costs nothing,
 * refusing it costs a retry.
 */
export function readToolArgs<TQuery>(
  strictSchema: z.ZodType<TQuery>,
  args: Record<string, unknown>,
): ToolArgs<TQuery> {
  const given = Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== null),
  );
  const parsed = strictSchema.safeParse(given);
  return parsed.success
    ? { ok: true, query: parsed.data }
    : { ok: false, error: parsed.error.message };
}

/**
 * A tool's input schema, GENERATED from the zod schema its arguments are
 * parsed with (strict, as the readers parse them), so the
 * bounds and defaults a model is shown cannot drift from the ones it is held
 * to.
 */
export function toolInputSchema(schema: z.ZodObject): Record<string, unknown> {
  const json: Record<string, unknown> = {
    ...z.toJSONSchema(schema.strict(), { io: 'input' }),
  };
  delete json.$schema;
  return json;
}
