import {
  type HostRowWire,
  type HostWake,
  SINGLE_AGENT_NODE,
} from '../../agents/chat.types';

/**
 * A wake of the manager chat for one thing it must hear about. `key` names
 * that thing, so a newer wake about it replaces one still held.
 */
export function managerWake(
  managerRunId: string,
  key: string,
  prompt: string,
  message: string,
  fields?: Pick<HostRowWire, 'threadDone'>,
): HostWake {
  return {
    key: `command-center:${key}`,
    owner: {
      target: 'chat',
      runId: managerRunId,
      memberId: SINGLE_AGENT_NODE,
      conversationId: null,
      caller: SINGLE_AGENT_NODE,
    },
    prompt,
    row: { severity: 'info', message, woke: true, ...fields },
    note: prompt,
    onDelivered: () => undefined,
  };
}
