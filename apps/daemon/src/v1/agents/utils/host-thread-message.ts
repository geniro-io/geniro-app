import type { EntityManager } from '@mikro-orm/sqlite';

import { HOST_MESSAGE_THREAD_TOOL } from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import { hostToolArguments, isHostToolCall } from './host-tool';
import { asRecord } from './json-util';

/**
 * Whether a permission request names `message_thread`. Used only to draw its
 * card: outside `auto` that card is the user's one look at text leaving this
 * thread for another, so the tool joins no auto-approval list.
 */
export function isHostThreadMessageCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_MESSAGE_THREAD_TOOL);
}

/**
 * The target's title and the text for a `message_thread` card, spread into the
 * `approval_request` row. Empty for any other call, for a call whose input
 * names no thread, and when the read fails: a throw here would refuse the call.
 */
export async function threadCardFields(
  runDao: RunDao,
  em: EntityManager,
  serverName: string | null,
  toolName: string,
  input: unknown,
): Promise<{ threadTitle?: string; threadText?: string }> {
  if (!isHostThreadMessageCall(serverName, toolName)) {
    return {};
  }
  const call = asRecord(hostToolArguments(input, HOST_MESSAGE_THREAD_TOOL));
  if (typeof call?.thread !== 'string') {
    return {};
  }
  try {
    const run = await runDao.getById(call.thread, em);
    if (run === null) {
      return {};
    }
    return {
      threadTitle: run.title ?? 'Untitled thread',
      ...(typeof call.message === 'string' ? { threadText: call.message } : {}),
    };
  } catch {
    return {};
  }
}
