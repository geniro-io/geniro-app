import type { CommandEnding } from '../adapters/adapter.types';
import { type HostWakeOwner, SINGLE_AGENT_NODE } from '../chat.types';
import {
  commandEndWakeMessage,
  commandEndWakePrompt,
} from '../utils/command-end-wake-text';
import { HostWakeBus, hostWakeSessionKey } from './host-wake.bus';

export const COMMAND_END_WAKE_BATCH_MS = 2_000;

export const MAX_COMMAND_END_WAKES = 3;

export interface CommandEndWakeOptions {
  batchMs?: number;
  now?: () => number;
}

export function chatWakeOwner(runId: string): HostWakeOwner {
  return {
    runId,
    memberId: SINGLE_AGENT_NODE,
    conversationId: null,
    caller: SINGLE_AGENT_NODE,
    target: 'chat',
  };
}

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
 * The CLI hands an ended command to its agent at the end of the next prompt
 * (`AdapterConfig.shells.lateEndWakeReason`), so an end that a turn's own end
 * or start covers wakes nothing: no wake is queued behind or kept past a turn.
 */
export class CommandEndWakeService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly turnsEnded = new Map<
    string,
    { runId: string; at: number }
  >();
  private readonly batchMs: number;
  private readonly now: () => number;

  constructor(
    private readonly bus: HostWakeBus,
    options: CommandEndWakeOptions = {},
  ) {
    this.batchMs = options.batchMs ?? COMMAND_END_WAKE_BATCH_MS;
    this.now = options.now ?? Date.now;
  }

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
    if (
      conversation.stoppedByUser.delete(workId) ||
      turnRunning() ||
      this.endedWithinLastTurn(key, ending)
    ) {
      return;
    }
    conversation.ended.set(workId, ending);
    if (conversation.timer === null) {
      conversation.timer = setTimeout(() => this.publish(key), this.batchMs);
      conversation.timer.unref?.();
    }
  }

  turnStarted(owner: HostWakeOwner): void {
    const conversation = this.conversations.get(hostWakeSessionKey(owner));
    if (conversation === undefined) {
      return;
    }
    conversation.turnsStarted += 1;
    conversation.ended.clear();
    this.clearTimer(conversation);
  }

  turnEnded(owner: HostWakeOwner): void {
    this.turnsEnded.set(hostWakeSessionKey(owner), {
      runId: owner.runId,
      at: this.now(),
    });
  }

  userSpoke(runId: string): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.owner.runId === runId) {
        conversation.wakesInARow = 0;
      }
    }
  }

  stoppedByUser(owner: HostWakeOwner, workId: string): void {
    const conversation = this.conversationOf(owner);
    conversation.ended.delete(workId);
    conversation.stoppedByUser.add(workId);
  }

  forgetRun(runId: string): void {
    for (const [key, conversation] of this.conversations) {
      if (conversation.owner.runId === runId) {
        this.clearTimer(conversation);
        this.conversations.delete(key);
      }
    }
    for (const [key, ended] of this.turnsEnded) {
      if (ended.runId === runId) {
        this.turnsEnded.delete(key);
      }
    }
  }

  private endedWithinLastTurn(key: string, ending: CommandEnding): boolean {
    const turnEnded = this.turnsEnded.get(key)?.at;
    const endedMs = Date.parse(ending.endedAt ?? '');
    return turnEnded !== undefined && endedMs <= turnEnded;
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
