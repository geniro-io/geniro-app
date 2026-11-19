import { createContext, useContext } from 'react';

import type { ThreadIdentity } from '../components/thread-head';

/**
 * Opens another thread by its run id, as the sidebar opens one — or null where
 * a thread cannot be opened (a hosted view), so a thread's title is plain text.
 */
export const ThreadOpenContext = createContext<
  ((runId: string) => void) | null
>(null);

/**
 * The threads the view can name the way the canvas does, by run id. Empty
 * where the view knows none, and a thread drawn there stays neutral.
 */
export const ThreadIdentityContext = createContext<
  ReadonlyMap<string, ThreadIdentity>
>(new Map());

export function useThreadIdentity(runId: string): ThreadIdentity | null {
  return useContext(ThreadIdentityContext).get(runId) ?? null;
}

const PLAIN_CLASS = 'min-w-0 break-words font-medium';
const LINK_CLASS =
  'min-w-0 cursor-pointer break-words text-left font-medium underline decoration-dotted underline-offset-2 hover:text-primary';

/** A thread's title, a press away from that thread where the view can open one. */
export function ThreadTitle({
  runId,
  title,
}: {
  runId: string;
  title: string;
}): React.JSX.Element {
  const open = useContext(ThreadOpenContext);
  if (open === null) {
    return <span className={PLAIN_CLASS}>{title}</span>;
  }
  return (
    <button
      type="button"
      data-slot="thread-title"
      title="Open this thread"
      className={LINK_CLASS}
      onClick={() => open(runId)}>
      {title}
    </button>
  );
}
