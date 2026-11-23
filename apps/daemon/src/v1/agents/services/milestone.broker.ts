import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { ItemKind } from '../../runs/runs.types';
import {
  type ItemWire,
  MILESTONE_RUN_CAP,
  type MilestoneInput,
  type MilestonePayload,
  type MilestoneWriteOutcome,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { asRecord, asString, parseJsonColumn } from '../utils/json-util';
import { KeyedChain } from '../utils/keyed-chain';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/** The conversation behind a `milestone` call. */
export interface MilestoneWriter {
  memberId: string;
  /** Null for the member's own conversation. */
  conversationId: string | null;
  /** The call that conversation is answering right now, if any. */
  callId: string | null;
}

/**
 * One agent's end of `milestone`, installed by whatever runs it — a team pass
 * for each member, a chat for its agent: the run's seq-allocating write, and
 * which conversation a caller key is. The same shape as `record_outcome`'s
 * sink, so one sink serves both.
 */
export interface MilestoneSink {
  persistItem(
    memberId: string | null,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): Promise<ItemWire>;
  recorder(caller: string): MilestoneWriter;
}

/**
 * `milestone`: an agent records one important step of its work — a `milestone`
 * row, drawn on the thread's timeline and as a compact transcript row, filed
 * in the call its conversation answers like a team note. Writes of one run are
 * serialized, so the cap and the repeat check hold under racing calls.
 */
@Injectable()
export class MilestoneBroker extends HostSinkBroker<MilestoneSink> {
  private readonly writes = new KeyedChain();

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
  ) {
    super();
  }

  /** Whether this member is offered `milestone`. */
  canUse(runId: string, memberId: string): boolean {
    return this.has(runId, memberId);
  }

  async record(
    runId: string,
    memberId: string,
    caller: string,
    input: MilestoneInput,
  ): Promise<MilestoneWriteOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      memberId,
      'no turn is running that could record it',
      'record a step',
      (sink) =>
        this.writes.run(runId, () =>
          this.recordNow(runId, memberId, caller, input, sink),
        ),
    );
  }

  forgetRun(runId: string): void {
    this.writes.forget(runId);
  }

  private async recordNow(
    runId: string,
    memberId: string,
    caller: string,
    input: MilestoneInput,
    sink: MilestoneSink,
  ): Promise<MilestoneWriteOutcome> {
    const steps = await this.itemDao.newestRowsOfKinds(
      runId,
      ['milestone'],
      MILESTONE_RUN_CAP,
      this.em.fork(),
    );
    if (steps.length >= MILESTONE_RUN_CAP) {
      return {
        status: 'refused',
        reason: `this run already holds ${MILESTONE_RUN_CAP} steps, the limit — record only the steps that matter`,
      };
    }
    const writer = sink.recorder(caller);
    const newest = steps
      .map((row) => ({
        seq: row.seq,
        payload: asRecord(parseJsonColumn(row.payload)),
      }))
      .filter(
        ({ payload }) =>
          asString(payload?.nodeId) === writer.memberId &&
          (asString(payload?.conversationId) ?? null) === writer.conversationId,
      )
      .at(-1);
    if (
      newest !== undefined &&
      newest.payload?.text === input.text &&
      newest.payload?.kind === input.kind
    ) {
      return { status: 'unchanged', seq: newest.seq };
    }
    const payload: MilestonePayload = {
      text: input.text,
      kind: input.kind,
      nodeId: writer.memberId,
      conversationId: writer.conversationId,
      ...(writer.callId === null ? {} : { callId: writer.callId }),
    };
    const item = await sink.persistItem(memberId, 'milestone', null, payload);
    return { status: 'recorded', seq: item.seq };
  }
}
