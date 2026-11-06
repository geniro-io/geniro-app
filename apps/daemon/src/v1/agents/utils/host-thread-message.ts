import type { EntityManager } from '@mikro-orm/sqlite';

import { HOST_MESSAGE_THREAD_TOOL } from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names `message_thread`. Used only to draw its
 * card: the tool is never auto-approved, because the card is the user's one
 * look at text leaving this thread for another.
 */
export function isHostThreadMessageCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_MESSAGE_THREAD_TOOL);
}

/**
 * The target's title for a `message_thread` card, spread into the
 * `approval_request` row. Empty for any other call, for a call whose input
 * names no thread, and when the read fails: a throw here would refuse the call.
 */
export async function threadCardFields(
  runDao: RunDao,
  em: EntityManager,
  serverName: string | null,
  toolName: string,
  input: unknown,
): Promise<{ threadTitle?: string }> {
  if (!isHostThreadMessageCall(serverName, toolName)) {
    return {};
  }
  const thread =
    typeof input === 'object' && input !== null && 'thread' in input
      ? input.thread
      : null;
  if (typeof thread !== 'string') {
    return {};
  }
  try {
    const run = await runDao.getById(thread, em);
    return run === null ? {} : { threadTitle: run.title ?? 'Untitled thread' };
  } catch {
    return {};
  }
}
