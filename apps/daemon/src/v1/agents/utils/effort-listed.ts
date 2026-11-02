import type { AgentAdapter } from '../adapters/agent-adapter';

/**
 * Whether the CLI lists `effort`, answered only for a CLI whose list is
 * complete; null where its levels belong to the model, so the turn's own
 * driver judges the value against the model that runs it.
 */
export function effortListed(
  adapter: Pick<AgentAdapter, 'listEfforts' | 'getConfig'>,
  effort: string,
): boolean | null {
  if (!adapter.getConfig().effortsAreExhaustive) {
    return null;
  }
  return adapter.listEfforts().some((level) => level.id === effort);
}
