import { ArrowUpRight } from 'lucide-react';
import { createContext, useContext } from 'react';

import type { ProfileColor } from '../../shared/contracts';
import { cn } from '../components/ui/utils';

/**
 * Opens another thread by its run id, as the sidebar opens one — or null where
 * a thread cannot be opened (a hosted view), so a thread's title is plain text.
 */
export const ThreadOpenContext = createContext<
  ((runId: string) => void) | null
>(null);

/** Who a thread is, as the command center's canvas shows it. */
export interface ThreadIdentity {
  title: string;
  project: string | null;
  projectColor: ProfileColor | null;
  /** The agent's short name, or the team's name for a team run. */
  agentLabel: string | null;
  isTeam: boolean;
}

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
const CHIP_CLASS =
  'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground';
const CHIP_LINK_CLASS =
  'cursor-pointer text-left hover:bg-accent hover:text-accent-foreground';

/** A thread's title, a press away from that thread where the view can open one. */
export function ThreadTitle({
  runId,
  title,
  chip = false,
}: {
  runId: string;
  title: string;
  chip?: boolean;
}): React.JSX.Element {
  const open = useContext(ThreadOpenContext);
  const label = chip ? (
    <span className="min-w-0 truncate">{title}</span>
  ) : (
    title
  );
  if (open === null) {
    return <span className={chip ? CHIP_CLASS : PLAIN_CLASS}>{label}</span>;
  }
  return (
    <button
      type="button"
      data-slot="thread-title"
      title="Open this thread"
      className={chip ? cn(CHIP_CLASS, CHIP_LINK_CLASS) : LINK_CLASS}
      onClick={() => open(runId)}>
      {label}
      {chip ? (
        <ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
      ) : null}
    </button>
  );
}
