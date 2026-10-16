import {
  Code,
  Eye,
  GitBranch,
  ListChecks,
  MessageSquare,
  SlidersHorizontal,
} from 'lucide-react';
import { createElement } from 'react';

import { Card } from '../components/ui/card';
import { cn } from '../components/ui/utils';

const CONCEPTS = [
  {
    Icon: MessageSquare,
    title: 'Agent',
    description: 'Your coding assistant, run through its CLI on your computer.',
  },
  {
    Icon: SlidersHorizontal,
    title: 'Profile',
    description: 'An agent’s account, instructions and tools, kept apart.',
  },
  {
    Icon: GitBranch,
    title: 'Team',
    description: 'Agents with clear roles, passing work along a graph.',
  },
];
const ROLES = [
  { Icon: ListChecks, title: 'Plan', detail: 'Break down the task' },
  { Icon: Code, title: 'Build', detail: 'Make the changes' },
  { Icon: Eye, title: 'Review', detail: 'Check the result' },
];

export function OnboardingOverview(): React.JSX.Element {
  return (
    <div className="space-y-8">
      <Card className="items-center border-primary/15 bg-primary/5 px-6 py-8 text-center shadow-none sm:px-8">
        <p className="text-xs font-medium uppercase tracking-widest text-primary">
          Example team
        </p>
        <h2 className="mt-2 text-lg font-semibold tracking-tight">
          One task. A few clear roles.
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Start with one agent. Add a team whenever it helps.
        </p>
        <ol
          aria-label="Example team workflow"
          className="mt-8 grid w-full max-w-xl grid-cols-3">
          {ROLES.map(({ Icon: icon, title, detail }, index) => (
            <li key={title} className="flex min-w-0 flex-col items-center">
              <div className="flex w-full items-center">
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-px flex-1 bg-primary/25',
                    index === 0 && 'invisible',
                  )}
                />
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-card text-primary shadow-panel-sm">
                  {createElement(icon, {
                    'aria-hidden': true,
                    className: 'size-[18px]',
                  })}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-px flex-1 bg-primary/25',
                    index === ROLES.length - 1 && 'invisible',
                  )}
                />
              </div>
              <p className="mt-3 text-sm font-semibold">{title}</p>
              <p className="mt-0.5 px-2 text-xs text-muted-foreground">
                {detail}
              </p>
            </li>
          ))}
        </ol>
      </Card>
      <dl className="grid gap-6 sm:grid-cols-3">
        {CONCEPTS.map(({ Icon: icon, title, description }) => (
          <div key={title} className="border-t border-border pt-4">
            <dt className="flex items-center gap-2 text-sm font-semibold">
              {createElement(icon, {
                'aria-hidden': true,
                className: 'size-4 text-primary',
              })}
              {title}
            </dt>
            <dd className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {description}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
