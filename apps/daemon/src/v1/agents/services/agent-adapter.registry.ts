import { Inject, Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';

/**
 * The DI token for every adapter the daemon drives — ONE list, provided by
 * `agents.module.ts`, which is the only place that names which CLIs exist.
 */
export const AGENT_ADAPTERS = Symbol('AGENT_ADAPTERS');

/**
 * The ONE kind→adapter dispatch in the daemon.
 *
 * `.claude/rules/agent-adapters.md` bars every service from branching on which
 * CLI it is talking to, so every consumer asks this registry for the adapter of
 * a kind (or iterates all of them) and nothing else in the daemon holds a
 * concrete adapter class. Adding a CLI is therefore one entry in the module's
 * list: a kind with no adapter throws by name instead of resolving to whichever
 * happened to be a fallback, and a consumer that iterates cannot omit it.
 */
@Injectable()
export class AgentAdapterRegistry {
  private readonly byKind: ReadonlyMap<AgentKind, AgentAdapter>;

  constructor(@Inject(AGENT_ADAPTERS) adapters: readonly AgentAdapter[]) {
    // Keyed off each adapter's OWN `config.kind` rather than a literal spelled
    // here: the kind is already declared once, in that CLI's adapter, and a
    // second spelling is a place for the two to disagree.
    const byKind = new Map<AgentKind, AgentAdapter>();
    for (const adapter of adapters) {
      const kind = adapter.getConfig().kind;
      if (byKind.has(kind)) {
        // A Map would keep the LAST adapter for a repeated kind and drop the
        // other without a word — every turn of that CLI then driven by an
        // adapter nobody chose. Two adapters claiming one kind is a wiring
        // mistake, so it stops the boot rather than picking one.
        throw new Error(
          `two adapters declare agent kind '${kind}' — each CLI must be registered exactly once`,
        );
      }
      byKind.set(kind, adapter);
      // Every adapter exists by now and nothing has spawned, so from here on
      // every child's strip holds the union over every CLI.
      adapter.registerEnvIsolation();
    }
    this.byKind = byKind;
  }

  /**
   * Every registered adapter, keyed by the kind it declares.
   *
   * For the consumers that answer a question ABOUT the CLIs rather than
   * driving one — `GET /v1/capabilities` composing per-agent support, the boot
   * sweep. Iterating this map is what keeps a new CLI from being silently
   * omitted from such an answer, the way a hand-written literal would.
   */
  all(): ReadonlyMap<AgentKind, AgentAdapter> {
    return this.byKind;
  }

  /** The adapter driving one agent kind. */
  for(kind: AgentKind): AgentAdapter {
    const adapter = this.byKind.get(kind);
    if (!adapter) {
      // Reachable only from a kind that reached the daemon without an adapter
      // — a widened `AgentKind` whose registration was forgotten, or a value
      // that slipped past a DTO. Loud, because the alternative is a turn
      // silently driven by the wrong CLI.
      throw new BadRequestException(
        'AGENT_KIND_UNSUPPORTED',
        `no adapter is registered for agent kind '${kind}'`,
      );
    }
    return adapter;
  }
}
