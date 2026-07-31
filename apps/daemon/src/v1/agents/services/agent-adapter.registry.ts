import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAdapter } from '../adapters/cursor/cursor.adapter';

/**
 * The ONE kind→adapter dispatch in the daemon.
 *
 * `.claude/rules/agent-adapters.md` bars every service from branching on which
 * CLI it is talking to, and the fold that removed those branches left each
 * service holding its own private `kind === 'claude' ? this.claude :
 * this.cursor` instead — five copies, spanning a module boundary. One line
 * each, but the shape is the hazard: adding a third CLI means finding all five,
 * and a missed one does not fail to compile — it silently routes that kind to
 * cursor.
 *
 * Registering the map here makes the omission impossible: a kind with no
 * adapter throws by name instead of resolving to whichever happened to be the
 * fallback.
 */
@Injectable()
export class AgentAdapterRegistry {
  private readonly byKind: ReadonlyMap<AgentKind, AgentAdapter>;

  constructor(claude: ClaudeAdapter, cursor: CursorAdapter) {
    // Keyed off each adapter's OWN `config.kind` rather than a literal spelled
    // here: the kind is already declared once, in that CLI's const file, and a
    // second spelling is a place for the two to disagree — a mis-keyed entry
    // would route every turn of one CLI to the other's binary, silently.
    this.byKind = new Map<AgentKind, AgentAdapter>(
      [claude, cursor].map((adapter) => [adapter.config.kind, adapter]),
    );
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
