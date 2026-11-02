import { TriangleAlert } from 'lucide-react';

import { cn } from '../components/ui/utils';

/**
 * What the daemon would refuse about the team as it stands, in words: while
 * any stands, autosave holds, so the page and the member sheet both say so.
 */
export function HeldProblems({
  problems,
  slot,
  role = 'alert',
  className,
}: {
  problems: readonly string[];
  slot: string;
  /** `status` where the list stays pinned in view and must not interrupt. */
  role?: 'alert' | 'status';
  className?: string;
}): React.JSX.Element | null {
  if (problems.length === 0) {
    return null;
  }
  return (
    <div
      role={role}
      data-slot={slot}
      className={cn(
        'flex flex-col gap-1 rounded-control bg-destructive/10 p-3 text-sm',
        className,
      )}>
      <p className="flex items-center gap-1.5 font-medium text-destructive">
        <TriangleAlert aria-hidden="true" className="size-3.5" />
        Not saved until this is fixed
      </p>
      <ul className="flex flex-col gap-0.5 pl-5 text-foreground/80">
        {problems.map((problem) => (
          <li key={problem} className="list-disc">
            {problem}
          </li>
        ))}
      </ul>
    </div>
  );
}
