import { asArray, asRecord, asString } from '../../../utils/json-util';
import type { AgentEffort } from '../../adapter.types';

/** One speed tier a model offers, in `model/list`'s own words. */
export interface CodexServiceTier {
  id: string;
  name: string;
  description: string | null;
}

/** One model `model/list` offers, with the efforts and speed tiers it accepts. */
export interface CodexModelEntry {
  id: string;
  label: string;
  efforts: AgentEffort[];
  isDefault: boolean;
  serviceTiers: CodexServiceTier[];
  defaultServiceTier: string | null;
}

/**
 * The models a `model/list` result offers, in the CLI's own order.
 *
 * A model marked `hidden` is left out: codex hides it from its own picker, and
 * listing it here would offer a model the CLI itself does not present.
 */
export function readCodexModels(result: unknown): CodexModelEntry[] {
  const models: CodexModelEntry[] = [];
  for (const entry of asArray(asRecord(result)?.data)) {
    const record = asRecord(entry);
    const id = record ? (asString(record.id) ?? asString(record.model)) : null;
    if (record === null || !id || record.hidden === true) {
      continue;
    }
    const efforts: AgentEffort[] = asArray(
      record.supportedReasoningEfforts,
    ).flatMap((effort) => {
      const level = asString(asRecord(effort)?.reasoningEffort);
      return level ? [{ id: level, label: level }] : [];
    });
    const serviceTiers: CodexServiceTier[] = asArray(
      record.serviceTiers,
    ).flatMap((entry) => {
      const tier = asRecord(entry);
      const tierId = tier ? asString(tier.id) : null;
      return tier && tierId
        ? [
            {
              id: tierId,
              name: asString(tier.name) ?? tierId,
              description: asString(tier.description),
            },
          ]
        : [];
    });
    models.push({
      id,
      label: asString(record.displayName) ?? id,
      efforts,
      isDefault: record.isDefault === true,
      serviceTiers,
      defaultServiceTier: asString(record.defaultServiceTier),
    });
  }
  return models;
}
