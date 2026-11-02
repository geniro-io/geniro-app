import { cva } from 'class-variance-authority';
import { TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';

import { type AvatarLook, MemberAvatar } from '../components/member-avatar';
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

/** One thing a team needs before it runs well, named for the person to fix it. */
export interface TeamProblem {
  key: string;
  member: { id: string; name: string; avatar?: AvatarLook | null } | null;
  message: string;
  /** A red problem blocks a run; an amber one only informs. */
  level: 'warning' | 'error';
  fix?: { label: string; run: () => void };
}

/**
 * "⚠ N need setup": the team's open problems behind one pill, each with its
 * fix and a way to its member. Draws nothing while there is nothing to fix.
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
        className="w-80 p-2">
        <ul className="flex flex-col gap-1">
          {problems.map((problem) => (
            <li
              key={problem.key}
              data-slot="team-problem"
              className="flex items-start gap-2 rounded-control p-2">
              {problem.member === null ? (
                <TriangleAlert
                  aria-hidden="true"
                  className={problemIconVariants({ level: problem.level })}
                />
              ) : (
                <MemberAvatar
                  name={problem.member.name}
                  avatar={problem.member.avatar}
                  colorKey={problem.member.id}
                  size={20}
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="text-sm">
                  {problem.member === null ? null : (
                    <span className="font-medium">{problem.member.name}: </span>
                  )}
                  {problem.message}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {problem.fix ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={() => {
                        setOpen(false);
                        problem.fix?.run();
                      }}>
                      {problem.fix.label}
                    </Button>
                  ) : null}
                  {problem.member === null ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-muted-foreground"
                      onClick={() => {
                        setOpen(false);
                        if (problem.member) {
                          onGoToMember(problem.member.id);
                        }
                      }}>
                      Go to member
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Popover>
    </span>
  );
}
