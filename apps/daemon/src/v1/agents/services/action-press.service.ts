import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, ConflictException } from '@packages/common';

import type {
  ActionOutcomePayload,
  ActionPressResult,
  ActionPressWire,
  ActionSpec,
  ActionVia,
  LiveAction,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';
import type { ActionFold } from '../utils/action-fold';
import { assertChatRun, assertWorkflowRun } from '../utils/run-kind';
import { ActionStopService } from './action-stop.service';
import { ChatService } from './chat.service';
import { ChatActionsService } from './chat-actions.service';

/**
 * Sends a press's prepared message into the conversation the run talks to.
 * `action` is the button pressed, for a run whose delivery says who published
 * it.
 */
export type DeliverMessage = (
  text: string,
  clientMessageId: string,
  action: LiveAction,
) => Promise<unknown>;

/**
 * Which route a press or dismissal came in on: each refuses the other kind of
 * run, whose delivery it does not know.
 */
export type ActionRunKind = 'chat' | 'workflow';

export interface ActionPressInput {
  run: ActionRunKind;
  /** The id a re-press after `RUN_BUSY` repeats, so the message is sent once. */
  clientMessageId: string;
  via: ActionVia;
  deliverMessage: DeliverMessage;
}

type ActionExecutor = (
  action: LiveAction,
  input: ActionPressInput,
) => Promise<Pick<ActionOutcomePayload, 'state'>>;

/**
 * What a press does inside the run's lock, by kind. `stop` is not here: it
 * waits out a grace period, so it runs outside the lock ({@link
 * ActionPressService.pressStop}). A kind with neither is refused at the press.
 */
const EXECUTORS: Partial<Record<ActionSpec['kind'], ActionExecutor>> = {
  message: async (action, input) => {
    // A busy chat either takes the text into its running turn or answers
    // RUN_BUSY; the latter propagates with nothing written, so the client
    // presses the same seq again once the turn settles.
    await input.deliverMessage(
      action.spec.text ?? '',
      input.clientMessageId,
      action,
    );
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
  /**
   * Stop presses under way, by `actionSlot`. Held in memory, not as a
   * `running` row: a daemon that dies mid-stop must not leave the button
   * pending for good, and a stop outlives no process.
   */
  private readonly stopping = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly actions: ChatActionsService,
    /** One way only, as `ChatShellsService` holds it: nothing in `ChatService` knows this service. */
    private readonly chats: ChatService,
    private readonly stops: ActionStopService,
  ) {}

  /** A press in a 1:1 chat: the message goes to the chat's own agent. */
  async pressChat(
    runId: string,
    seq: number,
    clientMessageId: string,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    return this.press(runId, seq, {
      run: 'chat',
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
    await this.assertPressable(runId, input.run);
    const pressed = await this.actions.serialize(
      runId,
      async (): Promise<ActionPressWire | LiveAction> => {
        const action = await this.liveAt(runId, seq);
        if (action.spec.kind === 'stop') {
          this.stopping.add(actionSlot(runId, seq));
          return action;
        }
        const execute = EXECUTORS[action.spec.kind];
        if (execute === undefined) {
          throw new BadRequestException(
            'ACTION_KIND_UNAVAILABLE',
            `${action.spec.kind} actions cannot be pressed yet`,
          );
        }
        const { state } = await execute(action, input);
        return {
          outcome: await this.record(runId, action, { state }, input.via),
        };
      },
    );
    return 'outcome' in pressed
      ? pressed
      : this.pressStop(runId, pressed, input.via);
  }

  /**
   * The stop itself, outside the lock it was claimed under: other buttons of
   * the run stay pressable meanwhile, and this one answers `ACTION_BUSY`.
   */
  private async pressStop(
    runId: string,
    action: LiveAction,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    try {
      const result = await this.stops.stop(runId, action.spec);
      return await this.actions.serialize(runId, async () => {
        // The agent may remove or replace the button while it stops; a failure
        // written after that would make the old publish pressable again.
        const fold = await this.actions.fold(runId);
        if (
          result.state !== 'stopped' &&
          !fold.live.some((entry) => entry.seq === action.seq)
        ) {
          throw notLive(
            fold,
            action.seq,
            `; the stop did not happen: ${result.error ?? 'nothing was stopped'}`,
          );
        }
        return { outcome: await this.record(runId, action, result, via) };
      });
    } finally {
      this.stopping.delete(actionSlot(runId, action.seq));
    }
  }

  /** {@link dismiss} on the chat route, which a workflow run has its own of. */
  async dismissChat(
    runId: string,
    seq: number,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    return this.dismiss(runId, seq, via, 'chat');
  }

  /** Takes a button off the chat without running it; the agent is not told. */
  async dismiss(
    runId: string,
    seq: number,
    via: ActionVia,
    run: ActionRunKind,
  ): Promise<ActionPressWire> {
    await this.assertPressable(runId, run);
    return this.actions.serialize(runId, async () => {
      const action = await this.liveAt(runId, seq);
      return {
        outcome: await this.record(runId, action, { state: 'dismissed' }, via),
      };
    });
  }

  /**
   * The run is of the kind its route serves, and not archived — an archived
   * chat is inert: its buttons are neither pressed nor dismissed.
   */
  private async assertPressable(
    runId: string,
    kind: ActionRunKind,
  ): Promise<void> {
    const found = await this.runDao.getById(runId, this.em.fork());
    const run =
      kind === 'chat'
        ? assertChatRun(found, runId)
        : assertWorkflowRun(found, runId);
    if (run.archivedAt !== null) {
      throw new ConflictException(
        'RUN_ARCHIVED',
        `this ${kind === 'chat' ? 'chat' : 'run'} is archived — unarchive it to use its actions`,
      );
    }
  }

  private async liveAt(runId: string, seq: number): Promise<LiveAction> {
    const fold = await this.actions.fold(runId);
    const action = fold.live.find((entry) => entry.seq === seq);
    if (action === undefined) {
      throw notLive(fold, seq);
    }
    if (action.pending || this.stopping.has(actionSlot(runId, seq))) {
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
    result: ActionPressResult,
    via: ActionVia,
  ): Promise<ActionOutcomePayload> {
    const outcome: ActionOutcomePayload = {
      actionSeq: action.seq,
      actionId: action.actionId,
      nodeId: action.nodeId,
      conversationId: action.conversationId,
      ...result,
      via,
    };
    // Filed in the run's own flow (`nodeId` null): the user pressed it, and the
    // publishing conversation is named in the payload.
    await this.actions.appendOutcome(runId, null, outcome);
    return outcome;
  }
}

/**
 * Why the publish at `seq` is not live: the agent republished its id, or it
 * is gone. `detail` follows the reason.
 */
function notLive(
  fold: ActionFold,
  seq: number,
  detail = '',
): ConflictException {
  const key = fold.keyOfSeq.get(seq);
  const replaced =
    key !== undefined &&
    fold.live.some(
      (entry) => fold.keyOfSeq.get(entry.seq) === key && entry.seq !== seq,
    );
  return replaced
    ? new ConflictException(
        'ACTION_CHANGED',
        `the agent has changed this action since it was shown${detail}`,
      )
    : new ConflictException(
        'ACTION_GONE',
        `this action is no longer live${detail}`,
      );
}

function actionSlot(runId: string, seq: number): string {
  return `${runId}\u0000${seq}`;
}
