import type { NodeProps } from '@xyflow/react';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useContext } from 'react';

import {
  agentIconName,
  AgentIdentityContext,
  agentShortName,
} from '../agent-identity';
import { AgentGlyph } from '../components/agent-glyph';
import { AgentPoolLabel } from '../components/agent-pool-label';
import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';
import { AgentAvatar } from './agent-avatar';
import type { AgentFlowNode } from './graph-doc';
import { GraphPreviewContext } from './graph-preview-context';
import { NodeCard } from './node-card';
import { RUNS_UNASKED_LABEL, runsUnasked } from './node-schema';

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
  // On a proposal's preview an agent that would run tools unasked is the one
  // thing the reader must not miss, so it is ringed and named, never only
  // coloured. The builder's canvas keeps its quieter icon-only reading.
  const unasked = useContext(GraphPreviewContext) !== null && runsUnasked(node);
  return (
    <NodeCard
      node={node}
      selected={selected}
      className={cn(
        'w-[240px]',
        unasked && 'border-warning/60 ring-2 ring-warning/40',
      )}>
      {unasked ? (
        <Badge variant="warning" className="mb-2">
          <ShieldAlert aria-hidden="true" />
          {RUNS_UNASKED_LABEL}
        </Badge>
      ) : null}
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
        {/* One label for the whole pool — member 1's CLI plus a count, the
            members on hover — rather than a CLI badge beside `pool of N`.
            `nodrag`: a press on it opens the member list instead of starting
            a drag of the card. */}
        <span className="nodrag">
          <AgentPoolLabel
            variant="default"
            leading={<AgentGlyph icon={icon} className="size-3" />}
            members={[
              {
                name: agentShortName(identities, node.agent),
                model: node.model ?? null,
                profile: node.configDir ?? null,
              },
              ...(node.pool ?? []).map((member) => ({
                name: agentShortName(identities, member.agent),
                model: member.model ?? null,
                profile: member.configDir ?? null,
              })),
            ]}
          />
        </span>
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
