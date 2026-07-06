import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Zap } from 'lucide-react';
import type { CSSProperties } from 'react';

import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';
import type { TriggerFlowNode } from './graph-doc';

/**
 * Canvas card for one trigger node — the graph's entry point. Narrower than
 * the agent card and with an OUTPUT port only: nothing may feed a trigger
 * (its `inputs` rule list is empty), it exists to fire downstream agents
 * with the run prompt.
 */
const OUTPUT_HANDLE_STYLE: CSSProperties = {
  width: 12,
  height: 12,
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  border: '2px solid var(--color-card)',
  right: -18,
  background: 'var(--color-success)',
  boxShadow: '0 0 0 1px var(--color-success)',
};

export function TriggerNode({
  data,
  selected,
}: NodeProps<TriggerFlowNode>): React.JSX.Element {
  const { node } = data;
  const label = node.name ?? node.id;
  return (
    <div
      className={cn(
        'w-[200px] rounded-xl border border-border bg-card shadow-panel-sm transition-shadow hover:shadow-panel-md',
        selected && 'border-primary ring-2 ring-primary/40',
      )}>
      <div className="border-b border-border/60 p-3">
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
      </div>

      <div className="flex items-center justify-end px-3 py-2.5">
        <div className="relative flex items-center">
          <span className="rounded bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
            output
          </span>
          <Handle
            type="source"
            position={Position.Right}
            style={OUTPUT_HANDLE_STYLE}
          />
        </div>
      </div>
    </div>
  );
}
