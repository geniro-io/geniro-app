import type { NodeProps } from '@xyflow/react';
import { ShieldQuestion } from 'lucide-react';
import { useContext } from 'react';

import {
  agentIconName,
  AgentIdentityContext,
  agentShortName,
} from '../agent-identity';
import { AgentGlyph } from '../components/agent-glyph';
import { Badge } from '../components/ui/badge';
import { AgentAvatar } from './agent-avatar';
import type { AgentFlowNode } from './graph-doc';
import { NodeCard } from './node-card';

/**
 * Canvas card for one agent node — the kind-specific header (avatar chip,
 * label, agent/model badges, optional description/role blurb) inside the shared
 * `NodeCard` shell, which owns selection/validation styling and the
 * collapsible ports block.
 */

export function AgentNode({
  data,
  selected,
}: NodeProps<AgentFlowNode>): React.JSX.Element {
  const { node } = data;
  const identities = useContext(AgentIdentityContext);
  const icon = agentIconName(identities, node.agent);
  const label = node.name ?? node.id;
  // The description is written to say what this agent is for in a line or
  // two, so it is the better card blurb; a node with only a role still shows
  // something rather than going blank.
  const blurb = node.description ?? node.role;
  return (
    <NodeCard node={node} selected={selected} className="w-[240px]">
      <div className="mb-2 flex items-center gap-2">
        <AgentAvatar label={label} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {label}
        </span>
        {node.approval !== 'auto' ? (
          <ShieldQuestion
            aria-label={
              node.approval === 'acceptEdits'
                ? 'Auto-approves edits, asks for the rest'
                : 'Asks before tool calls'
            }
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className="gap-1">
          <AgentGlyph icon={icon} className="size-3" />
          {agentShortName(identities, node.agent)}
        </Badge>
        {node.model ? <Badge variant="outline">{node.model}</Badge> : null}
      </div>
      {blurb ? (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {blurb}
        </p>
      ) : null}
    </NodeCard>
  );
}
