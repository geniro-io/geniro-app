import { ClipboardCheck } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { MessageBubble } from './message-bubble';
import { AcceptanceBadge, outcomeSegments } from './run-outcome';
import type { RunOutcomePayload } from './run-outcome-payload';

/**
 * Where one pull request stood when a workflow agent recorded it
 * (`record_outcome`), as its row in the recording agent's flow or its call's
 * card. A later outcome of the same pull request supersedes this one: the row
 * stays, dimmed and tagged, since the transcript is the history.
 */
export function RunOutcomeRow({
  outcome,
  author,
  superseded,
  showRepo,
}: {
  outcome: RunOutcomePayload;
  /** The recording agent's name, or null when the row is drawn under it already. */
  author: string | null;
  superseded: boolean;
  /** Prefix the repository, for a thread whose pull requests span several. */
  showRepo: boolean;
}): React.JSX.Element {
  const words = outcomeSegments(outcome);
  const name = `${showRepo ? outcome.prRepo : ''}#${outcome.prNumber}`;
  return (
    <MessageBubble variant="tool" className="text-foreground">
      <div
        data-slot="run-outcome"
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground',
          superseded && 'opacity-70',
        )}>
        <ClipboardCheck className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">
          {author === null ? 'Outcome' : `${author} · outcome`}
        </span>
        <a
          href={outcome.prUrl}
          target="_blank"
          rel="noreferrer"
          className="font-medium tabular-nums text-foreground hover:underline">
          {name}
        </a>
        <span>{words.draft}</span>
        <span className="whitespace-nowrap">{words.rounds}</span>
        <AcceptanceBadge acceptance={outcome.acceptance} muted={superseded} />
        <span className="whitespace-nowrap">{words.questions}</span>
        {superseded ? <span className="italic">superseded</span> : null}
      </div>
    </MessageBubble>
  );
}
