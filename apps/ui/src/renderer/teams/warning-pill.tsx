import { cva } from 'class-variance-authority';
import { TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';

import { type AvatarLook, AvatarStack } from '../components/member-avatar';
import { Button } from '../components/ui/button';
import { Popover } from '../components/ui/popover';
import { cn } from '../components/ui/utils';

const pillVariants = cva(
  'inline-flex h-7 items-center gap-1.5 rounded-pill px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[.97] motion-reduce:active:scale-100',
  {
    variants: {
      blocking: {
        true: 'bg-destructive/10 text-destructive hover:bg-destructive/15',
        false: 'bg-warning/15 text-warning hover:bg-warning/20',
      },
    },
  },
);

const problemIconVariants = cva('mt-0.5 size-4 shrink-0', {
  variants: {
    level: { error: 'text-destructive', warning: 'text-warning' },
  },
});

/** A member a problem reaches. */
export interface TeamProblemMember {
  id: string;
  name: string;
  avatar?: AvatarLook | null;
}

/** One thing a team needs before it runs well, named for the people it reaches. */
export interface TeamProblem {
  key: string;
  /** Every member it reaches; empty for a problem of the team itself. */
  members: readonly TeamProblemMember[];
  message: string;
  /** A red problem blocks a run; an amber one only informs. */
  level: 'warning' | 'error';
  /** The CLI account it is about, e.g. "Claude Code · default profile". */
  account?: string;
  /** The names it stands for (MCP servers), listed on request. */
  details?: readonly string[];
  fix?: { label: string; run: () => void };
}

const NAMES_SHOWN = 3;

function namesOf(members: readonly TeamProblemMember[]): string {
  const shown = members.slice(0, NAMES_SHOWN).map((member) => member.name);
  const rest = members.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
}

function ProblemRow({
  problem,
  onDone,
  onGoToMember,
}: {
  problem: TeamProblem;
  onDone: () => void;
  onGoToMember: (memberId: string) => void;
}): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const only = problem.members.length === 1 ? problem.members[0]! : null;
  const context = [
    problem.members.length === 0 ? null : namesOf(problem.members),
    problem.account ?? null,
  ].filter((part): part is string => part !== null);
  return (
    <li
      data-slot="team-problem"
      data-level={problem.level}
      className="flex items-start gap-2.5 rounded-control p-2">
      {problem.members.length === 0 ? (
        <TriangleAlert
          aria-hidden="true"
          className={problemIconVariants({ level: problem.level })}
        />
      ) : (
        <AvatarStack
          people={problem.members.map((member) => ({
            key: member.id,
            name: member.name,
            avatar: member.avatar,
          }))}
          max={3}
          size={20}
          ringClassName="ring-popover"
          className="mt-0.5 shrink-0"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-medium">{problem.message}</p>
        {context.map((line) => (
          <p
            key={line}
            data-slot="team-problem-context"
            className="truncate text-xs text-muted-foreground"
            title={line}>
            {line}
          </p>
        ))}
        {detailsOpen && problem.details ? (
          <ul
            data-slot="team-problem-details"
            className="flex max-h-40 flex-wrap gap-1 overflow-y-auto py-0.5">
            {problem.details.map((name) => (
              <li
                key={name}
                className="max-w-full truncate rounded-pill bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {name}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {problem.fix ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={() => {
                onDone();
                problem.fix?.run();
              }}>
              {problem.fix.label}
            </Button>
          ) : null}
          {problem.details && problem.details.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={detailsOpen}
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => setDetailsOpen((open) => !open)}>
              {detailsOpen
                ? 'Hide servers'
                : `Show ${problem.details.length} servers`}
            </Button>
          ) : null}
          {only === null ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => {
                onDone();
                onGoToMember(only.id);
              }}>
              Go to {only.name}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * "⚠ N need setup": the team's open problems behind one pill — one row per
 * distinct problem, naming every member it reaches, with its fix. Draws
 * nothing while there is nothing to fix.
 */
export function WarningPill({
  problems,
  onGoToMember,
  className,
}: {
  problems: readonly TeamProblem[];
  onGoToMember: (memberId: string) => void;
  className?: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  if (problems.length === 0) {
    return null;
  }
  const blocking = problems.some((problem) => problem.level === 'error');
  return (
    <span className={cn('relative inline-flex', className)}>
      <button
        ref={triggerRef}
        type="button"
        data-slot="warning-pill"
        data-menu-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        className={pillVariants({ blocking })}
        onClick={() => setOpen((wasOpen) => !wasOpen)}>
        <TriangleAlert aria-hidden="true" className="size-3.5" />
        {problems.length} need{problems.length === 1 ? 's' : ''} setup
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        side="bottom"
        align="start"
        anchor="viewport"
        label="Setup problems"
        className="w-96 max-w-[calc(100vw-2rem)] p-2">
        <ul className="flex flex-col divide-y divide-border/60">
          {problems.map((problem) => (
            <ProblemRow
              key={problem.key}
              problem={problem}
              onDone={() => setOpen(false)}
              onGoToMember={onGoToMember}
            />
          ))}
        </ul>
      </Popover>
    </span>
  );
}
