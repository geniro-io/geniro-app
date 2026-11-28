import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import { AgentFlag } from '../../runs/entity/agent-flag.entity';
import type { Run } from '../../runs/entity/run.entity';
import {
  AGENT_FLAGS_PER_CONVERSATION,
  type AutomaticFlagInput,
  type FlagIssueInput,
  type FlagIssueOutcome,
} from '../chat.types';
import { AgentFlagDao } from '../dao/agent-flag.dao';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import {
  agentFlagRunKindOf,
  flagSummaryKey,
  newAgentFlagHandle,
} from '../utils/agent-flags';
import { KeyedChain } from '../utils/keyed-chain';
import { librarySlugOf } from '../utils/run-kind';
import { AgentEventBus } from './agent-events.bus';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/** Who raises a flag: what only the pass running the agent knows. */
export interface FlagRaiser {
  memberId: string;
  /** Null for the member's own conversation. */
  conversationId: string | null;
  /** The call that conversation is answering right now, if any. */
  callId: string | null;
  /** Null reads the run's own, as a chat's agent is. */
  agentKind: string | null;
  model: string | null;
}

/** One agent's end of `flag_issue`, installed by whatever runs it — a chat or a team pass. */
export interface FlagSink {
  raiser(caller: string): FlagRaiser;
}

/** Tries at a fresh handle before giving up on a collision. */
const HANDLE_ATTEMPTS = 5;

/**
 * `flag_issue`: any agent records a problem that cost work or met the user's
 * disagreement, as one `agent_flags` row every analysis reads first. The row
 * outlives the run; the thread's kind, title, team and project are stamped
 * from the run, and the agent's identity from the sink — never from the
 * arguments.
 */
@Injectable()
export class FlagBroker extends HostSinkBroker<FlagSink> {
  /** Per run, the tail of its write chain, so the cap and the duplicate check hold under racing calls. */
  private readonly writes = new KeyedChain();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly flagDao: AgentFlagDao,
    private readonly bus: AgentEventBus,
  ) {
    super();
  }

  /** Whether this member is offered `flag_issue`. */
  canUse(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  async raise(
    runId: string,
    memberId: string,
    caller: string,
    input: FlagIssueInput,
  ): Promise<FlagIssueOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could record it',
      'record the flag',
      (sink) =>
        this.writes.run(runId, () => this.raiseNow(runId, caller, input, sink)),
    );
  }

  /**
   * A flag the daemon raises itself, from a failure it observed. Needs no sink
   * and counts against no conversation's cap; a cause the run already has is
   * skipped, the unique (runId, autoCause) index holding that across restarts.
   * Never throws: the handle, or null when nothing was written.
   */
  async raiseAutomatic(
    runId: string,
    input: AutomaticFlagInput,
  ): Promise<string | null> {
    try {
      const handle = await this.writes.run(runId, () =>
        this.raiseAutomaticNow(runId, input),
      );
      if (handle !== null) {
        this.bus.publishUsageSignal({
          kind: 'capability',
          runId,
          capability: 'automatic_flag',
          ok: true,
        });
      }
      return handle;
    } catch (err) {
      this.logger.warn(
        `run ${runId}: could not record the automatic flag ${input.cause}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  forgetRun(runId: string): void {
    this.writes.forget(runId);
  }

  private async raiseAutomaticNow(
    runId: string,
    input: AutomaticFlagInput,
  ): Promise<string | null> {
    const em = this.em.fork();
    if (await this.flagDao.hasAutoCause(runId, input.cause, em)) {
      return null;
    }
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      return null;
    }
    const raiser =
      input.memberId === null || input.caller === null
        ? undefined
        : this.sinkOf(runId, input.memberId)?.raiser(input.caller);
    const flag = Object.assign(await this.stamped(runId, run, input.seq, em), {
      memberId: input.memberId,
      conversationId: input.conversationId,
      callId: raiser?.callId ?? null,
      agentKind: raiser?.agentKind ?? run.agentKind ?? null,
      model: raiser?.model ?? run.model ?? null,
      cost: 'work',
      category: 'geniro_tool',
      minutesLost: input.minutesLost,
      summary: redactSecrets(input.summary),
      detail: input.detail === null ? null : redactSecrets(input.detail),
      automatic: true,
      autoCause: input.cause,
    } satisfies Partial<AgentFlag>);
    try {
      return await this.insertWithFreshHandle(flag, em);
    } catch (err) {
      if (
        err instanceof UniqueConstraintViolationException &&
        (await this.flagDao.hasAutoCause(runId, input.cause))
      ) {
        return null;
      }
      throw err;
    }
  }

  private async raiseNow(
    runId: string,
    caller: string,
    input: FlagIssueInput,
    sink: FlagSink,
  ): Promise<FlagIssueOutcome> {
    const em = this.em.fork();
    const raiser = sink.raiser(caller);
    const raised = await this.flagDao.summariesOf(
      runId,
      raiser.memberId,
      raiser.conversationId,
      em,
    );
    if (raised.conversation.length >= AGENT_FLAGS_PER_CONVERSATION) {
      return {
        status: 'refused',
        code: 'FLAG_LIMIT',
        reason: `this conversation has already raised ${AGENT_FLAGS_PER_CONVERSATION} flags; flag only what matters most`,
      };
    }
    const key = flagSummaryKey(input.summary);
    if (raised.run.some((summary) => flagSummaryKey(summary) === key)) {
      return {
        status: 'refused',
        code: 'DUPLICATE_FLAG',
        reason: 'this thread already has a flag with the same summary',
      };
    }
    const run = await this.runDao.getById(runId, em);
    const flag = Object.assign(await this.stamped(runId, run, null, em), {
      memberId: raiser.memberId,
      conversationId: raiser.conversationId,
      callId: raiser.callId,
      agentKind: raiser.agentKind ?? run?.agentKind ?? null,
      model: raiser.model ?? run?.model ?? null,
      cost: input.cost,
      category: input.category,
      minutesLost: input.minutesLost,
      summary: redactSecrets(input.summary),
      detail: input.detail === null ? null : redactSecrets(input.detail),
    });
    const handle = await this.insertWithFreshHandle(flag, em);
    return {
      status: 'recorded',
      handle,
      flagsLeft: AGENT_FLAGS_PER_CONVERSATION - raised.conversation.length - 1,
    };
  }

  /** A new row with what the run stamps on every flag: its seq, kind, title, team and project. */
  private async stamped(
    runId: string,
    run: Run | null,
    seq: number | null,
    em: EntityManager,
  ): Promise<AgentFlag> {
    return Object.assign(new AgentFlag(), {
      runId,
      seq: seq ?? Math.max(await this.itemDao.maxSeq(runId, em), 0),
      occurredAt: new Date(),
      agentKind: run?.agentKind ?? null,
      model: run?.model ?? null,
      teamSlug: librarySlugOf(run?.teamId ?? null),
      projectId: run?.projectId ?? null,
      runKind: run === null ? 'chat' : agentFlagRunKindOf(run),
      runTitle:
        run?.title === null || run?.title === undefined
          ? null
          : redactSecrets(run.title),
    });
  }

  private async insertWithFreshHandle(
    flag: AgentFlag,
    em: EntityManager,
  ): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      const handle = newAgentFlagHandle();
      if ((await this.flagDao.byHandles([handle], em)).length > 0) {
        if (attempt >= HANDLE_ATTEMPTS) {
          throw new Error('no free flag handle');
        }
        continue;
      }
      flag.handle = handle;
      em.persist(flag);
      await em.flush();
      return handle;
    }
  }
}
