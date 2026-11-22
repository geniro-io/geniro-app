import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import { AgentFlag } from '../../runs/entity/agent-flag.entity';
import {
  AGENT_FLAGS_PER_CONVERSATION,
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

  forgetRun(runId: string): void {
    this.writes.forget(runId);
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
    const seq = await this.itemDao.maxSeq(runId, em);
    const flag = Object.assign(new AgentFlag(), {
      runId,
      seq: Math.max(seq, 0),
      occurredAt: new Date(),
      memberId: raiser.memberId,
      conversationId: raiser.conversationId,
      callId: raiser.callId,
      agentKind: raiser.agentKind ?? run?.agentKind ?? null,
      model: raiser.model ?? run?.model ?? null,
      teamSlug: run?.teamId ?? null,
      projectId: run?.projectId ?? null,
      runKind: run === null ? 'chat' : agentFlagRunKindOf(run),
      runTitle: run?.title == null ? null : redactSecrets(run.title),
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
