import { NotebookPen } from 'lucide-react';
import { createContext, useContext } from 'react';

import { cn } from '../components/ui/utils';
import { MarkdownContent } from './markdown-content';
import { MessageBubble } from './message-bubble';
import { TeamNoteKindBadge } from './team-note-kind';
import type { TeamNotePayload } from './team-note-payload';

/**
 * Open the run's notes popup with one note picked, by the seq of the row
 * that holds it; null where no popup is mounted.
 */
export const TeamNoteOpenContext = createContext<
  ((seq: number) => void) | null
>(null);

/**
 * A note an agent wrote to the run's team notes (`team_note`), as its row in
 * the author's flow or its call's card. Compact on purpose: the note is for
 * the other agents, and a press opens the notes popup on it, where a
 * person reads them together.
 */
export function TeamNoteRow({
  seq,
  note,
  author,
}: {
  seq: number;
  note: TeamNotePayload;
  /** The writing agent's name, or null when the row is drawn under it already. */
  author: string | null;
}): React.JSX.Element {
  const openNote = useContext(TeamNoteOpenContext);
  const heading = (
    <>
      <NotebookPen className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium">
        {author === null ? 'Team note' : `${author} · team note`}
      </span>
      <TeamNoteKindBadge kind={note.kind} />
      {note.supersedes === null ? null : (
        <span className="whitespace-nowrap">replaces an earlier note</span>
      )}
    </>
  );
  const headingClass =
    'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground';
  return (
    <MessageBubble
      variant="tool"
      className={cn(
        'gap-1.5 text-foreground',
        openNote !== null &&
          'cursor-pointer hover:bg-accent motion-safe:transition-colors',
      )}
      onClick={
        openNote === null
          ? undefined
          : (event) => {
              if ((event.target as Element).closest('a, button') !== null) {
                return;
              }
              if ((window.getSelection()?.toString() ?? '') !== '') {
                return;
              }
              openNote(seq);
            }
      }>
      {openNote === null ? (
        <div className={headingClass}>{heading}</div>
      ) : (
        <button
          type="button"
          onClick={() => openNote(seq)}
          aria-label={`${note.kind} team note${author === null ? '' : ` by ${author}`} — open it in notes`}
          className={cn(
            headingClass,
            '-mx-1 rounded px-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          )}>
          {heading}
        </button>
      )}
      <MarkdownContent content={note.text} />
    </MessageBubble>
  );
}
