import {
  ArrowRight,
  GitBranch,
  MessageSquare,
  SlidersHorizontal,
} from 'lucide-react';
import { createElement } from 'react';

import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';

const CONCEPTS = [
  {
    Icon: MessageSquare,
    title: 'Agent',
    description:
      'Your coding assistant, connected through its CLI on your computer.',
  },
  {
    Icon: SlidersHorizontal,
    title: 'Profile',
    description:
      'An agent’s account, instructions, and tools. Keep work and personal setups separate.',
  },
  {
    Icon: GitBranch,
    title: 'Team',
    description:
      'Agents with clear roles, connected in a graph to pass work along.',
  },
];
const ROLES = [
  { title: 'Plan', detail: 'Break down the task' },
  { title: 'Build', detail: 'Make the changes' },
  { title: 'Review', detail: 'Check the result' },
];

export function OnboardingOverview(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <Card className="gap-6 border-primary/20 bg-primary/5 p-6 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge variant="secondary" className="mb-3">
              Example team
            </Badge>
            <h2 className="text-lg font-semibold tracking-tight">
              One task. A few clear roles.
            </h2>
          </div>
          <GitBranch aria-hidden="true" className="size-6 text-primary" />
        </div>
        <ol
          aria-label="Example team workflow"
          className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {ROLES.map(({ title, detail }, index) => (
            <li key={title} className="flex min-w-0 flex-1 items-center gap-3">
              <Card className="min-w-0 flex-1 gap-2 p-4 shadow-none">
                <span className="flex items-center gap-2.5 text-sm font-semibold">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs text-secondary-foreground">
                    {index + 1}
                  </span>
                  {title}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {detail}
                </span>
              </Card>
              {index < ROLES.length - 1 ? (
                <ArrowRight
                  aria-hidden="true"
                  className="hidden size-4 shrink-0 text-primary sm:block"
                />
              ) : null}
            </li>
          ))}
        </ol>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Start with one agent. Add a team whenever it helps.
        </p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        {CONCEPTS.map(({ Icon: icon, title, description }) => (
          <div key={title} className="flex gap-3.5 lg:flex-col">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
              {createElement(icon, {
                'aria-hidden': true,
                className: 'size-4',
              })}
            </span>
            <div>
              <h2 className="text-sm font-semibold">{title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
