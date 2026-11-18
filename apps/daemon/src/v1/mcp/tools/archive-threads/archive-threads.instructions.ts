import {
  HOST_ARCHIVE_THREADS_TOOL,
  TELL_THREADS_MAX_TARGETS,
} from '../../../agents/chat.types';

/** What the manager reads about `archive_threads`. */
export function archiveThreadsInstructions(): string {
  return (
    `Archive 1–${TELL_THREADS_MAX_TARGETS} threads on your roster in a single call, exactly as the user archives one from the sidebar: a running turn is stopped, every process the thread left running is ended, and the thread is shelved with all its history kept — the user can unarchive it. It is never deleted. ` +
    `Call ${HOST_ARCHIVE_THREADS_TOOL} ONLY when the user asked, in their own words, to archive the threads in question — never on your own judgement that a thread looks finished or idle. ` +
    'Name each thread by its roster handle (t3), its id, or its exact title. When any name is ambiguous or matches no roster thread, NOTHING is archived: the answer lists each unresolved name with its candidates — ask the user which they meant instead of guessing. ' +
    'For each thread the answer says `archived`, `already_archived`, or `refused` with a code. Tell the user which threads you archived.'
  );
}
