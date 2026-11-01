import { ChevronRight, ClipboardCheck } from 'lucide-react';
import { Fragment } from 'react';

import type { PullRequestRefResult } from '../../shared/contracts';
import { cn } from '../components/ui/utils';
import { MarkdownContent } from './markdown-content';
import { MessageBubble } from './message-bubble';
import { PullRequestStateIcon, ThreadPullRequestRow } from './pull-request-row';
import { formatDateTime } from './relative-time';
import { AcceptanceBadge, outcomeSegments } from './run-outcome';
import type { RunOutcomePayload } from './run-outcome-payload';
import { useThreadFlag } from './thread-ui-memory';

/**
 * Where one pull request stood when a team agent recorded it
 * (`record_outcome`), as its row in the recording agent's flow or its call's
 * card. A later outcome of the same pull request supersedes this one: the row
 * stays, dimmed and tagged, since the transcript is the history.
 *
 * Collapsed it names the pull request (its title, when GitHub answered) and the
 * verdict, with the agent's summary or the figures under it; a press opens the
 * whole record and the pull request's own link row.
 */
export function RunOutcomeRow({
  outcome,
  author,
  superseded,
  showRepo,
  pullRequest = null,
  recordedAt = null,
  memoryKey,
}: {
  outcome: RunOutcomePayload;
  /** The recording agent's name, or null when the row is drawn under it already. */
  author: string | null;
  superseded: boolean;
  /** Prefix the repository, for a thread whose pull requests span several. */
  showRepo: boolean;
  /** What GitHub said about the pull request, when the surface asked. */
  pullRequest?: PullRequestRefResult | null;
  /** When the row was written. */
  recordedAt?: string | null;
  /** Where the fold is remembered within the thread. */
  memoryKey?: string;
}): React.JSX.Element {
  const [open, setOpen] = useThreadFlag(memoryKey, false);
  const words = outcomeSegments(outcome);
  const name = `${showRepo ? outcome.prRepo : ''}#${outcome.prNumber}`;
  const info = pullRequest?.pullRequest ?? null;
  const figures = [words.draft, words.rounds, words.questions].join(' · ');
  const recorded = recordedAt === null ? '' : formatDateTime(recordedAt);
  const facts: { label: string; value: string }[] = [
    { label: 'Status', value: words.draft },
    { label: 'Review rounds', value: String(outcome.reviewRounds) },
    { label: 'Questions asked', value: String(outcome.questionsAsked) },
    ...(recorded === '' ? [] : [{ label: 'Recorded', value: recorded }]),
  ];
  return (
    <MessageBubble variant="tool" className="text-foreground">
      <div
        data-slot="run-outcome"
        className={cn(
          'flex min-w-0 flex-col gap-1 text-xs text-muted-foreground',
          superseded && 'opacity-70',
        )}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Hide the outcome' : 'Show the outcome'}
          className="flex w-full min-w-0 items-center gap-2 text-left text-xs font-normal hover:text-foreground">
          <ClipboardCheck className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-medium">
            {author === null ? 'Outcome' : `${author} · outcome`}
          </span>
          {info === null ? null : <PullRequestStateIcon pullRequest={info} />}
          <span className="shrink-0 font-medium tabular-nums text-foreground">
            {name}
          </span>
          <span
            data-slot="run-outcome-title"
            className="min-w-0 flex-1 truncate text-foreground/80">
            {info?.title ?? ''}
          </span>
          <AcceptanceBadge acceptance={outcome.acceptance} muted={superseded} />
          {superseded ? (
            <span className="shrink-0 italic">superseded</span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
        </button>
        {open ? (
          <div
            data-slot="run-outcome-detail"
            className="flex min-w-0 flex-col gap-2 pl-5.5 pt-1">
            {outcome.summary === null ? null : (
              <div className="text-sm text-foreground">
                <MarkdownContent content={outcome.summary} />
              </div>
            )}
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {facts.map((fact) => (
                <Fragment key={fact.label}>
                  <dt className="opacity-70">{fact.label}</dt>
                  <dd className="m-0 min-w-0 break-words text-foreground">
                    {fact.value}
                  </dd>
                </Fragment>
              ))}
            </dl>
            <ThreadPullRequestRow
              result={
                pullRequest ?? {
                  ref: {
                    owner: outcome.prOwner,
                    repo: outcome.prRepo,
                    number: outcome.prNumber,
                    url: outcome.prUrl,
                  },
                  pullRequest: null,
                }
              }
              showRepo={showRepo}
            />
          </div>
        ) : (
          <p
            data-slot="run-outcome-preview"
            className="m-0 min-w-0 truncate pl-5.5">
            {outcome.summary ?? figures}
          </p>
        )}
      </div>
    </MessageBubble>
  );
}
