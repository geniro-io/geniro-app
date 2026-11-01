import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type {
  ActionOutcomePayload,
  ActionPayload,
  ItemWire,
  LiveAction,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { type ActionFold, foldActions } from '../utils/action-fold';
import { persistItemAndEmit } from '../utils/persist-item';
import { AgentEventBus } from './agent-events.bus';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';

/**
 * The buttons a run's agents published that can still be pressed — served on
 * run state, so the shelf and the transcript card agree with the press route
 * whatever window of rows a client holds. Folded from the whole run on every
 * read: a run holds a handful of these rows, read off the `(runId, kind, seq)`
 * index.
 *
 * Also the one writer of `action` / `action_outcome` rows, and the per-run
 * lock every publish and press takes: the cap and the "is this seq still the
 * live one" check are read-then-write, and one daemon serves the desktop and a
 * paired phone alike, so an in-process chain is the whole of the serialisation.
 */
@Injectable()
export class ChatActionsService {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly bus: AgentEventBus,
    private readonly calls: ItemCallIndexService,
    private readonly seqs: ItemSeqAllocator,
  ) {}

  async live(runId: string, em?: EntityManager): Promise<LiveAction[]> {
    return (await this.fold(runId, em)).live;
  }

  async fold(runId: string, em?: EntityManager): Promise<ActionFold> {
    return foldActions(
      await this.itemDao.rowsOfKinds(
        runId,
        ['action', 'action_outcome'],
        undefined,
        em ?? this.em.fork(),
      ),
    );
  }

  /** Runs `work` after every earlier publish or press of this run has finished. */
  async serialize<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const link = next.catch(() => undefined);
    this.chains.set(runId, link);
    try {
      return await next;
    } finally {
      if (this.chains.get(runId) === link) {
        this.chains.delete(runId);
      }
    }
  }

  async appendAction(
    runId: string,
    memberId: string | null,
    payload: ActionPayload,
  ): Promise<ItemWire> {
    return this.append(runId, memberId, 'action', payload);
  }

  async appendOutcome(
    runId: string,
    memberId: string | null,
    payload: ActionOutcomePayload,
  ): Promise<ItemWire> {
    return this.append(runId, memberId, 'action_outcome', payload);
  }

  private async append(
    runId: string,
    memberId: string | null,
    kind: 'action' | 'action_outcome',
    payload: ActionPayload | ActionOutcomePayload,
  ): Promise<ItemWire> {
    return persistItemAndEmit(
      {
        itemDao: this.itemDao,
        bus: this.bus,
        calls: this.calls,
        seqs: this.seqs,
      },
      this.em.fork(),
      {
        runId,
        memberId,
        seq: await this.seqs.reserve(runId),
        kind,
        role: null,
        payload,
      },
    );
  }
}
