import type { NodeProps } from '@xyflow/react';
import { Bot, ShieldQuestion, SquareTerminal } from 'lucide-react';

import type { CliKind } from '../../shared/contracts';
import { Badge } from '../components/ui/badge';
import { AgentAvatar } from './agent-avatar';
import type { AgentFlowNode } from './graph-doc';
import { NodeCard } from './node-card';

/**
 * Canvas card for one agent node — the kind-specific header (avatar chip,
 * label, agent/model badges, optional role preview) inside the shared
 * `NodeCard` shell, which owns selection/validation styling and the
 * collapsible ports block.
 */

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
    <NodeCard node={node} selected={selected} className="w-[240px]">
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
    </NodeCard>
  );
}
