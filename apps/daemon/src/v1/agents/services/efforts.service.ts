import { Injectable } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentEffortWire } from '../chat.types';
import { AgentAdapterRegistry } from './agent-adapter.registry';

/**
 * The composer's reasoning-effort list, per agent kind.
 *
 * Nothing here knows what a level is called or which CLI has any — that is the
 * adapter's (`listEfforts`). This service only routes the question, exactly as
 * {@link ModelsService} does for models. Unlike models there is no cache and no
 * version key: an adapter answers from a documented constant without touching
 * the binary, so there is nothing to go stale.
 *
 * An EMPTY list is a real answer, not a failure — it is how a CLI with no
 * effort control (cursor-agent) reports that, and the caller omits the picker.
 */
@Injectable()
export class EffortsService {
  constructor(private readonly adapters: AgentAdapterRegistry) {}

  list(kind: AgentKind): AgentEffortWire[] {
    return this.adapterFor(kind).listEfforts();
  }

  /**
   * Whether this CLI accepts `effort` — false for any level it does not list,
   * and for every level when it has no effort control at all.
   */
  accepts(kind: AgentKind, effort: string): boolean {
    return this.adapterFor(kind)
      .listEfforts()
      .some((e) => e.id === effort);
  }

  private adapterFor(kind: AgentKind): AgentAdapter {
    return this.adapters.for(kind);
  }
}
