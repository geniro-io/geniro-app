import type { CommandEnding } from '../adapters/adapter.types';
import { type HostWakeOwner, SINGLE_AGENT_NODE } from '../chat.types';
import {
  commandEndWakeMessage,
  commandEndWakePrompt,
} from '../utils/command-end-wake-text';
import { HostWakeBus, hostWakeSessionKey } from './host-wake.bus';

/** How long the ends of several commands are gathered into one wake. */
export const COMMAND_END_WAKE_BATCH_MS = 2_000;

/** Wakes in a row a conversation gets with no message from the user between. */
export const MAX_COMMAND_END_WAKES = 3;

export interface CommandEndWakeOptions {
  batchMs?: number;
}

/** A chat's own agent, as a command-end wake addresses it. */
export function chatWakeOwner(runId: string): HostWakeOwner {
  return {
    runId,
    memberId: SINGLE_AGENT_NODE,
    conversationId: null,
    caller: SINGLE_AGENT_NODE,
    target: 'chat',
  };
}

/** A team member's own conversation, as a command-end wake addresses it. */
export function memberWakeOwner(
  runId: string,
  memberId: string,
): HostWakeOwner {
  return {
    runId,
    memberId,
    conversationId: null,
    caller: memberId,
    target: 'team',
  };
}

interface Conversation {
  owner: HostWakeOwner;
  turnRunning: () => boolean;
  turnsStarted: number;
  wakesInARow: number;
  stoppedByUser: Set<string>;
  ended: Map<string, CommandEnding>;
  timer: NodeJS.Timeout | null;
}

/**
 * Starts a turn for an agent whose CLI tells it nothing about a command it
 * left running once its turn is over (`AdapterConfig.shells.lateEndWakeReason`,
 * cursor), when that command ends: one wake per conversation for the commands
 * ending close together, published on `HostWakeBus` with no note owed.
 *
 * Measured on cursor 2026.11.05: the CLI hands a finished command to the model
 * at the end of whatever prompt runs next, so an end inside a turn wakes
 * nothing, and a turn starting before the wake is sent withdraws it.
 */
export class CommandEndWakeService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly batchMs: number;

  constructor(
    private readonly bus: HostWakeBus,
    options: CommandEndWakeOptions = {},
  ) {
    this.batchMs = options.batchMs ?? COMMAND_END_WAKE_BATCH_MS;
  }

  /** A command the conversation left running has ended between its turns. */
  ended(
    owner: HostWakeOwner,
    workId: string,
    ending: CommandEnding,
    turnRunning: () => boolean,
  ): void {
    const key = hostWakeSessionKey(owner);
    const conversation = this.conversationOf(owner);
    conversation.owner = owner;
    conversation.turnRunning = turnRunning;
    if (conversation.stoppedByUser.delete(workId) || turnRunning()) {
      return;
    }
    conversation.ended.set(workId, ending);
    if (conversation.timer === null) {
      conversation.timer = setTimeout(() => this.publish(key), this.batchMs);
      conversation.timer.unref?.();
    }
  }

  /** A turn of the conversation has started: the CLI tells it what ended. */
  turnStarted(owner: HostWakeOwner): void {
    const conversation = this.conversations.get(hostWakeSessionKey(owner));
    if (conversation === undefined) {
      return;
    }
    conversation.turnsStarted += 1;
    conversation.ended.clear();
    this.clearTimer(conversation);
  }

  /** The user wrote to the thread: its wakes count from zero again. */
  userSpoke(runId: string): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.owner.runId === runId) {
        conversation.wakesInARow = 0;
      }
    }
  }

  /** The user stopped this command: its end wakes nobody. */
  stoppedByUser(owner: HostWakeOwner, workId: string): void {
    const conversation = this.conversationOf(owner);
    conversation.ended.delete(workId);
    conversation.stoppedByUser.add(workId);
  }

  /** The run was stopped, archived or deleted: nothing of it wakes anyone. */
  forgetRun(runId: string): void {
    for (const [key, conversation] of this.conversations) {
      if (conversation.owner.runId === runId) {
        this.clearTimer(conversation);
        this.conversations.delete(key);
      }
    }
  }

  private publish(key: string): void {
    const conversation = this.conversations.get(key);
    if (conversation === undefined) {
      return;
    }
    conversation.timer = null;
    if (conversation.ended.size === 0) {
      return;
    }
    if (
      conversation.turnRunning() ||
      conversation.wakesInARow >= MAX_COMMAND_END_WAKES
    ) {
      conversation.ended.clear();
      return;
    }
    const carried = new Map(conversation.ended);
    const generation = conversation.turnsStarted;
    this.bus.publish({
      key: `command-end:${key}`,
      owner: conversation.owner,
      prompt: commandEndWakePrompt([...carried.values()]),
      row: {
        severity: 'info',
        message: commandEndWakeMessage(carried.size),
        woke: true,
      },
      note: null,
      onDelivered: () => {
        conversation.wakesInARow += 1;
        for (const workId of carried.keys()) {
          conversation.ended.delete(workId);
        }
      },
      withdrawn: () =>
        this.conversations.get(key) !== conversation ||
        conversation.turnsStarted !== generation,
    });
  }

  private conversationOf(owner: HostWakeOwner): Conversation {
    const key = hostWakeSessionKey(owner);
    const known = this.conversations.get(key);
    if (known !== undefined) {
      return known;
    }
    const created: Conversation = {
      owner,
      turnRunning: () => false,
      turnsStarted: 0,
      wakesInARow: 0,
      stoppedByUser: new Set(),
      ended: new Map(),
      timer: null,
    };
    this.conversations.set(key, created);
    return created;
  }

  private clearTimer(conversation: Conversation): void {
    if (conversation.timer !== null) {
      clearTimeout(conversation.timer);
      conversation.timer = null;
    }
  }
}
