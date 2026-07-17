import {
  type ReactFlowState,
  useEdges,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { createContext, useContext, useMemo } from 'react';

import type {
  CursorCallsCapability,
  WorkflowNode,
} from '../../shared/contracts';
import { ErrorText } from '../components/error-text';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { NodePorts } from './node-ports';
import { flowEdgeKind } from './node-schema';
import { type NodeValidationError, validateNode } from './node-validate';

/**
 * Shared canvas-card shell for every node kind — geniro's GraphNodeCard: the
 * container (selected ring / destructive ring when invalid), the per-kind
 * header content as children, the collapsible ports block, and an inline
 * error strip listing what's wrong. Validation is live: it recomputes from
 * the canvas edges + node kinds on every graph change, mirroring the checks
 * the daemon runs at save/run time (see node-validate.ts).
 */

function kindsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

/** id → node kind for every node on the canvas. The equality fn keeps node
 *  drags (position-only changes) from re-rendering every card. */
function selectKinds(state: ReactFlowState): Record<string, string> {
  const kinds: Record<string, string> = {};
  for (const node of state.nodes) {
    const data = node.data as { node?: { kind?: string } } | undefined;
    const kind = data?.node?.kind;
    if (typeof kind === 'string') {
      kinds[node.id] = kind;
    }
  }
  return kinds;
}

export function useNodeValidation(node: WorkflowNode): NodeValidationError[] {
  const edges = useEdges();
  const kinds = useStore(selectKinds, kindsEqual);
  return useMemo(() => validateNode(node, kinds, edges), [node, kinds, edges]);
}

/**
 * The daemon's cursor-calls probe verdict, provided by the Graphs page.
 * Lives in context (not inside `validateNode`) because the pure validator has
 * no daemon access — this is machine state, not graph state.
 */
export const CursorCallsContext = createContext<CursorCallsCapability | null>(
  null,
);

/**
 * The amber degrade warning for a cursor node that has outgoing call edges
 * while the machine's cursor-agent can't (or isn't yet known to) use MCP call
 * tools. Null = no warning (not a cursor caller, verdict passed, or the
 * capability hasn't loaded yet).
 */
export function useCursorCallsWarning(node: WorkflowNode): string | null {
  const capability = useContext(CursorCallsContext);
  const edges = useEdges();
  return useMemo(() => {
    if (
      node.kind !== 'agent' ||
      node.agent !== 'cursor-agent' ||
      !capability ||
      capability.status === 'pass'
    ) {
      return null;
    }
    const isCaller = edges.some(
      (edge) => edge.source === node.id && flowEdgeKind(edge) === 'call',
    );
    if (!isCaller) {
      return null;
    }
    return capability.status === 'fail'
      ? `Agent calls will be disabled: ${capability.reason ?? 'cursor-agent did not pass the MCP-trust probe on this machine'}`
      : 'Agent calls not verified yet — probing cursor-agent MCP support…';
  }, [node, capability, edges]);
}

export function NodeCard({
  node,
  selected,
  className,
  children,
}: {
  node: WorkflowNode;
  selected: boolean;
  /** Per-kind width (e.g. `w-[240px]`). */
  className?: string;
  /** The kind-specific header content. */
  children: React.ReactNode;
}): React.JSX.Element {
  const errors = useNodeValidation(node);
  const callsWarning = useCursorCallsWarning(node);
  const { deleteElements } = useReactFlow();
  const invalid = errors.length > 0;
  return (
    <div
      className={cn(
        'group relative rounded-xl border bg-card shadow-panel-sm transition-shadow hover:shadow-panel-md',
        invalid
          ? 'border-destructive ring-2 ring-destructive/30'
          : selected
            ? 'border-primary ring-2 ring-primary/40'
            : 'border-border',
        className,
      )}>
      {/* Per-node delete, revealed on hover/selection. `nodrag` keeps the
          press from starting a node drag; deleteElements drops the node AND
          its edges through the controlled onNodesChange/onEdgesChange. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Delete ${node.id}`}
        title="Delete node"
        className={cn(
          'nodrag absolute top-1.5 right-1.5 z-10 size-6 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 [&_svg]:size-3.5',
          selected && 'opacity-100',
        )}
        onClick={(event) => {
          event.stopPropagation();
          void deleteElements({ nodes: [{ id: node.id }] });
        }}>
        <Trash2 />
      </Button>
      <div className="border-b border-border/60 p-3">{children}</div>
      <NodePorts
        nodeId={node.id}
        kind={node.kind}
        missingInput={errors.some((e) => e.side === 'input')}
        missingOutput={errors.some((e) => e.side === 'output')}
      />
      {invalid ? (
        // The strip is a styling container; each line is its own alert via the
        // shared ErrorText primitive (which owns role="alert") — so the roles
        // don't nest. Compact 10px canvas sizing overrides ErrorText's text-sm.
        <div
          className={cn(
            'flex flex-col gap-1 border-t border-destructive/20 bg-destructive/10 px-3 py-2',
            callsWarning ? '' : 'rounded-b-xl',
          )}>
          {errors.map((error) => (
            <ErrorText key={error.message} className="text-[10px] leading-snug">
              {error.message}
            </ErrorText>
          ))}
        </div>
      ) : null}
      {callsWarning ? (
        <div
          role="note"
          className="rounded-b-xl border-t border-warning/20 bg-warning/10 px-3 py-2">
          <p className="text-[10px] leading-snug text-warning">
            {callsWarning}
          </p>
        </div>
      ) : null}
    </div>
  );
}
