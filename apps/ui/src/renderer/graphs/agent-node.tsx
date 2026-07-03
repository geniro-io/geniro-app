import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Bot, ShieldQuestion } from 'lucide-react';

import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';
import type { AgentFlowNode } from './graph-doc';

/**
 * Canvas card for one agent node: name, agent kind, model, and an "asks
 * before tools" marker. Edges flow left (inputs) → right (output), matching
 * the producer→consumer direction. All colours come from design tokens.
 */
export function AgentNode({
  data,
  selected,
}: NodeProps<AgentFlowNode>): React.JSX.Element {
  const { node } = data;
  return (
    <div
      className={cn(
        'w-[220px] rounded-lg border border-border bg-card px-3 py-2.5 shadow-panel-sm',
        selected && 'ring-2 ring-ring/60',
      )}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5">
        <Bot aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
        <span className="truncate text-sm font-medium">
          {node.name ?? node.id}
        </span>
        {node.approval === 'ask' ? (
          <ShieldQuestion
            aria-label="Asks before tool calls"
            className="ml-auto size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Badge variant="secondary">{node.agent}</Badge>
        {node.model ? <Badge variant="outline">{node.model}</Badge> : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
