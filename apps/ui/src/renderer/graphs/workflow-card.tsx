import { Clock, GitFork, Workflow as WorkflowIcon } from 'lucide-react';

import type { WorkflowSummary } from '../../shared/contracts';
import { Badge } from '../components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { cn } from '../components/ui/utils';
import { formatUpdated } from './format-updated';

/** `3 nodes` / `1 node` — count with its correctly-pluralized unit. */
function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * One workflow tile on the library landing grid: name, description, the
 * per-agent-kind badges, and the node / edge / updated metadata. The whole
 * card is the click target that opens the builder (role="button" so it is
 * keyboard-reachable — Enter/Space activate it like a native button).
 */
export function WorkflowCard({
  summary,
  onOpen,
}: {
  summary: WorkflowSummary;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`Open ${summary.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'cursor-pointer gap-3 pb-4 transition-[border-color,box-shadow]',
        'hover:border-ring/50 hover:shadow-panel-md',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
      )}>
      <CardHeader className="gap-1 pb-0">
        {/* leading-snug (not the CardTitle default leading-none): with
            `truncate`'s overflow-hidden a line-height of 1 shaves the glyph
            tops/descenders. py-px adds a hair of vertical breathing room. */}
        <CardTitle className="truncate py-px font-medium leading-snug">
          {summary.name}
        </CardTitle>
        <p className="line-clamp-2 min-h-[2.5em] text-sm text-muted-foreground">
          {summary.description || 'No description'}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {summary.agentCounts.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {summary.agentCounts.map((agent) => (
              <Badge key={agent.kind} variant="muted">
                {agent.kind} ×{agent.count}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <WorkflowIcon aria-hidden="true" className="size-3.5 shrink-0" />
            {plural(summary.nodeCount, 'node')}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitFork aria-hidden="true" className="size-3.5 shrink-0" />
            {plural(summary.edgeCount, 'edge')}
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <Clock aria-hidden="true" className="size-3.5 shrink-0" />
            {formatUpdated(summary.updatedAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
