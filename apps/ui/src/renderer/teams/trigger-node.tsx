import type { NodeProps } from '@xyflow/react';
import { Zap } from 'lucide-react';

import { Badge } from '../components/ui/badge';
import type { TriggerFlowNode } from './graph-doc';
import { NodeCard } from './node-card';

/**
 * Canvas card for one trigger node — the graph's entry point. Narrower than
 * the agent card; its ports block shows an OUTPUT side only (a trigger's
 * `inputs` rule list is empty — nothing may feed it). Rendered inside the
 * shared `NodeCard` shell, which owns selection/validation styling and the
 * collapsible ports block.
 */
export function TriggerNode({
  data,
  selected,
}: NodeProps<TriggerFlowNode>): React.JSX.Element {
  const { node } = data;
  const label = node.name ?? node.id;
  return (
    <NodeCard node={node} selected={selected} className="w-[200px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
          <Zap aria-hidden="true" className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {label}
        </span>
      </div>
      <Badge variant="success" className="gap-1">
        <Zap aria-hidden="true" />
        {node.trigger} trigger
      </Badge>
    </NodeCard>
  );
}
