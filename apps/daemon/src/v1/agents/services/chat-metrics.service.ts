import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { AgentKind } from '../../runs/runs.types';
import type { UsageReadChannel } from '../adapters/adapter.types';
import type {
  ChatMetricsWire,
  ChatTotalsWire,
  ContextBreakdownWire,
  PlanLimitsWire,
} from '../chat.types';
import type { StoredMetricsReading } from '../chat.types';
import { SINGLE_AGENT_NODE, StoredMetricsReadingSchema } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { sumUsagePayloads } from '../utils/usage-figures';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
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
export class ChatMetricsService implements OnModuleInit {
  private readonly logger = new Logger(ChatMetricsService.name);

  /**
   * Runs whose context readout has been opened at least once this launch — the
   * ones worth keeping a fresh reading for.
   *
   * In memory rather than on the run row, and that is the honest lifetime: it
   * is a guess about what this user is watching RIGHT NOW, not a fact about the
   * conversation. A restart forgets it and the first open pays the ask again,
   * which is exactly what the first open of a new chat does anyway.
   */
  private readonly watched = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly sessions: AgentSessionRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly bus: AgentEventBus,
  ) {}

  /**
   * Ask this run's agent both questions one last time, on its way out.
   *
   * Registered rather than called: the registry owns the processes and is the
   * only party that knows a session is about to be closed for want of use —
   * see `AgentSessionRegistry.onIdleFarewell` for why that close and no other.
   */
  onModuleInit(): void {
    this.sessions.onIdleFarewell((runId) => this.capture(runId));
    // PREWARM, and only for chats whose readout this user actually opens.
    //
    // REPORTED as "'reading agent context' is too slow when i hover on current
    // context circly. Why it working without delays for claude/cursor in their
    // UI?" — and the answer to the question is the shape of the fix. Those UIs
    // are the CLI: the accounting is already in the process's own memory, so
    // `/context` is a render. geniro is a different process and has to ASK,
    // measured at 1.84–2.18s against a warm claude on this machine. The only
    // way to be instant is to have asked already.
    //
    // A turn's end is when to ask: the process is idle, and the answer is
    // exactly what the next open wants. It is gated on {@link watched} rather
    // than run for every chat because the ask is a real control write on the
    // user's own agent — a tax on every turn of every conversation, for a
    // readout most of them never open.
    this.bus.all().subscribe((event) => {
      if (
        event.item.kind !== 'turn_complete' ||
        !this.watched.has(event.runId)
      ) {
        return;
      }
      // Owned here: this is an RxJS subscriber, so a rejection escaping it
      // reaches the process-level crash guard — and a missed prewarm is a
      // slower hover, not something worth taking the turn plumbing down for.
      void this.capture(event.runId);
    });
  }

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
    // From here on this run is worth keeping a reading warm for.
    this.watched.add(runId);
    // A stored reading whose `atSeq` still matches the transcript describes THIS
    // conversation as it stands — nothing has been said since it was taken — so
    // asking again would spend 1.84–2.18s (measured, warm claude) to be told the
    // same thing. That wait is the whole of the report: "'reading agent context'
    // is too slow when i hover on current context circly".
    //
    // Asked BEFORE the agent rather than after, which is the change: this
    // reading was already stored and already validated against the transcript,
    // and it was consulted only where the live answer came back empty — so
    // every open paid the full question, including the second open a minute
    // after the first with not a word said in between.
    //
    // `atSeq` is what makes it safe, and it is strict: one new row of any kind
    // and the stored reading stops being served, so a figure can never outlive
    // the conversation it measured. The freshest thing this can serve is
    // therefore either current or a live ask.
    // Read ONCE, ahead of everything: the same position decides whether the
    // stored reading still describes this conversation AND stamps a fresh one
    // taken below. Read after the ask instead, a turn landing mid-question
    // would file figures under a transcript they do not describe.
    const atSeq = await this.itemDao.maxSeq(runId, em);
    const current = this.parseStoredReading(run.lastMetricsReading, atSeq);
    // Two conditions, and each rules out a different wrong answer.
    //
    // The BREAKDOWN must be present — not both halves. A stored reading is only
    // ever written with at least one figure in it, and a null `plan` beside a
    // real `context` is the ordinary state of every CLI that reports no
    // allowance, so requiring both would mean this path never ran for them and
    // the wait came back for exactly the users it was meant to help.
    //
    // And there must be a LIVE agent. This is a shortcut past a question whose
    // answer is already known, so it belongs only where that question would
    // otherwise be asked and be slow. With no process the reading is not a
    // shortcut but the last thing anyone measured, which is a different fact
    // and one the panel says out loud ("closed … send a message to take a fresh
    // reading") off `takenAt` — so that case falls through to the path below,
    // which stamps it. Cursor never takes this path either, and does not need
    // to: it answers off its own session store on disk, in milliseconds.
    const usable =
      current !== null &&
      current.context !== null &&
      planReadingIsCurrent(current, Date.now()) &&
      this.sessions.peek(runId) !== null
        ? current
        : null;
    const [agent, payloads] = await Promise.all([
      usable === null
        ? this.readFromAgent(runId, run.agentKind, em)
        : Promise.resolve({
            context: usable.context,
            plan: usable.plan,
            // ASKED, because this reading is the answer to an ask — one made
            // when the conversation was in exactly the state it is in now.
            // These two flags decide only WHICH sentence an absent half gets,
            // and "the agent did not answer" is the true one: it did not,
            // when it was asked. Saying "no live process" instead would send
            // the user to send a message, which would change nothing about a
            // figure the CLI does not report.
            askedContext: true,
            askedPlan: true,
          }),
      this.itemDao.turnCompletePayloads(runId, em),
    ]);
    // A live answer is FILED, which is the other half of making the next open
    // instant — without it the very first open of a chat pays two seconds, and
    // so does every open after it, since nothing was written down. Not awaited:
    // the user is waiting on this reply and the write is for the next reader.
    if (usable === null && (agent.context !== null || agent.plan !== null)) {
      void this.store(runId, atSeq, agent.context, agent.plan);
    }
    // The stored last reading is consulted ONLY where the live one is missing
    // and could not have been taken — a CLI that answers is always preferred,
    // and a reading nobody could take is what this exists for.
    const stored =
      agent.context === null || agent.plan === null ? current : null;
    const context = agent.context ?? stored?.context ?? null;
    const plan = agent.plan ?? stored?.plan ?? null;
    return {
      context,
      breakdownReason:
        context === null
          ? this.absenceReason(
              run.agentKind,
              agent.askedContext,
              'breakdown',
              CONTEXT_ABSENCE,
            )
          : null,
      plan,
      planReason:
        plan === null
          ? this.absenceReason(
              run.agentKind,
              agent.askedPlan,
              'planLimits',
              PLAN_ABSENCE,
            )
          : null,
      // Only where a figure above actually CAME from the stored reading: a live
      // answer is now, and stamping it with the moment an older one was taken
      // would date the very reading that is current.
      takenAt:
        (agent.context === null && context !== null) ||
        (agent.plan === null && plan !== null)
          ? (stored?.takenAt ?? null)
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
   * What this thread has cost, and NOTHING about its window.
   *
   * The same sum {@link read} answers with, reached without the adapter round
   * trip that makes that route expensive — so the header can carry the spend on
   * every thread the user opens instead of only where a readout is expanded.
   * Summed here rather than in the renderer for the reason
   * `ChatTotalsWireSchema` gives: history is paged behind an `afterSeq` cursor,
   * and a client that has scrolled back through part of a long conversation
   * would total part of it, silently.
   */
  async readTotals(runId: string): Promise<ChatTotalsWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    return sumUsagePayloads(await this.itemDao.turnCompletePayloads(runId, em));
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
    askedContext: boolean;
    askedPlan: boolean;
  }> {
    const nothing = {
      context: null,
      plan: null,
      askedContext: false,
      askedPlan: false,
    };
    // A run naming no agent has nobody to ask; a CLI declaring a reason for
    // BOTH questions has nothing to be asked for. A CLI declaring only one is
    // still asked — the other half is a real feature, and short-circuiting on
    // either reason would switch it off with a plausible sentence in its place.
    if (agentKind === null) {
      return nothing;
    }
    const usage = this.adapters.for(agentKind).getConfig().usage;
    if (
      usage.breakdown.kind === 'unavailable' &&
      usage.planLimits.kind === 'unavailable'
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
    // cannot be inferred from the reading. PER READING, and the adapter says
    // which channel each of its answers comes from: asking "does EITHER channel
    // exist" made the noLiveProcess sentence unreachable for claude, whose
    // readings need the live process while a chat that has ever run keeps a
    // session id for good. Every reaped claude chat was therefore told its agent
    // "did not answer in time — the reading is taken again while this stays
    // open" over a question nobody had asked and nothing would ask again.
    // Reproduced from the author's own daemon log: session for run 2262b385
    // closed as unused at 13:18:49, the readout opened at 13:37:07, and not one
    // warning in between because nothing was attempted.
    const available = (channel: UsageReadChannel): boolean =>
      channel === 'live-process' ? live !== null : sessionId !== null;
    const askedContext =
      usage.breakdown.kind === 'reads' && available(usage.breakdown.channel);
    const askedPlan =
      usage.planLimits.kind === 'reads' && available(usage.planLimits.channel);
    if (!askedContext && !askedPlan) {
      return nothing;
    }
    const adapter = this.adapters.for(agentKind);
    const input = { live, sessionId };
    const [context, plan] = await Promise.all([
      askedContext
        ? this.attempt(runId, 'context breakdown', () =>
            adapter.readContextUsage(input),
          )
        : null,
      askedPlan
        ? this.attempt(runId, 'plan limits', () =>
            adapter.readPlanLimits(input),
          )
        : null,
    ]);
    return { context, plan, askedContext, askedPlan };
  }

  /**
   * The last reading this run's agent gave before its process was closed, or
   * null when there is none worth showing.
   *
   * Two ways it is refused, and both matter more than the reading itself. A
   * shape the current schemas cannot parse is DISCARDED rather than served,
   * because the renderer draws these figures and half a breakdown is worse than
   * the sentence saying there is none. And a transcript that has MOVED since —
   * turns taken under a session that was closed some other way, or a daemon
   * restarted between the two — makes the figures describe a conversation that
   * no longer exists; a timestamp on screen does not make that honest, so they
   * are dropped.
   */
  private parseStoredReading(
    raw: string | null,
    atSeq: number,
  ): StoredMetricsReading | null {
    if (raw === null) {
      return null;
    }
    let parsed;
    try {
      parsed = StoredMetricsReadingSchema.safeParse(JSON.parse(raw));
    } catch {
      return null;
    }
    if (!parsed.success) {
      return null;
    }
    return parsed.data.atSeq === atSeq ? parsed.data : null;
  }

  /**
   * File one reading against the transcript position it describes.
   *
   * The ONE write path, shared by the live read and by {@link capture}, so the
   * `atSeq` contract cannot be honoured in one place and forgotten in the
   * other — that field is the whole of what keeps a stored reading from
   * outliving its conversation.
   *
   * Never throws, on both its callers' terms: for the reader this is a cache
   * fill nobody is waiting on, and for the farewell a failed write must not
   * keep a process alive.
   */
  private async store(
    runId: string,
    atSeq: number,
    context: ContextBreakdownWire | null,
    plan: PlanLimitsWire | null,
  ): Promise<void> {
    try {
      await this.runDao.rememberMetricsReading(
        runId,
        JSON.stringify({
          takenAt: new Date().toISOString(),
          atSeq,
          context,
          plan,
        } satisfies StoredMetricsReading),
        this.em.fork(),
      );
    } catch (err) {
      this.logger.warn(
        `the reading for run ${runId} could not be filed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Take both readings from this run's agent and file them on the run.
   *
   * Called from two moments and the difference is worth naming. On the way to
   * CLOSING a process it is the last chance to ask at all — see
   * `AgentSessionRegistry.onIdleFarewell`. After a TURN it is a prewarm: the
   * process is idle, nobody is waiting, and the reading it files is what makes
   * the next open instant instead of a two-second question.
   *
   * The transcript position is read FIRST and deliberately: a turn arriving
   * while the questions are in flight leaves the figures describing the older
   * conversation, and a position taken afterwards would claim they describe the
   * newer one. Read first, the stored reading simply stops being served.
   *
   * Never throws. On the farewell path a failed reading must not keep a process
   * alive; on the prewarm path it is a cache miss and nothing more.
   */
  private async capture(runId: string): Promise<void> {
    const em = this.em.fork();
    try {
      const run = await this.runDao.getById(runId, em);
      if (!run?.agentKind) {
        return;
      }
      const atSeq = await this.itemDao.maxSeq(runId, em);
      // Already current — the farewell of a session that took a reading and
      // then went unused, or a second turn-end for a transcript nothing has
      // been added to. Asking again would spend two seconds of the user's own
      // agent to write down what is already written down.
      if (this.parseStoredReading(run.lastMetricsReading, atSeq) !== null) {
        return;
      }
      const agent = await this.readFromAgent(runId, run.agentKind, em);
      if (agent.context === null && agent.plan === null) {
        return;
      }
      await this.store(runId, atSeq, agent.context, agent.plan);
    } catch (err) {
      this.logger.warn(
        `the last reading for run ${runId} could not be taken: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
    const reading = this.adapters.for(agentKind).getConfig().usage[field];
    return reading.kind === 'unavailable' ? reading.reason : null;
  }
}

/**
 * How long a stored PLAN reading may be served as though it were current.
 *
 * The shortcut above is guarded by `atSeq` alone, and that guard is exactly
 * right for the CONTEXT half: a window is a function of the conversation, so a
 * transcript that has not moved holds a context that has not moved either. It
 * says nothing at all about an ALLOWANCE, which moves with wall-clock time and
 * with every turn the account spends in another chat, another terminal or
 * another machine — none of which writes a row here.
 *
 * So a chat nobody has typed in keeps its `atSeq` forever and served its plan
 * figures forever. REPORTED as "I STILL have team session", against a panel
 * reading `TEAM · Current week 100% · resets in 1d 15h`. Reconstructed from
 * the reporter's own `geniro.db`: six runs held a stored `plan: "team"` at
 * 100%, every one of them still servable (`atSeq === maxSeq`), with `takenAt`
 * up to twelve hours old — while the same profile, asked live, answered
 * `subscription_type: "max"` with its week at 1%. The account had changed and
 * the week had rolled; nothing in the guard could notice either.
 *
 * Two minutes keeps what the shortcut was FOR — a second open moments after
 * the first, which is the reported "too slow when i hover" — and bounds the
 * lie to a window in which an allowance cannot meaningfully move. Past it the
 * reading is taken again, which is what every open cost before the shortcut
 * existed.
 *
 * A reading served with NO live process is a different case and is not bounded
 * here: that path stamps `takenAt` and the panel dates it out loud, so it is
 * offered as the last thing anyone measured rather than as the present.
 */
const STORED_PLAN_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * Whether a stored reading's PLAN half may still be presented as current.
 *
 * True when there is no plan half at all: the bound exists to stop a stale
 * allowance being served, and a reading that carries none has none to serve —
 * refusing it there would cost every CLI that reports no allowance the whole
 * shortcut, for a figure it never had.
 */
function planReadingIsCurrent(
  reading: StoredMetricsReading,
  now: number,
): boolean {
  if (reading.plan === null) {
    return true;
  }
  const takenAt = Date.parse(reading.takenAt);
  // An unparseable stamp is not evidence of freshness. It cannot be dated, so
  // it cannot be claimed to be current.
  return Number.isFinite(takenAt) && now - takenAt <= STORED_PLAN_MAX_AGE_MS;
}

/** Which of the adapter's two declared readings to consult. */
type DeclaredReasonField = 'breakdown' | 'planLimits';

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
    'the agent did not answer in time — the reading is taken again while this stays open',
};

const PLAN_ABSENCE: AbsenceSentences = {
  noSingleAgent:
    'this run names no single agent, so there is no one account whose limits it could report',
  noLiveProcess:
    'plan limits are read from the running agent — send a message in this chat to take a fresh reading',
  noAnswer:
    'the agent did not answer the usage request in time — the reading is taken again while this stays open',
};
