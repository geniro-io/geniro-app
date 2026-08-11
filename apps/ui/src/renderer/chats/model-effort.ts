/**
 * Reads the `effort=` parameter out of a cursor ACP model id.
 *
 * cursor-agent folds reasoning effort into its model ids rather than exposing a
 * separate `--effort` flag — e.g.
 * `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`. The
 * composer's model chip shows the agent's friendly label ("Opus 5"); this
 * helper surfaces the effort half the label omits.
 */
export function parseModelEffort(modelId: string): string | null {
  const match = /(?:^|[,[])\s*effort=([^,\]]+)/.exec(modelId);
  const effort = match?.[1]?.trim();
  return effort !== undefined && effort !== '' ? effort : null;
}
