import {
  HOST_NOTIFY_TOOL,
  type HostNotifyOutcome,
  MAX_NOTIFY_MESSAGE_LENGTH,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/** Whether a tool call is geniro's own `notify_user` on this run's server. */
export function isHostNotifyCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_NOTIFY_TOOL);
}

/**
 * The message out of a `notify_user` call, trimmed and capped, or null when
 * there is none — a banner with nothing in it is only ever a mistake, so it is
 * answered as a malformed call rather than sent.
 */
export function readHostNotify(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return null;
  }
  const { message } = args as { message?: unknown };
  if (typeof message !== 'string') {
    return null;
  }
  const trimmed = message.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_NOTIFY_MESSAGE_LENGTH);
}

/** The receipt the agent reads back — never the message itself. */
export function hostNotifyResultText(outcome: HostNotifyOutcome): string {
  if (outcome.status === 'unavailable') {
    return `The notification could not be sent (${outcome.reason}). Say it in your reply instead.`;
  }
  return 'Notification sent to the user. Do not send another for the same thing.';
}
