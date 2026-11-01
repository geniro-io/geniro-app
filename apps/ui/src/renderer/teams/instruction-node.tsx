import type { NodeProps } from '@xyflow/react';
import { ScrollText } from 'lucide-react';

import type { InstructionFlowNode } from './graph-doc';
import { NodeCard } from './node-card';

/**
 * Canvas card for one instruction block — free text wired to the agents it
 * applies to. Its ports block shows an OUTPUT side only (a block's `inputs`
 * rule list is empty — nothing may feed one, and it runs nothing itself).
 *
 * The card shows the TEXT rather than only a name, clamped to a few lines:
 * a block whose whole content is the point would otherwise be a titled box
 * that has to be selected before anyone can tell two of them apart. Rendered
 * inside the shared `NodeCard` shell, which owns selection/validation styling
 * and the collapsible ports block.
 */
export function InstructionNode({
  data,
  selected,
}: NodeProps<InstructionFlowNode>): React.JSX.Element {
  const { node } = data;
  const label = node.name ?? node.id;
  const text = node.instructions.trim();
  return (
    <NodeCard node={node} selected={selected} className="w-[220px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <ScrollText aria-hidden="true" className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {label}
        </span>
      </div>
      {text ? (
        <p className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          No instructions yet
        </p>
      )}
    </NodeCard>
  );
}
