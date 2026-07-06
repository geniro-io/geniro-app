import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Bot, ShieldQuestion, SquareTerminal } from 'lucide-react';
import type { CSSProperties } from 'react';

import type { CliKind } from '../../shared/contracts';
import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';
import { AgentAvatar } from './agent-avatar';
import type { AgentFlowNode } from './graph-doc';

/**
 * Canvas card for one agent node — mirrors geniro's `GraphNodeCard`: an avatar
 * chip, the node label, agent/model badges, an optional role preview, and a
 * labeled input (left) / output (right) port row. Edges flow left → right,
 * matching the producer→consumer direction.
 *
 * Handle colours come from tokens via `var(--token)` (the renderer design
 * system forbids raw hex — geniro's #1890ff/#52c41a become the warm palette's
 * caramel `primary` for the input and green `success` for the output).
 */
const HANDLE_BASE: CSSProperties = {
  width: 12,
  height: 12,
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  border: '2px solid var(--color-card)',
};
const INPUT_HANDLE_STYLE: CSSProperties = {
  ...HANDLE_BASE,
  left: -18,
  background: 'var(--color-primary)',
  boxShadow: '0 0 0 1px var(--color-primary)',
};
const OUTPUT_HANDLE_STYLE: CSSProperties = {
  ...HANDLE_BASE,
  right: -18,
  background: 'var(--color-success)',
  boxShadow: '0 0 0 1px var(--color-success)',
};

/** Per-kind glyph shown next to the agent badge. */
const AGENT_ICON: Record<CliKind, React.ReactNode> = {
  claude: <Bot aria-hidden="true" className="size-3" />,
  'cursor-agent': <SquareTerminal aria-hidden="true" className="size-3" />,
};

export function AgentNode({
  data,
  selected,
}: NodeProps<AgentFlowNode>): React.JSX.Element {
  const { node } = data;
  const label = node.name ?? node.id;
  return (
    <div
      className={cn(
        'w-[240px] rounded-xl border border-border bg-card shadow-panel-sm transition-shadow hover:shadow-panel-md',
        selected && 'border-primary ring-2 ring-primary/40',
      )}>
      {/* Header — avatar + label + approval marker, then badges + role */}
      <div className="border-b border-border/60 p-3">
        <div className="mb-2 flex items-center gap-2">
          <AgentAvatar label={label} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {label}
          </span>
          {node.approval === 'ask' ? (
            <ShieldQuestion
              aria-label="Asks before tool calls"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className="gap-1">
            {AGENT_ICON[node.agent]}
            {node.agent}
          </Badge>
          {node.model ? <Badge variant="outline">{node.model}</Badge> : null}
        </div>
        {node.role ? (
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {node.role}
          </p>
        ) : null}
      </div>

      {/* Ports — labeled input (left) / output (right) with the handle dots */}
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="relative flex items-center">
          <Handle
            type="target"
            position={Position.Left}
            style={INPUT_HANDLE_STYLE}
          />
          <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            input
          </span>
        </div>
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
