import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import type {
  ActionOutcomePayload,
  ActionPressWire,
  ActionSpec,
  ActionVia,
  LiveAction,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';
import { ChatService } from './chat.service';
import { ChatActionsService } from './chat-actions.service';

/** Sends a press's prepared message into the conversation the run talks to. */
export type DeliverMessage = (
  text: string,
  clientMessageId: string,
) => Promise<unknown>;

export interface ActionPressInput {
  /** The id a re-press after `RUN_BUSY` repeats, so the message is sent once. */
  clientMessageId: string;
  via: ActionVia;
  deliverMessage: DeliverMessage;
}

type ActionExecutor = (
  action: LiveAction,
  input: ActionPressInput,
) => Promise<Pick<ActionOutcomePayload, 'state'>>;

/** What a press does, by kind. A kind with no entry is refused at the press. */
const EXECUTORS: Partial<Record<ActionSpec['kind'], ActionExecutor>> = {
  message: async (action, input) => {
    // A busy chat either takes the text into its running turn or answers
    // RUN_BUSY; the latter propagates with nothing written, so the client
    // presses the same seq again once the turn settles.
    await input.deliverMessage(action.spec.text ?? '', input.clientMessageId);
    return { state: 'succeeded' };
  },
};

/**
 * A user's press or dismissal of an agent's button. Every check is made
 * against the live set read inside the run's lock, so a press addressed to a
 * publish the agent has since replaced is refused rather than run against
 * whatever replaced it.
 */
@Injectable()
export class ActionPressService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly actions: ChatActionsService,
    /** One way only, as `ChatShellsService` holds it: nothing in `ChatService` knows this service. */
    private readonly chats: ChatService,
  ) {}

  /** A press in a 1:1 chat: the message goes to the chat's own agent. */
  async pressChat(
    runId: string,
    seq: number,
    clientMessageId: string,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    return this.press(runId, seq, {
      clientMessageId,
      via,
      deliverMessage: (text, id) =>
        this.chats.sendMessage(runId, text, [], { clientMessageId: id }),
    });
  }

  async press(
    runId: string,
    seq: number,
    input: ActionPressInput,
  ): Promise<ActionPressWire> {
    await this.assertPressable(runId);
    return this.actions.serialize(runId, async () => {
      const action = await this.liveAt(runId, seq);
      const execute = EXECUTORS[action.spec.kind];
      if (execute === undefined) {
        throw new BadRequestException(
          'ACTION_KIND_UNAVAILABLE',
          `${action.spec.kind} actions cannot be pressed yet`,
        );
      }
      const { state } = await execute(action, input);
      return { outcome: await this.record(runId, action, state, input.via) };
    });
  }

  /** Takes a button off the chat without running it; the agent is not told. */
  async dismiss(
    runId: string,
    seq: number,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    await this.assertPressable(runId);
    return this.actions.serialize(runId, async () => {
      const action = await this.liveAt(runId, seq);
      return { outcome: await this.record(runId, action, 'dismissed', via) };
    });
  }

  /** An archived chat is inert: its buttons are neither pressed nor dismissed. */
  private async assertPressable(runId: string): Promise<void> {
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    if (run.archivedAt !== null) {
      throw new ConflictException(
        'RUN_ARCHIVED',
        'this chat is archived — unarchive it to use its actions',
      );
    }
  }

  private async liveAt(runId: string, seq: number): Promise<LiveAction> {
    const { live, keyOfSeq } = await this.actions.fold(runId);
    const action = live.find((entry) => entry.seq === seq);
    if (action === undefined) {
      const key = keyOfSeq.get(seq);
      const replaced =
        key !== undefined &&
        live.some(
          (entry) => keyOfSeq.get(entry.seq) === key && entry.seq !== seq,
        );
      throw replaced
        ? new ConflictException(
            'ACTION_CHANGED',
            'the agent has changed this action since it was shown',
          )
        : new ConflictException('ACTION_GONE', 'this action is no longer live');
    }
    if (action.pending) {
      throw new ConflictException(
        'ACTION_BUSY',
        'this action is already being pressed',
      );
    }
    return action;
  }

  private async record(
    runId: string,
    action: LiveAction,
    state: ActionOutcomePayload['state'],
    via: ActionVia,
  ): Promise<ActionOutcomePayload> {
    const outcome: ActionOutcomePayload = {
      actionSeq: action.seq,
      actionId: action.actionId,
      nodeId: action.nodeId,
      conversationId: action.conversationId,
      state,
      via,
    };
    // Filed in the run's own flow (`nodeId` null): the user pressed it, and the
    // publishing conversation is named in the payload.
    await this.actions.appendOutcome(runId, null, outcome);
    return outcome;
  }
}
