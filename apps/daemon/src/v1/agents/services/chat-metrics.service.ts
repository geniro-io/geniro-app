import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { AgentKind } from '../../runs/runs.types';
import type {
  ChatMetricsWire,
  ChatTotalsWire,
  ContextBreakdownWire,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { asNumber, asRecord } from '../utils/json-util';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentSessionRegistry } from './agent-session.registry';

/**
 * What a chat's context window holds, and what the thread has cost.
 *
 * The composer already showed a ring and a percentage; this is the readout
 * behind it — the same figures that CLI's own `/context` prints, plus the
 * thread's running spend. It exists because "9% full" answers how much room is
 * left and nothing about what filled it, and the two things a user acts on
 * (a 46k-token CLAUDE.md, one MCP server holding 109k of tools) are invisible
 * until the window is broken down.
 *
 * **Composed, never asked directly.** The breakdown is an ADAPTER fact reached
 * through the live session (`AgentSession.readContextUsage`), and the reason
 * there is none is that adapter's own sentence — nothing here knows which CLI
 * it is talking to, or how one accounts for its window.
 */
@Injectable()
export class ChatMetricsService {
  private readonly logger = new Logger(ChatMetricsService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly sessions: AgentSessionRegistry,
    private readonly adapters: AgentAdapterRegistry,
  ) {}

  /**
   * One reading of a chat's metrics.
   *
   * The two halves are gathered together and answered together on purpose: a
   * panel that fetched the breakdown and the spend separately could show a
   * window from one moment beside a cost from another, which is the kind of
   * disagreement between two numbers on one surface that reads as a bug.
   */
  async read(runId: string): Promise<ChatMetricsWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const [context, payloads] = await Promise.all([
      this.readBreakdown(runId, run.agentKind),
      this.itemDao.turnCompletePayloads(runId, em),
    ]);
    return {
      context,
      breakdownReason:
        context === null ? this.breakdownReason(run.agentKind) : null,
      totals: sumTurns(payloads),
    };
  }

  /**
   * Ask the run's live process, or answer null.
   *
   * Never throws: a readout is not worth failing a request over, and the one
   * thing a caller could do about a failure — show the panel without a
   * breakdown — is what null already means.
   */
  private async readBreakdown(
    runId: string,
    agentKind: AgentKind | null,
  ): Promise<ContextBreakdownWire | null> {
    // Only the DECLARED reason short-circuits. `breakdownReason` also answers
    // for the run that simply has no process right now, and testing THAT here
    // would mean never asking a live session at all — the whole feature, off,
    // with a plausible sentence in its place.
    if (agentKind === null || this.declaredReason(agentKind) !== null) {
      return null;
    }
    try {
      return await this.sessions.readContextUsage(runId);
    } catch (err) {
      this.logger.warn(
        `context breakdown for run ${runId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Why there is no breakdown, in words the panel can show.
   *
   * Two causes, and the difference is exactly what the user needs: a CLI that
   * has no such channel will never have one, while a claude chat whose process
   * has been reaped for idleness gets its breakdown back on the next message.
   * Collapsing them into one blank space is how "why is there nothing here?"
   * gets asked.
   */
  private breakdownReason(agentKind: AgentKind | null): string {
    // A run row's `agentKind` is nullable, and a workflow run genuinely has
    // none — its nodes each name their own. There is nothing to ask, and no
    // adapter to ask for a sentence.
    if (agentKind === null) {
      return 'this run names no single agent, so there is no one context window to report';
    }
    return this.declaredReason(agentKind) ?? NO_LIVE_PROCESS_REASON;
  }

  /**
   * What this CLI's own adapter says about having no such channel, or null
   * when it declares one.
   *
   * Split out from {@link breakdownReason} because the two questions are
   * different and only one of them is answerable before asking: "this agent
   * can never say" is a fact, while "there was nobody to ask just now" is only
   * known once the session has been tried.
   */
  private declaredReason(agentKind: AgentKind): string | null {
    return this.adapters.for(agentKind).getConfig().usage
      .breakdownUnavailableReason;
  }
}

/**
 * What the panel says for a CLI that CAN be asked but has no process running.
 *
 * Phrased as the cure rather than the cause: the breakdown is read from a live
 * agent, so the way to get one is to send a message. "No session" would be
 * true and useless.
 */
const NO_LIVE_PROCESS_REASON =
  'the breakdown is read from the running agent — send a message in this chat to take a fresh reading';

/**
 * Sum the thread's finished turns.
 *
 * Every figure is null until SOME turn reported it, and a turn that reported
 * none contributes nothing rather than a zero: a chat on a CLI that reports no
 * usage at all must read as "not measured", never as "cost nothing". That is
 * why each total is accumulated separately instead of being seeded at 0.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/agent-activity.ts` reads the same
 * `usage` object out of a `turn_complete` item payload for the per-turn row.
 * The payload is `z.unknown()` on the wire BY DESIGN — each item kind carries
 * a different shape — so no generated type reaches either side, and a field
 * added to `AgentUsage` has to be read in both places.
 */
function sumTurns(payloads: readonly string[]): ChatTotalsWire {
  const totals: ChatTotalsWire = {
    turns: 0,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    thinkingTokens: null,
    workedMs: null,
  };
  const add = (
    key: keyof Omit<ChatTotalsWire, 'turns'>,
    value: number | null,
  ): void => {
    if (value !== null) {
      totals[key] = (totals[key] ?? 0) + value;
    }
  };
  for (const raw of payloads) {
    const usage = readUsage(raw);
    if (!usage) {
      continue;
    }
    totals.turns += 1;
    add('costUsd', asNumber(usage.costUsd));
    add('inputTokens', asNumber(usage.inputTokens));
    add('outputTokens', asNumber(usage.outputTokens));
    add('cacheReadTokens', asNumber(usage.cacheReadTokens));
    add('cacheCreationTokens', asNumber(usage.cacheCreationTokens));
    add('thinkingTokens', asNumber(usage.thinkingTokens));
    // The CLI's OWN working time where it reports one, and NO wall-clock
    // fallback here — the renderer already owns that substitution for the
    // per-turn row, and a total mixing the two would be a figure with no
    // single meaning.
    add('workedMs', asNumber(usage.durationMs));
  }
  return totals;
}

/** One stored `turn_complete` payload's `usage`, or null when it has none. */
function readUsage(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(asRecord(JSON.parse(raw))?.usage);
  } catch {
    // A payload that will not parse is one row's worth of accounting lost, not
    // a reason to fail the whole readout.
    return null;
  }
}
