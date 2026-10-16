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
    <div className="space-y-4">
      <Card className="gap-6 border-primary/20 bg-primary/5 p-6 shadow-none sm:p-7">
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">
            Example team
          </p>
          <h2 className="text-lg font-semibold tracking-tight">
            One task. A few clear roles.
          </h2>
          <p className="text-sm text-muted-foreground">
            Start with one agent. Add a team whenever it helps.
          </p>
        </div>
        <ol aria-label="Example team workflow" className="grid grid-cols-3">
          {ROLES.map(({ Icon: icon, title, detail }, index) => (
            <li key={title} className="min-w-0">
              <div className="flex items-center">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-card text-primary">
                  {createElement(icon, {
                    'aria-hidden': true,
                    className: 'size-4',
                  })}
                </span>
                {index < ROLES.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="mx-3 h-px flex-1 bg-primary/30"
                  />
                ) : null}
              </div>
              <p className="mt-3 pr-3 text-sm font-semibold">{title}</p>
              <p className="mt-0.5 pr-3 text-xs leading-relaxed text-muted-foreground">
                {detail}
              </p>
            </li>
          ))}
        </ol>
      </Card>
      <Card className="divide-y divide-border shadow-none sm:grid sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {CONCEPTS.map(({ Icon: icon, title, description }) => (
          <div key={title} className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              {createElement(icon, {
                'aria-hidden': true,
                className: 'size-4 text-primary',
              })}
              {title}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
        ))}
      </Card>
    </div>
  );
}
