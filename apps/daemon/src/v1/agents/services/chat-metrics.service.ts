import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { AgentKind } from '../../runs/runs.types';
import type {
  ChatMetricsWire,
  ContextBreakdownWire,
  PlanLimitsWire,
} from '../chat.types';
import { SINGLE_AGENT_NODE } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { sumUsagePayloads } from '../utils/usage-figures';
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
    private readonly nodeStateDao: NodeStateDao,
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
    const [agent, payloads] = await Promise.all([
      this.readFromAgent(runId, run.agentKind, em),
      this.itemDao.turnCompletePayloads(runId, em),
    ]);
    const { context, plan } = agent;
    return {
      context,
      breakdownReason:
        context === null
          ? this.absenceReason(
              run.agentKind,
              agent.asked,
              'breakdownUnavailableReason',
              CONTEXT_ABSENCE,
            )
          : null,
      plan,
      planReason:
        plan === null
          ? this.absenceReason(
              run.agentKind,
              agent.asked,
              'planLimitsUnavailableReason',
              PLAN_ABSENCE,
            )
          : null,
      // The rule every figure obeys — null until SOME turn reported it, so a
      // chat on a CLI that reports no usage reads as "not measured" and never
      // as "cost nothing" — lives once in `utils/usage-figures`, which the
      // Stats page's cross-run aggregation folds with too. Two copies of that
      // rule is how the panel and the page come to disagree about the same
      // turns.
      totals: sumUsagePayloads(payloads),
    };
  }

  /**
   * Resolve the run's channels ONCE, then put both questions to the adapter —
   * and say whether there was anything to ask in the first place.
   *
   * Together, not one call each, for the reason the route answers both halves
   * at once: the panel shows the window and the plan side by side, and two
   * independent resolutions could hand it a reading of a live process beside a
   * reading taken after that process was reaped.
   *
   * The `asked` half is what separates the two sentences the panel can show.
   * Without it every empty reading was reported as "send a message to take a
   * fresh reading", which is the cure for one cause and a red herring for the
   * other: an agent that WAS there and did not answer in time gets asked again
   * by simply looking again, and sending it a message fixes nothing.
   *
   * Never throws: a readout is not worth failing a request over, and the one
   * thing a caller could do about a failure — show the panel without it — is
   * what null already means. Each question is caught SEPARATELY, so a CLI that
   * answers one and not the other loses only that one.
   */
  private async readFromAgent(
    runId: string,
    agentKind: AgentKind | null,
    em: EntityManager,
  ): Promise<{
    context: ContextBreakdownWire | null;
    plan: PlanLimitsWire | null;
    asked: boolean;
  }> {
    const nothing = { context: null, plan: null, asked: false };
    // A run naming no agent has nobody to ask; a CLI declaring a reason for
    // BOTH questions has nothing to be asked for. A CLI declaring only one is
    // still asked — the other half is a real feature, and short-circuiting on
    // either reason would switch it off with a plausible sentence in its place.
    if (
      agentKind === null ||
      (this.declaredReason(agentKind, 'breakdownUnavailableReason') !== null &&
        this.declaredReason(agentKind, 'planLimitsUnavailableReason') !== null)
    ) {
      return nothing;
    }
    // BOTH channels are offered and the adapter takes what it needs: claude
    // answers from the live process, cursor from the session store it wrote
    // to disk — which is why the id is fetched even when a process exists.
    const live = this.sessions.peek(runId);
    let sessionId: string | null = null;
    try {
      const state = await this.nodeStateDao.getByRunNode(
        runId,
        SINGLE_AGENT_NODE,
        em,
      );
      sessionId = state?.agentSessionId ?? null;
    } catch (err) {
      this.logger.warn(
        `context session lookup for run ${runId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Whether a channel EXISTED is decided here, before the ask — the reading
    // failing is precisely the case the two sentences have to tell apart, so it
    // cannot be inferred from the reading.
    const asked = live !== null || sessionId !== null;
    if (!asked) {
      return nothing;
    }
    const adapter = this.adapters.for(agentKind);
    const input = { live, sessionId };
    const [context, plan] = await Promise.all([
      this.attempt(runId, 'context breakdown', () =>
        adapter.readContextUsage(input),
      ),
      this.attempt(runId, 'plan limits', () => adapter.readPlanLimits(input)),
    ]);
    return { context, plan, asked };
  }

  /** One adapter question, whose failure is a null reading and a log line. */
  private async attempt<T>(
    runId: string,
    what: string,
    ask: () => Promise<T | null>,
  ): Promise<T | null> {
    try {
      return await ask();
    } catch (err) {
      this.logger.warn(
        `${what} for run ${runId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Why one of the two readings is absent, in words the panel can show.
   *
   * Two causes, and the difference is exactly what the user needs: a CLI that
   * has no such channel will never have one, while a claude chat whose process
   * has been reaped for idleness gets its reading back on the next message.
   * Collapsing them into one blank space is how "why is there nothing here?"
   * gets asked.
   *
   * Parameterized over WHICH reading rather than duplicated per reading: the
   * branching is identical and only the sentences differ, and two copies of it
   * is how one of them comes to lose the distinction the other keeps.
   */
  private absenceReason(
    agentKind: AgentKind | null,
    asked: boolean,
    declared: DeclaredReasonField,
    sentences: AbsenceSentences,
  ): string {
    // A run row's `agentKind` is nullable, and a workflow run genuinely has
    // none — its nodes each name their own. There is nothing to ask, and no
    // adapter to ask for a sentence.
    if (agentKind === null) {
      return sentences.noSingleAgent;
    }
    return (
      this.declaredReason(agentKind, declared) ??
      (asked ? sentences.noAnswer : sentences.noLiveProcess)
    );
  }

  /**
   * What this CLI's own adapter says about having no such channel, or null
   * when it declares one.
   *
   * Split out from {@link absenceReason} because the two questions are
   * different and only one of them is answerable before asking: "this agent
   * can never say" is a fact, while "there was nobody to ask just now" is only
   * known once the session has been tried.
   */
  private declaredReason(
    agentKind: AgentKind,
    field: DeclaredReasonField,
  ): string | null {
    return this.adapters.for(agentKind).getConfig().usage[field];
  }
}

/** Which of the adapter's declared "no such channel" sentences to consult. */
type DeclaredReasonField =
  'breakdownUnavailableReason' | 'planLimitsUnavailableReason';

/** The three sentences one absent reading can need. */
interface AbsenceSentences {
  noSingleAgent: string;
  /**
   * What the panel says for a CLI that CAN be asked but has no process
   * running — phrased as the cure rather than the cause, since the reading is
   * taken from a live agent and the way to get one is to send a message. "No
   * session" would be true and useless.
   */
  noLiveProcess: string;
  /**
   * What the panel says when there WAS an agent to ask and the reading did not
   * come back — a control request that timed out, or a reply that could not be
   * read.
   *
   * A separate sentence because the cure is the opposite one: the channel is
   * there, so looking again is what gets a reading, while the sentence above
   * tells the user to send a message — advice that costs them a turn and fixes
   * nothing here.
   */
  noAnswer: string;
}

const CONTEXT_ABSENCE: AbsenceSentences = {
  noSingleAgent:
    'this run names no single agent, so there is no one context window to report',
  noLiveProcess:
    'the breakdown is read from the running agent — send a message in this chat to take a fresh reading',
  noAnswer:
    'the agent did not answer the context request in time — the reading is taken again while this stays open',
};

const PLAN_ABSENCE: AbsenceSentences = {
  noSingleAgent:
    'this run names no single agent, so there is no one account whose limits it could report',
  noLiveProcess:
    'plan limits are read from the running agent — send a message in this chat to take a fresh reading',
  noAnswer:
    'the agent did not answer the usage request in time — the reading is taken again while this stays open',
};
