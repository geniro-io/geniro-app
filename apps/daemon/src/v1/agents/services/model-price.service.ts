import { Injectable } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentModelWire, ModelPriceAnswerWire } from '../chat.types';
import { toModelPriceWire } from '../utils/model-prices';
import { resolvePricedModel } from '../utils/priced-model';
import { resolveValidConfigDir } from '../utils/resolve-config-dir';
import { AgentAdapterRegistry } from './agent-adapter.registry';

/**
 * What a model costs per million tokens, for showing beside it — the catalog
 * price under the model's vendor (`AgentAdapter.modelPriceOf`), asked at read
 * time so an hourly catalog refresh reaches the next answer without any cache
 * of its own.
 */
@Injectable()
export class ModelPriceService {
  constructor(private readonly adapters: AgentAdapterRegistry) {}

  /** Each picker row with the price of the model it runs as. */
  priceRows(kind: AgentKind, rows: AgentModelWire[]): AgentModelWire[] {
    const adapter = this.adapters.for(kind);
    return rows.map((row) => ({
      ...row,
      price: toModelPriceWire(
        adapter.modelPriceOf(row.resolvedModel ?? row.id),
      ),
    }));
  }

  /**
   * One model's price. An id the catalog does not list, of a vendor it does,
   * is asked again as the model it runs as under that account, so an alias
   * (`opus`) shows its model's price.
   */
  async answer(
    kind: AgentKind,
    model: string,
    configDir: string | null,
  ): Promise<ModelPriceAnswerWire> {
    const adapter = this.adapters.for(kind);
    const direct = adapter.modelPriceOf(model);
    if (direct !== null) {
      return { pricedAs: model, price: toModelPriceWire(direct) };
    }
    const resolved = await resolvePricedModel(
      adapter,
      model,
      configDir === null ? null : resolveValidConfigDir(configDir),
    );
    const price =
      resolved === null || resolved === model
        ? null
        : adapter.modelPriceOf(resolved);
    return price === null
      ? { pricedAs: null, price: null }
      : { pricedAs: resolved, price: toModelPriceWire(price) };
  }
}
