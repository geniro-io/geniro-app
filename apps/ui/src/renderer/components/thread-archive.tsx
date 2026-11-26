import { Archive, ArchiveRestore } from 'lucide-react';
import { createContext, useContext } from 'react';

import { ThreadActionButton, ThreadHeadIcon } from './thread-head';
import { Badge } from './ui/badge';

/**
 * The archive a screen offers for a thread it shows: an action that asks
 * before it archives, or null where that thread cannot be archived from here.
 */
export type ThreadArchiveOf = (runId: string) => (() => void) | null;

/**
 * Provided by the command center around its graph, its cards and its manager
 * chat. Where no provider stands (the Chats page), no archive control is drawn.
 */
export const ThreadArchiveContext = createContext<ThreadArchiveOf | null>(null);

/** The unarchive a screen offers for a thread it shows, or null where it cannot be put back from here. */
export type ThreadUnarchiveOf = (runId: string) => (() => void) | null;

export const ThreadUnarchiveContext = createContext<ThreadUnarchiveOf | null>(
  null,
);

/** The unarchive action for one thread, or null where none is offered. */
export function useThreadUnarchive(
  runId: string | null | undefined,
): (() => void) | null {
  const unarchiveOf = useContext(ThreadUnarchiveContext);
  return unarchiveOf === null || runId === null || runId === undefined
    ? null
    : unarchiveOf(runId);
}

/** The archive action for one thread, or null where none is offered. */
export function useThreadArchive(
  runId: string | null | undefined,
): (() => void) | null {
  const archiveOf = useContext(ThreadArchiveContext);
  return archiveOf === null || runId === null || runId === undefined
    ? null
    : archiveOf(runId);
}

/** Archive a thread from the quiet icons at the end of its head. */
export function ArchiveThreadIcon({
  title,
  onArchive,
}: {
  title: string;
  onArchive: () => void;
}): React.JSX.Element {
  return (
    <ThreadHeadIcon
      slot="thread-head-archive"
      label={`Archive ${title}`}
      title="Archive"
      icon={<Archive aria-hidden="true" />}
      onClick={onArchive}
    />
  );
}

/** The Archive a finished thread offers in plain sight. */
export function ArchiveThreadButton({
  slot,
  title,
  onArchive,
}: {
  slot: string;
  title: string;
  onArchive: () => void;
}): React.JSX.Element {
  return (
    <ThreadActionButton
      slot={slot}
      label={`Archive ${title}`}
      title="Archive this finished thread"
      icon={<Archive aria-hidden="true" />}
      onClick={() => onArchive()}>
      Archive
    </ThreadActionButton>
  );
}

/** The mark a thread that was archived wears where it is still shown. */
export function ArchivedThreadBadge(): React.JSX.Element {
  return (
    <Badge data-slot="thread-archived-badge" variant="muted">
      Archived
    </Badge>
  );
}

/** Put an archived thread back. */
export function UnarchiveThreadButton({
  slot,
  title,
  onUnarchive,
}: {
  slot: string;
  title: string;
  onUnarchive: () => void;
}): React.JSX.Element {
  return (
    <ThreadActionButton
      slot={slot}
      label={`Unarchive ${title}`}
      title="Put this thread back"
      icon={<ArchiveRestore aria-hidden="true" />}
      onClick={() => onUnarchive()}>
      Unarchive
    </ThreadActionButton>
  );
}
