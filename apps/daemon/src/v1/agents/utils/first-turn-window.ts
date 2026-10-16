import type { AgentAdapter } from '../adapters/agent-adapter';
import type { PartialStreamService } from '../services/partial-stream.service';

/**
 * The window a turn's `--autocompact` threshold is a share of, before its
 * conversation has reported one — so the threshold is in argv from the FIRST
 * turn, where it must be: argv joins `sessionKey`, and a threshold first
 * appearing on turn two respawns the CLI there.
 *
 * The id the CLI runs `model` as under that profile (`resolveModel`), then that
 * id's measured window at this window choice, then the catalog's where the CLI
 * enforces the catalog's figure. Null when nothing knows — never a guess, and
 * never a number read off the window choice itself.
 */
export async function firstTurnWindow(
  adapter: AgentAdapter,
  partials: PartialStreamService,
  model: string | null,
  configDir: string | null,
  contextWindow: string | null,
): Promise<number | null> {
  const resolved = await adapter.resolveModel(model, configDir);
  if (resolved === null) {
    return null;
  }
  return (
    partials.knownWindow(adapter.getConfig().kind, resolved, contextWindow) ??
    (contextWindow === null ? adapter.catalogWindow(resolved) : null)
  );
}
