import '@xyflow/react/dist/style.css';

import {
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { cva } from 'class-variance-authority';
import { createContext, useContext, useMemo, useState } from 'react';

import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import {
  ContactEdge,
  type ContactFlowEdge,
  type ContactPulse,
  type ContactState,
  type EdgeState,
  edgeStateOf,
} from './contact-edge';

export const MAX_THREAD_NODES = 24;

export type GraphThreadStatus =
  'working' | 'waiting' | 'idle' | 'failed' | 'done';

export interface GraphManager {
  id: string;
  label: string;
}

export interface GraphThread {
  id: string;
  label: string;
  status: GraphThreadStatus;
}

export interface GraphViewProps {
  manager: GraphManager | null;
  threads: readonly GraphThread[];
  contacts: Readonly<Record<string, ContactState>>;
  pulses: readonly ContactPulse[];
  now: number;
  onOpen: (threadId: string) => void;
  className?: string;
}

const MANAGER_ID = 'manager';
const MORE_ID = 'more';
const MANAGER_PX = 40;
const THREAD_PX = 22;
const MORE_WIDTH_PX = 64;
const MORE_HEIGHT_PX = 22;
const RING_SLOT_PX = 112;
const MIN_RING_RADIUS_PX = 170;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.25;

const PRO_OPTIONS = { hideAttribution: true };
const FIT_VIEW_OPTIONS = {
  padding: 0.15,
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
};
const CENTRE_HANDLE = {
  left: '50%',
  top: '50%',
  opacity: 0,
  pointerEvents: 'none',
} as const;

const STATUS_WORDS: Record<GraphThreadStatus, string> = {
  working: 'working',
  waiting: 'waiting',
  idle: 'idle',
  failed: 'failed',
  done: 'done',
};

const DEFAULT_DETAILS = 'Focus a thread for its status and contact.';

interface ManagerNodeData extends Record<string, unknown> {
  label: string;
}

interface ThreadNodeData extends Record<string, unknown> {
  threadId: string;
  label: string;
  status: GraphThreadStatus;
  contact: EdgeState;
  summary: string;
}

interface MoreNodeData extends Record<string, unknown> {
  count: number;
}

type ManagerFlowNode = Node<ManagerNodeData, 'manager'>;
type ThreadFlowNode = Node<ThreadNodeData, 'thread'>;
type MoreFlowNode = Node<MoreNodeData, 'more'>;
type GraphFlowNode = ManagerFlowNode | ThreadFlowNode | MoreFlowNode;

interface GraphActions {
  open: (threadId: string) => void;
  inspect: (threadId: string | null) => void;
}

const GraphActionsContext = createContext<GraphActions>({
  open: () => undefined,
  inspect: () => undefined,
});

const managerVariants = cva(
  'relative flex size-10 items-center justify-center rounded-full border-2 border-primary bg-primary/12',
);

const threadVariants = cva(
  'relative size-[22px] cursor-pointer rounded-full border-2 bg-card outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/60',
  {
    variants: {
      status: {
        working: 'border-primary',
        waiting: 'border-warning',
        idle: 'border-border-strong',
        failed: 'border-destructive',
        done: 'border-success',
      } satisfies Record<GraphThreadStatus, string>,
    },
  },
);

const labelVariants =
  'pointer-events-none absolute left-1/2 top-full mt-1 w-28 -translate-x-1/2 truncate text-center text-xs';

function ManagerNode({ data }: NodeProps<ManagerFlowNode>): React.JSX.Element {
  return (
    <>
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={CENTRE_HANDLE}
      />
      <div
        role="img"
        data-slot="graph-manager"
        aria-label={`Manager: ${data.label}`}
        className={managerVariants()}>
        <span aria-hidden="true" className={cn(labelVariants, 'font-semibold')}>
          {data.label}
        </span>
      </div>
    </>
  );
}

function ThreadNode({ data }: NodeProps<ThreadFlowNode>): React.JSX.Element {
  const { open, inspect } = useContext(GraphActionsContext);
  const { threadId, label, status, contact, summary } = data;
  return (
    <>
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={CENTRE_HANDLE}
      />
      <div
        role="button"
        tabIndex={0}
        aria-label={summary}
        data-slot="graph-thread"
        data-thread-id={threadId}
        data-status={status}
        data-contact={contact}
        className={threadVariants({ status })}
        onClick={() => open(threadId)}
        onKeyDown={(event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open(threadId);
          }
        }}
        onFocus={() => inspect(threadId)}
        onBlur={() => inspect(null)}
        onPointerEnter={() => inspect(threadId)}
        onPointerLeave={() => inspect(null)}>
        <span aria-hidden="true" className={labelVariants}>
          {label}
        </span>
      </div>
    </>
  );
}

function MoreNode({ data }: NodeProps<MoreFlowNode>): React.JSX.Element {
  return (
    <span
      data-slot="graph-more"
      className="flex items-center justify-center whitespace-nowrap text-xs text-muted-foreground"
      style={{ width: MORE_WIDTH_PX, height: MORE_HEIGHT_PX }}>
      +{data.count} more
    </span>
  );
}

const NODE_TYPES = {
  manager: ManagerNode,
  thread: ThreadNode,
  more: MoreNode,
};
const EDGE_TYPES = { contact: ContactEdge };

function ringPositions(slots: number): { x: number; y: number }[] {
  const radius = Math.max(
    MIN_RING_RADIUS_PX,
    Math.round((slots * RING_SLOT_PX) / (2 * Math.PI)),
  );
  return Array.from({ length: slots }, (_, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / slots;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

function agoWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return `${Math.floor(minutes / 60)} h ago`;
}

function summaryOf(
  thread: GraphThread,
  state: EdgeState,
  lastAt: string | null,
  now: number,
): string {
  const contactWords = [
    ...(state === 'awaiting' ? ['awaiting a reply'] : []),
    lastAt === null
      ? 'no contact yet'
      : `last contact ${agoWords(now - Date.parse(lastAt))}`,
  ];
  return [thread.label, STATUS_WORDS[thread.status], ...contactWords].join(
    ', ',
  );
}

function topLeftOf(
  x: number,
  y: number,
  sizePx: number,
): { x: number; y: number } {
  return { x: x - sizePx / 2, y: y - sizePx / 2 };
}

export function GraphView({
  manager,
  threads,
  contacts,
  pulses,
  now,
  onOpen,
  className,
}: GraphViewProps): React.JSX.Element {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const open = useLatestCallback(onOpen, []);
  const actions: GraphActions = { open, inspect: setFocusedId };

  const graph = useMemo(() => {
    const shown = threads.slice(0, MAX_THREAD_NODES);
    const hidden = threads.length - shown.length;
    const ring = ringPositions(shown.length + (hidden > 0 ? 1 : 0));
    const summaries = new Map<string, string>();
    const nodes: GraphFlowNode[] = [];
    const edges: ContactFlowEdge[] = [];

    if (manager !== null) {
      nodes.push({
        id: MANAGER_ID,
        type: 'manager',
        position: topLeftOf(0, 0, MANAGER_PX),
        width: MANAGER_PX,
        height: MANAGER_PX,
        data: { label: manager.label },
        selectable: false,
        draggable: false,
      });
    }

    shown.forEach((thread, index) => {
      const { x, y } = ring[index]!;
      const contact = contacts[thread.id];
      const threadPulses = pulses.filter(
        (pulse) => pulse.threadId === thread.id,
      );
      const state = edgeStateOf(contact, threadPulses, now);
      const summary = summaryOf(thread, state, contact?.lastAt ?? null, now);
      summaries.set(thread.id, summary);
      nodes.push({
        id: `thread:${thread.id}`,
        type: 'thread',
        position: topLeftOf(x, y, THREAD_PX),
        width: THREAD_PX,
        height: THREAD_PX,
        data: {
          threadId: thread.id,
          label: thread.label,
          status: thread.status,
          contact: state,
          summary,
        },
        selectable: false,
        draggable: false,
      });
      if (manager !== null) {
        edges.push({
          id: `contact:${thread.id}`,
          type: 'contact',
          source: MANAGER_ID,
          sourceHandle: 'out',
          target: `thread:${thread.id}`,
          targetHandle: 'in',
          data: { state, pulses: threadPulses, now },
        });
      }
    });

    if (hidden > 0) {
      const { x, y } = ring[shown.length]!;
      nodes.push({
        id: MORE_ID,
        type: 'more',
        position: topLeftOf(x, y, MORE_HEIGHT_PX),
        width: MORE_WIDTH_PX,
        height: MORE_HEIGHT_PX,
        data: { count: hidden },
        selectable: false,
        draggable: false,
      });
    }

    return { nodes, edges, summaries, nodeCount: nodes.length };
  }, [manager, threads, contacts, pulses, now]);

  if (manager === null) {
    return (
      <p
        data-slot="command-center-graph-empty"
        className="text-sm text-muted-foreground">
        No manager chat yet. Start one to see its contacts with each thread.
      </p>
    );
  }

  const focusedSummary =
    focusedId === null ? null : (graph.summaries.get(focusedId) ?? null);

  return (
    <GraphActionsContext.Provider value={actions}>
      <div
        role="group"
        aria-label={`Contacts between ${manager.label} and ${threads.length} threads`}
        className={cn('flex h-[420px] flex-col gap-2', className)}>
        <div className="min-h-0 flex-1">
          <ReactFlow
            key={graph.nodeCount}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            disableKeyboardA11y
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            panActivationKeyCode={null}
            zoomActivationKeyCode={null}
            panOnDrag={false}
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            proOptions={PRO_OPTIONS}
          />
        </div>
        <p
          aria-live="polite"
          data-slot="command-center-graph-details"
          className="text-xs text-muted-foreground">
          {focusedSummary ?? DEFAULT_DETAILS}
        </p>
      </div>
    </GraphActionsContext.Provider>
  );
}
