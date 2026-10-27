import { NotebookPen } from 'lucide-react';

import { MarkdownContent } from './markdown-content';
import { MessageBubble } from './message-bubble';
import { TeamNoteKindBadge } from './team-note-kind';
import type { TeamNotePayload } from './team-note-payload';

/**
 * A note an agent wrote to the run's team notes (`team_note`), as its row in
 * the author's flow or its call's card. Compact on purpose: the note is for
 * the other agents, and the Team notes section of the agents panel is where a
 * person reads them together.
 */
export function TeamNoteRow({
  note,
  author,
}: {
  note: TeamNotePayload;
  /** The writing agent's name, or null when the row is drawn under it already. */
  author: string | null;
}): React.JSX.Element {
  return (
    <MessageBubble variant="tool" className="gap-1.5 text-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <NotebookPen className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">
          {author === null ? 'Team note' : `${author} · team note`}
        </span>
        <TeamNoteKindBadge kind={note.kind} />
        {note.supersedes === null ? null : (
          <span className="whitespace-nowrap">replaces an earlier note</span>
        )}
      </div>
      <MarkdownContent content={note.text} />
    </MessageBubble>
  );
}
