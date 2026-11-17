import type { Run } from '../../runs/entity/run.entity';
import { HOST_NOTE_THREAD_TOOL, HOST_TELL_THREADS_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/** Whether a run is the command center's manager chat. */
export function isCommandCenterChat(run: Pick<Run, 'commandCenter'>): boolean {
  return run.commandCenter === true;
}

/**
 * Whether a permission request names one of the manager's messaging tools,
 * `tell_threads` or `note_thread`. Auto-approved in the manager's chat only
 * (user decision): there the user delegated messaging the threads it manages,
 * and every send is a row with the manager as sender on both transcripts.
 * `start_thread` is not here — it keeps the chat's ordinary permission card.
 */
export function isHostCommandCenterMessageCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return (
    isHostToolCall(serverName, toolName, HOST_TELL_THREADS_TOOL) ||
    isHostToolCall(serverName, toolName, HOST_NOTE_THREAD_TOOL)
  );
}
