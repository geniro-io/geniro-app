import {
  HOST_ARCHIVE_THREADS_TOOL,
  HOST_TELL_THREADS_TOOL,
} from '../../../agents/chat.types';

/** What the manager reads about `read_command_center`. */
export function readCommandCenterInstructions(): string {
  return (
    'Read the command center graph as it stands now: every active thread with its roster handle, title, project, board column (working, waiting, idle, in_review, done), status, what it waits on, whether you await its reply, its pull request, its board card, its last activity and your note. Finished threads stay on the graph, listed last, until they are archived. ' +
    `Use it whenever you need the current picture rather than your last status table — before deciding which threads the user means, before ${HOST_TELL_THREADS_TOOL}, and before ${HOST_ARCHIVE_THREADS_TOOL}. It only reads; it changes nothing.`
  );
}
