import type { AgentAdapter } from '../adapters/agent-adapter';
import { isModelPriceProvider } from './model-prices';
import { existingDirectory } from './resolve-directory';

/** How long a price waits on a CLI to name the model an alias runs as. */
export const PRICED_MODEL_RESOLVE_MS = 2_000;

/**
 * The model id a price is looked up under: `model` as the CLI would run it
 * under the account `configDir` names — an alias or the CLI's default
 * resolved — or `model` itself when that cannot be known at once. The CLI is
 * asked nothing for a model of no catalog vendor, or under a folder that no
 * longer exists (a CLI asked under a missing one creates it), and the answer
 * is waited on no longer than {@link PRICED_MODEL_RESOLVE_MS}: a slower one
 * still lands in the CLI's own cache for the next ask.
 */
export async function resolvePricedModel(
  adapter: AgentAdapter,
  model: string | null,
  configDir: string | null,
): Promise<string | null> {
  if (!isModelPriceProvider(adapter.modelVendorOf(model))) {
    return model;
  }
  const dir = configDir === null ? null : existingDirectory(configDir);
  if (configDir !== null && dir === null) {
    return model;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string | null>((resolve) => {
    timer = setTimeout(() => resolve(model), PRICED_MODEL_RESOLVE_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      adapter
        .resolveModel(model, adapter.vocabularyProfile(dir))
        .catch((): string | null => model),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
