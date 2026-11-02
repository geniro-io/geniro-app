import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';

/** One finding pinned in view, with the button that fixes it when there is one. */
export interface HeldProblem {
  key: string;
  message: string;
  level: 'error' | 'warning';
  fix?: { label: string; run: () => void };
}

/**
 * A plain string is an editor refusal: while one stands, autosave holds. A
 * {@link HeldProblem} is a setup finding; only an `error` stops a run.
 */
export type HeldProblemEntry = string | HeldProblem;

export const HELD_PROBLEMS_SHOWN = 4;

function asProblem(entry: HeldProblemEntry): HeldProblem {
  return typeof entry === 'string'
    ? { key: entry, message: entry, level: 'error' }
    : entry;
}

function headingOf(entries: readonly HeldProblemEntry[]): string {
  if (entries.some((entry) => typeof entry === 'string')) {
    return 'Not saved until this is fixed';
  }
  return entries.some((entry) => asProblem(entry).level === 'error')
    ? 'Cannot run until this is fixed'
    : 'Needs setup';
}

/**
 * What the daemon would refuse about the team as it stands, and what keeps a
 * member from running, in words: while a refusal stands, autosave holds, so
 * the page and the member sheet both say so.
 */
export function HeldProblems({
  problems,
  slot,
  role = 'alert',
  heading,
  className,
}: {
  problems: readonly HeldProblemEntry[];
  slot: string;
  /** `status` where the list stays pinned in view and must not interrupt. */
  role?: 'alert' | 'status';
  /** Overrides the heading, which otherwise follows what the list holds. */
  heading?: string;
  className?: string;
}): React.JSX.Element | null {
  const [showAll, setShowAll] = useState(false);
  if (problems.length === 0) {
    return null;
  }
  const rows = problems.map(asProblem);
  const blocking = rows.some((problem) => problem.level === 'error');
  const capped = rows.length > HELD_PROBLEMS_SHOWN + 1;
  const shown = capped && !showAll ? rows.slice(0, HELD_PROBLEMS_SHOWN) : rows;
  return (
    <div
      role={role}
      data-slot={slot}
      className={cn(
        'flex flex-col gap-1 rounded-control p-3 text-sm',
        blocking ? 'bg-destructive/10' : 'bg-warning/10',
        className,
      )}>
      <p
        className={cn(
          'flex items-center gap-1.5 font-medium',
          blocking ? 'text-destructive' : 'text-warning',
        )}>
        <TriangleAlert aria-hidden="true" className="size-3.5" />
        {heading ?? headingOf(problems)}
      </p>
      <ul
        data-slot="held-problems-list"
        className="-mr-2 flex max-h-[min(40vh,20rem)] flex-col gap-1 overflow-y-auto pr-2 text-foreground/80">
        {shown.map((problem) => (
          <li
            key={problem.key}
            data-level={problem.level}
            className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{problem.message}</span>
            {problem.fix ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 rounded-control px-2.5 text-sm"
                onClick={problem.fix.run}>
                {problem.fix.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {capped ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={showAll}
          className="h-7 self-start rounded-control px-2 text-sm text-muted-foreground"
          onClick={() => setShowAll((open) => !open)}>
          {showAll ? 'Show fewer' : `Show all ${rows.length}`}
        </Button>
      ) : null}
    </div>
  );
}
