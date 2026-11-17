import '@xyflow/react/dist/style.css';

import {
  type Edge,
  type EdgeProps,
  Handle,
  type Node,
  type NodeHandle,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { cva } from 'class-variance-authority';
import { Maximize, Minus, Plus, RadioTower } from 'lucide-react';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { type Point, roundedPath } from '../components/stage-graph-layout';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import { formatUpdated } from '../teams/format-updated';
import type { ThreadCardView } from './card-view';
import {
  ContactEdge,
  type ContactFlowEdge,
  type ContactPulse,
  type ContactState,
  type EdgeState,
  edgeStateOf,
  pathStyle,
  usePrefersReducedMotion,
} from './contact-edge';
import {
  type GraphBox,
  type GraphGeometry,
  layoutColumn,
  layoutLines,
  linesFor,
} from './graph-layout';
import {
  activityLine,
  hasLabels,
  THREAD_CARD_WIDTH,
  THREAD_STATUS_TEXT,
  ThreadCard,
  threadCardHeight,
} from './thread-card';

export const MAX_THREAD_NODES = 24;

export interface GraphThread {
  id: string;
  createdAt: string;
  view: ThreadCardView;
}

/** The manager's own chat, as its node shows it; null while there is none. */
export interface GraphManager {
  agentLabel: string | null;
  model: string | null;
  working: boolean;
  lastActivityAt: string | null;
}

export interface GraphViewProps {
  manager: GraphManager | null;
  /** Threads the manager asked to start that wait on the user's Start. */
  pendingStarts: number;
  /** Newest activity first; the first {@link MAX_THREAD_NODES} are drawn. */
  threads: readonly GraphThread[];
  contacts: Readonly<Record<string, ContactState>>;
  pulses: readonly ContactPulse[];
  now: number;
  /** One column for a narrow screen, scrolled rather than panned. */
  narrow: boolean;
  onOpen: (threadId: string) => void;
  onManager: () => void;
  className?: string;
}

const MANAGER_ID = 'manager';
const MORE_ID = 'more';
const MANAGER_WIDTH = 440;
const MANAGER_WIDTH_NARROW = THREAD_CARD_WIDTH;
const MANAGER_HEIGHT = 112;
const MORE_WIDTH = 160;
const MORE_HEIGHT = 32;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
const FIT_MARGIN = 16;
const FIT_MS = 400;
const PAN_ROOM = 160;
const PRO_OPTIONS = { hideAttribution: true };

/** Wires share their trunk, so the louder states are painted last, on top. */
const EDGE_PAINT_ORDER: Record<EdgeState, number> = {
  idle: 0,
  lit: 1,
  awaiting: 2,
};

const NODE_CLASS =
  'transition-transform duration-300 ease-out motion-reduce:transition-none';

/** Nodes answer the pointer only when React Flow sees a handler on them; the cards handle their own presses. */
const POINTER_ON_NODES = (): void => undefined;

interface ManagerNodeData extends Record<string, unknown> {
  manager: GraphManager | null;
  threads: number;
  working: number;
  awaiting: number;
  pendingStarts: number;
  now: number;
}

interface ThreadNodeData extends Record<string, unknown> {
  thread: GraphThread;
  summary: string;
  height: number;
}

interface MoreNodeData extends Record<string, unknown> {
  count: number;
}

interface LinkEdgeData extends Record<string, unknown> {
  route: readonly Point[];
}

type ManagerFlowNode = Node<ManagerNodeData, 'manager'>;
type ThreadFlowNode = Node<ThreadNodeData, 'thread'>;
type MoreFlowNode = Node<MoreNodeData, 'more'>;
type GraphFlowNode = ManagerFlowNode | ThreadFlowNode | MoreFlowNode;
type LinkFlowEdge = Edge<LinkEdgeData, 'link'>;

interface GraphActions {
  open: (threadId: string) => void;
  manager: () => void;
}

const GraphActionsContext = createContext<GraphActions>({
  open: () => undefined,
  manager: () => undefined,
});

const HIDDEN_HANDLE = { opacity: 0, pointerEvents: 'none' } as const;

/**
 * The node's two wire ends, in the DOM as well as on the node: once React Flow
 * measures a drawn node it reads its handles from here, and a node without
 * them loses every wire.
 */
function WireEnds(): React.JSX.Element {
  return (
    <>
      <Handle
        id="in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={HIDDEN_HANDLE}
      />
      <Handle
        id="out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={HIDDEN_HANDLE}
      />
    </>
  );
}

const statVariants = cva(
  'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs tabular-nums',
  {
    variants: {
      tone: {
        plain: 'bg-muted text-foreground',
        working: 'bg-primary/12 text-primary',
        awaiting: 'bg-warning/15 text-warning',
        start: 'bg-accent text-accent-foreground',
      },
    },
  },
);

function Stat({
  slot,
  tone,
  count,
  word,
}: {
  slot: string;
  tone: 'plain' | 'working' | 'awaiting' | 'start';
  count: number;
  word: string;
}): React.JSX.Element {
  return (
    <span data-slot={slot} className={statVariants({ tone })}>
      <span className="font-semibold">{count}</span>
      {word}
    </span>
  );
}

function ManagerNode({ data }: NodeProps<ManagerFlowNode>): React.JSX.Element {
  const { manager: openManager } = useContext(GraphActionsContext);
  const { manager, threads, working, awaiting, pendingStarts, now } = data;
  const started = manager !== null;
  const line = started
    ? [
        manager.agentLabel,
        manager.model,
        manager.lastActivityAt === null
          ? null
          : `active ${formatUpdated(manager.lastActivityAt, now)}`,
      ]
        .filter((part) => part !== null && part !== '')
        .join(' · ')
    : 'Not started — write to it to run your threads in plain words';
  const state = !started ? 'Not started' : manager.working ? 'Working' : 'Idle';
  return (
    <>
      <WireEnds />
      <button
        type="button"
        data-slot="graph-manager"
        data-started={started}
        aria-label={`Manager, ${state}: ${threads} threads, ${working} working, ${awaiting} awaiting a reply, ${pendingStarts} waiting to start. Open the chat`}
        onClick={openManager}
        className="flex size-full flex-col justify-between gap-2 rounded-card border border-primary/50 bg-linear-to-b from-primary/10 to-card p-3 text-left shadow-md outline-none transition-[box-shadow,translate] duration-200 hover:-translate-y-px hover:shadow-lg focus-visible:ring-[3px] focus-visible:ring-ring/60 motion-reduce:transition-none motion-reduce:hover:translate-y-0">
        <span className="flex min-w-0 items-center gap-3">
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <RadioTower aria-hidden="true" className="size-4.5" />
            {started && manager.working ? (
              <span className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full bg-primary ring-2 ring-card motion-reduce:animate-none" />
            ) : null}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold">Manager</span>
              <span
                data-slot="graph-manager-state"
                className="rounded-pill bg-muted px-1.5 text-xs text-muted-foreground">
                {state}
              </span>
            </span>
            <span
              data-slot="graph-manager-line"
              className="truncate text-xs text-muted-foreground">
              {line}
            </span>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Stat
            slot="graph-manager-threads"
            tone="plain"
            count={threads}
            word={threads === 1 ? 'thread' : 'threads'}
          />
          {working > 0 ? (
            <Stat
              slot="graph-manager-working"
              tone="working"
              count={working}
              word="working"
            />
          ) : null}
          {awaiting > 0 ? (
            <Stat
              slot="graph-manager-awaiting"
              tone="awaiting"
              count={awaiting}
              word="awaiting reply"
            />
          ) : null}
          {pendingStarts > 0 ? (
            <Stat
              slot="graph-manager-starts"
              tone="start"
              count={pendingStarts}
              word={pendingStarts === 1 ? 'Start waiting' : 'Starts waiting'}
            />
          ) : null}
        </span>
      </button>
    </>
  );
}

function ThreadNode({ data }: NodeProps<ThreadFlowNode>): React.JSX.Element {
  const { open } = useContext(GraphActionsContext);
  const { thread, summary, height } = data;
  return (
    <div data-slot="graph-thread" data-thread-id={thread.id}>
      <WireEnds />
      <ThreadCard
        {...thread.view}
        summary={summary}
        height={height}
        onGo={() => open(thread.id)}
      />
    </div>
  );
}

function MoreNode({ data }: NodeProps<MoreFlowNode>): React.JSX.Element {
  return (
    <>
      <WireEnds />
      <span
        data-slot="graph-more"
        className="flex size-full items-center justify-center rounded-pill border border-dashed border-border-strong bg-card text-xs text-muted-foreground">
        +{data.count} more {data.count === 1 ? 'thread' : 'threads'}
      </span>
    </>
  );
}

function LinkEdge({ id, data }: EdgeProps<LinkFlowEdge>): React.JSX.Element {
  const path = roundedPath(data!.route, 10);
  return (
    <path
      aria-hidden="true"
      data-slot="graph-link"
      data-edge={id}
      d={path}
      style={pathStyle(path)}
      className="fill-none stroke-border-strong transition-[d] duration-300 ease-out motion-reduce:transition-none"
      strokeWidth={1.25}
      strokeDasharray="4 4"
      strokeLinecap="round"
    />
  );
}

const NODE_TYPES = {
  manager: ManagerNode,
  thread: ThreadNode,
  more: MoreNode,
};
const EDGE_TYPES = { contact: ContactEdge, link: LinkEdge };

function handlesFor(width: number, height: number): NodeHandle[] {
  return [
    { id: 'in', type: 'target', position: Position.Top, x: width / 2, y: 0 },
    {
      id: 'out',
      type: 'source',
      position: Position.Bottom,
      x: width / 2,
      y: height,
    },
  ];
}

function summaryOf(
  view: ThreadCardView,
  state: EdgeState,
  lastAt: string | null,
  now: number,
): string {
  return [
    view.title,
    THREAD_STATUS_TEXT[view.status],
    ...(view.idleDays === null ? [] : [`idle ${view.idleDays} days`]),
    ...(state === 'awaiting' ? ['awaiting a reply'] : []),
    lastAt === null
      ? 'no contact yet'
      : `last contact ${formatUpdated(lastAt, now)}`,
  ].join(', ');
}

/** One height for every thread card, the tallest one's, so the lines stay even. */
export function cardHeightOf(shown: readonly GraphThread[]): number {
  return Math.max(
    0,
    ...shown.map(({ view }) =>
      threadCardHeight({
        labels: hasLabels(view),
        note: view.note !== null,
        activity: activityLine(view.activity) !== '',
      }),
    ),
  );
}

/** What hangs under the manager, in the order it stands: each thread, then "+N more". */
export function graphItems(
  shown: readonly GraphThread[],
  hidden: number,
): GraphBox[] {
  const height = cardHeightOf(shown);
  return [
    ...shown.map((thread) => ({
      id: `thread:${thread.id}`,
      width: THREAD_CARD_WIDTH,
      height,
    })),
    ...(hidden > 0
      ? [{ id: MORE_ID, width: MORE_WIDTH, height: MORE_HEIGHT }]
      : []),
  ];
}

/** Which threads get a node: the newest by activity, then oldest first, so a node keeps its place. */
export function shownThreads(threads: readonly GraphThread[]): GraphThread[] {
  return threads
    .slice(0, MAX_THREAD_NODES)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The view that shows the graph across the canvas's width from its top, never
 * zoomed past 1: a card stays readable and a tall graph scrolls down, where a
 * whole-graph fit would shrink the cards to nothing.
 */
export function widthFit(
  graph: { width: number },
  canvas: { width: number },
): { x: number; y: number; zoom: number } {
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(1, (canvas.width - FIT_MARGIN * 2) / Math.max(1, graph.width)),
  );
  return {
    x: Math.max(FIT_MARGIN, (canvas.width - graph.width * zoom) / 2),
    y: FIT_MARGIN,
    zoom,
  };
}

function useElementSize(): [
  (el: HTMLDivElement | null) => void,
  { width: number; height: number },
] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (element === null) {
      return;
    }
    setSize({ width: element.clientWidth, height: element.clientHeight });
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(-1)?.contentRect;
      if (rect !== undefined) {
        setSize({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}

export function GraphView(props: GraphViewProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ZoomControls({ onFit }: { onFit: () => void }): React.JSX.Element {
  const flow = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const duration = reduced ? 0 : 200;
  return (
    <div
      role="group"
      aria-label="Zoom"
      className="absolute right-3 bottom-3 z-10 flex flex-col gap-1 rounded-control border border-border bg-card p-1 shadow-sm">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Zoom in"
        onClick={() => void flow.zoomIn({ duration })}>
        <Plus aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Zoom out"
        onClick={() => void flow.zoomOut({ duration })}>
        <Minus aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Fit the graph"
        onClick={onFit}>
        <Maximize aria-hidden="true" />
      </Button>
    </div>
  );
}

function GraphCanvas({
  manager,
  pendingStarts,
  threads,
  contacts,
  pulses,
  now,
  narrow,
  onOpen,
  onManager,
  className,
}: GraphViewProps): React.JSX.Element {
  const flow = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const [measure, size] = useElementSize();
  const fitted = useRef<string | null>(null);

  const shown = shownThreads(threads);
  const hidden = threads.length - shown.length;
  const items = graphItems(shown, hidden);
  const cardHeight = cardHeightOf(shown);
  const lines = linesFor(items.length);
  const root: GraphBox = {
    id: MANAGER_ID,
    width: narrow ? MANAGER_WIDTH_NARROW : MANAGER_WIDTH,
    height: MANAGER_HEIGHT,
  };
  const drawn: GraphGeometry = narrow
    ? layoutColumn(root, items)
    : layoutLines(root, items, lines);

  const fit = useLatestCallback((animate: boolean) => {
    void flow.setViewport(widthFit(drawn, size), {
      duration: animate && !reduced ? FIT_MS : 0,
    });
  }, []);
  const fitKey = `${lines}:${items.length}#${Math.round(size.width)}x${Math.round(size.height)}`;
  useLayoutEffect(() => {
    if (narrow || size.width === 0 || fitted.current === fitKey) {
      return;
    }
    const first = fitted.current === null;
    fitted.current = fitKey;
    fit(!first);
  }, [fitKey, narrow, size.width, fit]);

  const open = useLatestCallback(onOpen, []);
  const openManager = useLatestCallback(onManager, []);

  const states = new Map(
    shown.map((thread) => {
      const contact = contacts[thread.id];
      const threadPulses = pulses.filter(
        (pulse) => pulse.threadId === thread.id,
      );
      return [
        thread.id,
        {
          contact,
          pulses: threadPulses,
          state: edgeStateOf(contact, threadPulses, now),
        },
      ] as const;
    }),
  );
  const awaiting = [...states.values()].filter(
    (entry) => entry.state === 'awaiting',
  ).length;
  const working = threads.filter(
    (thread) => thread.view.status === 'working',
  ).length;

  const base = (id: string) => {
    const box = drawn.boxes.get(id)!;
    return {
      id,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      handles: handlesFor(box.width, box.height),
      className: NODE_CLASS,
      selectable: false,
      draggable: false,
      focusable: false,
    };
  };
  const nodes: GraphFlowNode[] = [
    {
      ...base(MANAGER_ID),
      type: 'manager',
      data: {
        manager,
        threads: threads.length,
        working,
        awaiting,
        pendingStarts,
        now,
      },
    },
  ];
  const contactEdges: ContactFlowEdge[] = [];
  const linkEdges: LinkFlowEdge[] = [];
  for (const thread of shown) {
    const id = `thread:${thread.id}`;
    const entry = states.get(thread.id)!;
    nodes.push({
      ...base(id),
      type: 'thread',
      data: {
        thread,
        height: cardHeight,
        summary: summaryOf(
          thread.view,
          entry.state,
          entry.contact?.lastAt ?? null,
          now,
        ),
      },
    });
    const wire = drawn.routes.get(id);
    if (wire !== undefined) {
      contactEdges.push({
        id: `contact:${thread.id}`,
        type: 'contact',
        source: MANAGER_ID,
        sourceHandle: 'out',
        target: id,
        targetHandle: 'in',
        focusable: false,
        selectable: false,
        data: { route: wire, state: entry.state, pulses: entry.pulses, now },
      });
    }
  }
  if (hidden > 0) {
    nodes.push({ ...base(MORE_ID), type: 'more', data: { count: hidden } });
    const route = drawn.routes.get(MORE_ID);
    if (route !== undefined) {
      linkEdges.push({
        id: `link:${MORE_ID}`,
        type: 'link',
        source: MANAGER_ID,
        sourceHandle: 'out',
        target: MORE_ID,
        targetHandle: 'in',
        focusable: false,
        selectable: false,
        data: { route },
      });
    }
  }
  const edges: (ContactFlowEdge | LinkFlowEdge)[] = [
    ...linkEdges,
    ...contactEdges.sort(
      (a, b) =>
        EDGE_PAINT_ORDER[a.data!.state] - EDGE_PAINT_ORDER[b.data!.state],
    ),
  ];

  const label = `Manager and ${shown.length} ${shown.length === 1 ? 'thread' : 'threads'}`;
  const flowProps = {
    nodes,
    edges,
    nodeTypes: NODE_TYPES,
    edgeTypes: EDGE_TYPES,
    onNodeClick: POINTER_ON_NODES,
    nodesDraggable: false,
    nodesConnectable: false,
    nodesFocusable: false,
    edgesFocusable: false,
    elementsSelectable: false,
    disableKeyboardA11y: true,
    deleteKeyCode: null,
    selectionKeyCode: null,
    multiSelectionKeyCode: null,
    panActivationKeyCode: null,
    zoomActivationKeyCode: null,
    proOptions: PRO_OPTIONS,
  };

  return (
    <GraphActionsContext.Provider value={{ open, manager: openManager }}>
      {narrow ? (
        <div
          role="group"
          aria-label={label}
          data-slot="command-center-graph"
          data-layout="column"
          className={cn('overflow-y-auto', className)}>
          <div
            className="mx-auto"
            style={{ width: drawn.width, height: drawn.height }}>
            <ReactFlow
              {...flowProps}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              panOnDrag={false}
              panOnScroll={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              preventScrolling={false}
            />
          </div>
        </div>
      ) : (
        <div
          ref={measure}
          role="group"
          aria-label={label}
          data-slot="command-center-graph"
          data-layout="lines"
          data-lines={lines}
          className={cn('relative', className)}>
          {size.width === 0 ? null : (
            <>
              <ReactFlow
                {...flowProps}
                defaultViewport={widthFit(drawn, size)}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                translateExtent={[
                  [-PAN_ROOM, -PAN_ROOM],
                  [drawn.width + PAN_ROOM, drawn.height + PAN_ROOM],
                ]}
                panOnDrag
                panOnScroll
                zoomOnScroll={false}
                zoomOnPinch
                zoomOnDoubleClick={false}
              />
              <ZoomControls onFit={() => fit(true)} />
            </>
          )}
        </div>
      )}
    </GraphActionsContext.Provider>
  );
}
