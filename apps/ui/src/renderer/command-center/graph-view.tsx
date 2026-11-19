import '@xyflow/react/dist/style.css';

import {
  type Edge,
  type EdgeProps,
  Handle,
  type Node,
  type NodeChange,
  type NodeHandle,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import { cva } from 'class-variance-authority';
import { Maximize, Minus, Plus, RadioTower, RotateCcw } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { type Point, roundedPath } from '../components/stage-graph-layout';
import type { ThreadAttention } from '../components/thread-labels';
import { Button } from '../components/ui/button';
import { PaletteDot } from '../components/ui/palette-dot';
import { cn } from '../components/ui/utils';
import { useElementSize } from '../components/use-element-size';
import { useLatestCallback } from '../components/use-latest-callback';
import { formatUpdated } from '../teams/format-updated';
import {
  ATTENTION_ORDER,
  MANAGER_TITLE,
  orderByAttention,
  type ThreadCardView,
} from './card-view';
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
  bandRows,
  type GraphBox,
  type GraphGeometry,
  layoutColumn,
  layoutRows,
  perLineFor,
  type PlacedBox,
} from './graph-layout';
import type { NodeOffset, NodeOffsets } from './node-positions';
import type { CardBand, CardSize } from './open-cards';
import type { ProjectColor } from './project-colors';
import {
  ATTENTION_TEXT,
  attentionDotVariants,
  THREAD_CARD_WIDTH,
  ThreadCard,
  threadCardHeight,
  threadCardIdentity,
} from './thread-card';
import {
  type CanvasCard,
  CARD_HEAD_HEIGHT,
  clampCard,
  DRAG_THRESHOLD,
  largestCard,
  PhoneThreadCard,
  ThreadCardLayer,
} from './thread-card-layer';

export const MAX_THREAD_NODES = 24;

export interface GraphThread {
  id: string;
  createdAt: string;
  view: ThreadCardView;
}

/** A thread open as a card on the canvas: where it stood when it opened, and the size it is at. */
export interface GraphOpenCard {
  runId: string;
  band: CardBand;
  size: CardSize;
}

/** The thread to bring into view, once per `seq`. */
export interface GraphFocus {
  runId: string;
  seq: number;
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
  /** Every thread; drawn by attention, the first {@link MAX_THREAD_NODES} of that order. */
  threads: readonly GraphThread[];
  contacts: Readonly<Record<string, ContactState>>;
  pulses: readonly ContactPulse[];
  now: number;
  /** One column for a narrow screen, scrolled rather than panned. */
  narrow: boolean;
  /** Whether the page is on screen, so a phone's open card may hold a back entry. */
  active: boolean;
  /** Leave the command center for the thread in Chats. */
  onOpenInChats: (threadId: string) => void;
  /** Open the thread as a card in its node's place, or turn the card back into its node. */
  onToggleCard: (threadId: string) => void;
  /** The threads open as cards, in the order they opened. */
  openCards: readonly GraphOpenCard[];
  onCloseCard: (threadId: string) => void;
  onResizeCard: (threadId: string, size: CardSize) => void;
  /** Where the nodes the user moved stand, by thread, from the manager node's top-left. */
  positions: NodeOffsets;
  /** A thread's node or card was dropped at `offset` from the manager node's top-left. */
  onPlaceNode: (threadId: string, offset: NodeOffset) => void;
  /** Give every moved node back to the automatic layout. */
  onResetLayout: () => void;
  /** The chat a card holds under its head. */
  renderCardChat: (threadId: string) => React.ReactNode;
  /** The thread to pan to and flash; null for none. */
  focus: GraphFocus | null;
  /** The focus of this `seq` was handled, so it is never replayed on a later mount. */
  onFocused: (seq: number) => void;
  /** The projects of the threads on the graph, each with its colour, for the legend. */
  projects: readonly ProjectColor[];
  /** Threads holding a question or an approval the user can answer here, by what they hold. */
  asking: ReadonlyMap<string, 'question' | 'approval'>;
  /** Answer the thread's card from its node's Answer button, the anchor it is shown at. */
  onAnswer: (threadId: string, anchor: HTMLElement) => void;
  /** The view started to pan or zoom, which leaves anything hung from a node behind. */
  onViewportMove?: () => void;
  className?: string;
}

const MANAGER_ID = 'manager';
const MORE_ID = 'more';
const MANAGER_WIDTH = 380;
const MANAGER_WIDTH_NARROW = THREAD_CARD_WIDTH;
const MANAGER_HEIGHT = 84;
const MANAGER_HEIGHT_NARROW = 112;
const MORE_WIDTH = 160;
const MORE_HEIGHT = 32;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
const FIT_MARGIN = 16;
const FIT_MS = 400;
const PAN_ROOM = 160;
const FLASH_MS = 1200;
/** How long after a move of the view's own a start of motion is still that move, not the user's. */
const QUIET_MOVE_SLACK_MS = 120;
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
  asking: 'question' | 'approval' | null;
}

interface MoreNodeData extends Record<string, unknown> {
  count: number;
}

interface LinkEdgeData extends Record<string, unknown> {
  route: readonly Point[];
}

type ManagerFlowNode = Node<ManagerNodeData, 'manager'>;
type ThreadFlowNode = Node<ThreadNodeData, 'thread'>;
type SlotFlowNode = Node<ThreadNodeData, 'slot'>;
type MoreFlowNode = Node<MoreNodeData, 'more'>;
type GraphFlowNode =
  ManagerFlowNode | ThreadFlowNode | SlotFlowNode | MoreFlowNode;
type LinkFlowEdge = Edge<LinkEdgeData, 'link'>;

interface GraphActions {
  openInChats: (threadId: string) => void;
  toggleCard: (threadId: string) => void;
  answer: (threadId: string, anchor: HTMLElement) => void;
}

const GraphActionsContext = createContext<GraphActions>({
  openInChats: () => undefined,
  toggleCard: () => undefined,
  answer: () => undefined,
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
      <section
        data-slot="graph-manager"
        data-started={started}
        aria-label={`Manager, ${state}: ${threads} threads, ${working} working, ${awaiting} awaiting a reply, ${pendingStarts} waiting to start`}
        className={cn(
          'flex size-full flex-col gap-2.5 rounded-card border border-primary/50 bg-linear-to-b from-primary/10 to-card px-3 py-2.5 text-left shadow-md',
          started && manager.working && 'cc-breathe-primary',
        )}>
        <span className="flex min-w-0 items-center gap-3">
          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <RadioTower aria-hidden="true" className="size-4.5" />
            {started && manager.working ? (
              <span className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full bg-primary ring-2 ring-card motion-reduce:animate-none" />
            ) : null}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold">{MANAGER_TITLE}</span>
              <span
                data-slot="graph-manager-state"
                className={cn(
                  'rounded-pill px-1.5 text-xs',
                  started && manager.working
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-foreground/80',
                )}>
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
      </section>
    </>
  );
}

function ThreadNode({ data }: NodeProps<ThreadFlowNode>): React.JSX.Element {
  const { openInChats, toggleCard, answer } = useContext(GraphActionsContext);
  const { thread, summary, asking } = data;
  return (
    <div
      data-slot="graph-thread"
      data-thread-id={thread.id}
      className="cc-node-in">
      <WireEnds />
      <ThreadCard
        {...thread.view}
        summary={summary}
        onOpenInChats={() => openInChats(thread.id)}
        onToggleCard={() => toggleCard(thread.id)}
        answerKind={asking}
        onAnswer={
          asking === null ? undefined : (anchor) => answer(thread.id, anchor)
        }
      />
    </div>
  );
}

/** The place an open thread's card holds in the graph: its wire ends and an outline the card stands on. */
function SlotNode({ data }: NodeProps<SlotFlowNode>): React.JSX.Element {
  return (
    <>
      <WireEnds />
      <div
        aria-label={data.summary}
        data-slot="graph-slot"
        data-thread-id={data.thread.id}
        className="size-full rounded-card border border-dashed border-border-strong"
      />
    </>
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
  slot: SlotNode,
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
    view.statusText,
    ATTENTION_TEXT[view.attention],
    ...(view.idleDays === null ? [] : [`idle ${view.idleDays} days`]),
    ...(state === 'awaiting' ? ['awaiting a reply'] : []),
    lastAt === null
      ? 'no contact yet'
      : `last contact ${formatUpdated(lastAt, now)}`,
  ].join(', ');
}

/** The box an open thread's card takes in the graph at zoom 1. */
export function cardBox(size: CardSize): { width: number; height: number } {
  return { width: size.width, height: CARD_HEAD_HEIGHT + size.height };
}

/**
 * The threads in bands by attention, each band on lines of its own, then
 * "+N more" alone. A thread whose card is open stands in the band it had when
 * the card opened, as big as its card.
 */
export function graphRows(
  shown: readonly GraphThread[],
  hidden: number,
  canvasWidth = 0,
  open: ReadonlyMap<string, GraphOpenCard> = new Map(),
): GraphBox[][] {
  const boxOf = (thread: GraphThread): GraphBox => {
    const card = open.get(thread.id);
    return {
      id: `thread:${thread.id}`,
      ...(card === undefined
        ? {
            width: THREAD_CARD_WIDTH,
            height: threadCardHeight(thread.view),
          }
        : cardBox(card.size)),
    };
  };
  const bandOf = (thread: GraphThread): ThreadAttention =>
    open.get(thread.id)?.band.attention ?? thread.view.attention;
  const bands = ATTENTION_ORDER.map((attention) =>
    shown.filter((thread) => bandOf(thread) === attention).map(boxOf),
  );
  return [
    ...bandRows(
      bands,
      perLineFor(shown.length, canvasWidth, THREAD_CARD_WIDTH),
    ),
    ...(hidden > 0
      ? [[{ id: MORE_ID, width: MORE_WIDTH, height: MORE_HEIGHT }]]
      : []),
  ];
}

/**
 * Which threads get a node: the first {@link MAX_THREAD_NODES} by attention,
 * and every thread open as a card wherever it falls. An open card's thread
 * keeps the band and the order it had when it opened.
 */
export function shownThreads(
  threads: readonly GraphThread[],
  open: ReadonlyMap<string, Pick<GraphOpenCard, 'band'>> = new Map(),
): GraphThread[] {
  const keyed = threads.map((thread) => ({
    id: thread.id,
    createdAt: thread.createdAt,
    view: open.get(thread.id)?.band ?? thread.view,
    thread,
  }));
  return orderByAttention(keyed)
    .filter((entry, index) => index < MAX_THREAD_NODES || open.has(entry.id))
    .map((entry) => entry.thread);
}

/** How many threads stand in each attention band. */
export function attentionCounts(
  threads: readonly GraphThread[],
): ReadonlyMap<ThreadAttention, number> {
  const counts = new Map<ThreadAttention, number>();
  for (const thread of threads) {
    counts.set(
      thread.view.attention,
      (counts.get(thread.view.attention) ?? 0) + 1,
    );
  }
  return counts;
}

function AttentionLegend({
  threads,
}: {
  threads: readonly GraphThread[];
}): React.JSX.Element {
  const counts = attentionCounts(threads);
  return (
    <ul
      aria-label="Threads by attention"
      data-slot="graph-legend"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-xs">
      {ATTENTION_ORDER.filter(
        (attention) => (counts.get(attention) ?? 0) > 0,
      ).map((attention) => (
        <li
          key={attention}
          data-slot="graph-legend-item"
          data-attention={attention}
          className="flex items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden="true"
            className={attentionDotVariants({ attention })}
          />
          {ATTENTION_TEXT[attention]}
          <span className="font-semibold text-foreground tabular-nums">
            {counts.get(attention)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProjectLegend({
  projects,
  className,
}: {
  projects: readonly ProjectColor[];
  className?: string;
}): React.JSX.Element | null {
  if (projects.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label="Projects"
      data-slot="graph-projects"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs',
        className,
      )}>
      {projects.map((project) => (
        <li
          key={project.id}
          data-slot="graph-project"
          data-color={project.color}
          title={`Project ${project.name}`}
          className="flex max-w-40 min-w-0 items-center gap-1.5 text-muted-foreground">
          <PaletteDot color={project.color} size="md" />
          <span className="truncate">{project.name}</span>
        </li>
      ))}
    </ul>
  );
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

/** The view that shows the WHOLE graph in the canvas, centred, never zoomed past 1 — the Fit button's. */
export function wholeFit(
  graph: { width: number; height: number },
  canvas: { width: number; height: number },
): { x: number; y: number; zoom: number } {
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(
      1,
      (canvas.width - FIT_MARGIN * 2) / Math.max(1, graph.width),
      (canvas.height - FIT_MARGIN * 2) / Math.max(1, graph.height),
    ),
  );
  return {
    x: Math.max(FIT_MARGIN, (canvas.width - graph.width * zoom) / 2),
    y: Math.max(FIT_MARGIN, (canvas.height - graph.height * zoom) / 2),
    zoom,
  };
}

export function GraphView(props: GraphViewProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ZoomControls({
  onFit,
  onReset,
}: {
  onFit: () => void;
  onReset: (() => void) | null;
}): React.JSX.Element {
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
      {onReset === null ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          data-slot="graph-reset-layout"
          aria-label="Reset layout"
          title="Reset layout"
          onClick={onReset}>
          <RotateCcw aria-hidden="true" />
        </Button>
      )}
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
  active,
  onOpenInChats,
  onToggleCard,
  openCards,
  onCloseCard,
  onResizeCard,
  positions,
  onPlaceNode,
  onResetLayout,
  renderCardChat,
  focus,
  onFocused,
  projects,
  asking,
  onAnswer,
  onViewportMove,
  className,
}: GraphViewProps): React.JSX.Element {
  const flow = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const [measure, size] = useElementSize();
  const fittedSize = useRef<string | null>(null);
  const fittedWidth = useRef<number | null>(null);
  const userMoved = useRef(false);
  const quietUntil = useRef(0);
  const focused = useRef<number | null>(null);
  const [flashing, setFlashing] = useState<GraphFocus | null>(null);
  const [drag, setDrag] = useState<{ id: string; offset: NodeOffset } | null>(
    null,
  );
  const panZoomReady = useStore((state) => state.panZoom !== null);

  const largest = size.width === 0 ? null : largestCard(size);
  const open = new Map(
    openCards.map((card) => [
      card.runId,
      largest === null
        ? card
        : { ...card, size: clampCard(card.size, largest) },
    ]),
  );
  const onCanvas: ReadonlyMap<string, GraphOpenCard> = narrow
    ? new Map()
    : open;
  const shown = shownThreads(threads, open);
  const hidden = threads.length - shown.length;
  const canvasWidth = narrow ? 0 : size.width;
  const rows = graphRows(shown, hidden, canvasWidth, onCanvas);
  const root: GraphBox = {
    id: MANAGER_ID,
    width: narrow ? MANAGER_WIDTH_NARROW : MANAGER_WIDTH,
    height: narrow ? MANAGER_HEIGHT_NARROW : MANAGER_HEIGHT,
  };
  const pinned = new Map<string, NodeOffset>();
  if (!narrow) {
    for (const thread of shown) {
      const offset = positions[thread.id];
      if (offset !== undefined) {
        pinned.set(`thread:${thread.id}`, offset);
      }
    }
    if (drag !== null) {
      pinned.set(drag.id, drag.offset);
    }
  }
  const drawn: GraphGeometry = narrow
    ? layoutColumn(root, rows.flat())
    : layoutRows(root, rows, pinned);
  const unopened =
    onCanvas.size === 0 && pinned.size === 0
      ? drawn
      : layoutRows(root, graphRows(shown, hidden, canvasWidth));
  const placedRoot = drawn.boxes.get(MANAGER_ID)!;
  const offsetOf = (position: { x: number; y: number }): NodeOffset => ({
    x: position.x - placedRoot.x,
    y: position.y - placedRoot.y,
  });

  const moveQuietly = (duration: number): void => {
    quietUntil.current = performance.now() + duration + QUIET_MOVE_SLACK_MS;
  };
  const fit = useLatestCallback((animate: boolean) => {
    const duration = animate && !reduced ? FIT_MS : 0;
    moveQuietly(duration);
    void flow.setViewport(widthFit(unopened, size), { duration });
  }, []);
  const sizeKey = `${Math.round(size.width)}x${Math.round(size.height)}`;
  const graphWidth = Math.round(unopened.width);
  useLayoutEffect(() => {
    if (narrow || size.width === 0) {
      return;
    }
    const resized = fittedSize.current !== sizeKey;
    const grown = fittedWidth.current !== graphWidth;
    if (!resized && !(grown && !userMoved.current)) {
      return;
    }
    const first = fittedSize.current === null;
    fittedSize.current = sizeKey;
    fittedWidth.current = graphWidth;
    userMoved.current = false;
    fit(!first);
  }, [sizeKey, graphWidth, narrow, size.width, fit]);

  const focusSlot =
    focus === null ? undefined : drawn.boxes.get(`thread:${focus.runId}`);
  useEffect(() => {
    if (focus === null || focused.current === focus.seq) {
      return;
    }
    if (narrow) {
      focused.current = focus.seq;
      onFocused(focus.seq);
      return;
    }
    if (size.width === 0 || !panZoomReady || focusSlot === undefined) {
      return;
    }
    focused.current = focus.seq;
    const zoom = flow.getZoom();
    const room = size.height - FIT_MARGIN * 2;
    const y =
      focusSlot.height <= room
        ? focusSlot.y + focusSlot.height / 2 / zoom
        : focusSlot.y + (size.height / 2 - FIT_MARGIN) / zoom;
    const duration = reduced ? 0 : FIT_MS;
    moveQuietly(duration);
    void flow.setCenter(
      focusSlot.x + Math.min(focusSlot.width, size.width) / 2 / zoom,
      y,
      { zoom, duration },
    );
    setFlashing(focus);
    onFocused(focus.seq);
  }, [focus, focusSlot, narrow, size, panZoomReady, flow, reduced, onFocused]);
  useEffect(() => {
    if (flashing === null) {
      return;
    }
    const timer = setTimeout(() => setFlashing(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashing]);

  const openInChats = useLatestCallback(onOpenInChats, []);
  const toggleCard = useLatestCallback(onToggleCard, []);
  const answer = useLatestCallback(onAnswer, []);
  const viewportMoved = useLatestCallback(() => {
    if (performance.now() < quietUntil.current) {
      return;
    }
    userMoved.current = true;
    onViewportMove?.();
  }, []);
  const nodesChanged = useLatestCallback(
    (changes: NodeChange<GraphFlowNode>[]) => {
      for (const change of changes) {
        if (
          change.type === 'position' &&
          change.dragging === true &&
          change.position !== undefined
        ) {
          setDrag({ id: change.id, offset: offsetOf(change.position) });
        }
      }
    },
    [],
  );
  const nodeDropped = useLatestCallback(
    (_event: unknown, node: GraphFlowNode) => {
      if (node.type === 'thread') {
        onPlaceNode(node.data.thread.id, offsetOf(node.position));
      }
      setDrag(null);
    },
    [],
  );
  const cardMoved = useLatestCallback(
    (runId: string, to: { x: number; y: number }, done: boolean) => {
      if (done) {
        onPlaceNode(runId, offsetOf(to));
        setDrag(null);
      } else {
        setDrag({ id: `thread:${runId}`, offset: offsetOf(to) });
      }
    },
    [],
  );

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
      className: drag?.id === id ? undefined : NODE_CLASS,
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
  const slots = new Map<string, PlacedBox>();
  const canvasCards: CanvasCard[] = [];
  for (const thread of shown) {
    const id = `thread:${thread.id}`;
    const entry = states.get(thread.id)!;
    const card = onCanvas.get(thread.id);
    const data = {
      thread,
      asking: asking.get(thread.id) ?? null,
      summary: summaryOf(
        thread.view,
        entry.state,
        entry.contact?.lastAt ?? null,
        now,
      ),
    };
    if (card === undefined) {
      nodes.push({ ...base(id), type: 'thread', data, draggable: !narrow });
    } else {
      nodes.push({ ...base(id), type: 'slot', data });
      slots.set(thread.id, drawn.boxes.get(id)!);
      canvasCards.push({
        runId: thread.id,
        identity: threadCardIdentity(thread.view),
        attention: thread.view.attention,
        size: card.size,
      });
    }
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
  const overhang = canvasCards.reduce(
    (most, card) => ({
      x: Math.max(most.x, card.size.width),
      y: Math.max(most.y, cardBox(card.size).height),
    }),
    { x: 0, y: 0 },
  );
  const stretch = 1 / MIN_ZOOM - 1;
  const placedBoxes = [...drawn.boxes.values()];
  const leftmost = Math.min(0, ...placedBoxes.map((box) => box.x));
  const topmost = Math.min(0, ...placedBoxes.map((box) => box.y));

  const phoneCard = narrow ? openCards.at(-1) : undefined;
  const phoneThread =
    phoneCard === undefined
      ? undefined
      : threads.find((thread) => thread.id === phoneCard.runId);

  const label = `Manager and ${shown.length} ${shown.length === 1 ? 'thread' : 'threads'}`;
  const flowProps = {
    nodes,
    edges,
    nodeTypes: NODE_TYPES,
    edgeTypes: EDGE_TYPES,
    onNodeClick: POINTER_ON_NODES,
    onNodesChange: nodesChanged,
    onNodeDragStop: nodeDropped,
    nodeDragThreshold: DRAG_THRESHOLD,
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
    <GraphActionsContext.Provider value={{ openInChats, toggleCard, answer }}>
      {narrow ? (
        <div
          role="group"
          aria-label={label}
          data-slot="command-center-graph"
          data-layout="column"
          className={cn('relative flex flex-col', className)}>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AttentionLegend threads={threads} />
            <ProjectLegend projects={projects} className="px-4 pt-1.5" />
            <div
              className="cc-touch-scroll mx-auto"
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
          {phoneCard === undefined || phoneThread === undefined ? null : (
            <PhoneThreadCard
              card={{
                runId: phoneThread.id,
                identity: threadCardIdentity(phoneThread.view),
                attention: phoneThread.view.attention,
                size: phoneCard.size,
              }}
              active={active}
              onClose={() => onCloseCard(phoneThread.id)}
              onOpenInChats={() => openInChats(phoneThread.id)}
              chat={renderCardChat(phoneThread.id)}
            />
          )}
        </div>
      ) : (
        <div
          role="group"
          aria-label={label}
          data-slot="command-center-graph"
          data-layout="bands"
          data-rows={rows.length}
          className={cn('flex flex-col', className)}>
          <AttentionLegend threads={threads} />
          <div ref={measure} className="relative min-h-0 flex-1">
            {size.width === 0 ? null : (
              <>
                <ReactFlow
                  {...flowProps}
                  defaultViewport={widthFit(unopened, size)}
                  minZoom={MIN_ZOOM}
                  maxZoom={MAX_ZOOM}
                  translateExtent={[
                    [leftmost - PAN_ROOM, topmost - PAN_ROOM],
                    [
                      drawn.width + PAN_ROOM + overhang.x * stretch,
                      drawn.height + PAN_ROOM + overhang.y * stretch,
                    ],
                  ]}
                  panOnDrag
                  panOnScroll
                  zoomOnScroll={false}
                  zoomOnPinch
                  zoomOnDoubleClick={false}
                  onMoveStart={viewportMoved}
                />
                <ProjectLegend
                  projects={projects}
                  className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-5rem)] rounded-control border border-border bg-card/95 px-2.5 py-1.5 shadow-sm"
                />
                <ZoomControls
                  onFit={() =>
                    void flow.setViewport(wholeFit(drawn, size), {
                      duration: reduced ? 0 : FIT_MS,
                    })
                  }
                  onReset={
                    Object.keys(positions).length === 0 ? null : onResetLayout
                  }
                />
                <ThreadCardLayer
                  cards={canvasCards}
                  slots={slots}
                  pane={size}
                  flashing={flashing}
                  onClose={onCloseCard}
                  onResize={onResizeCard}
                  onMove={cardMoved}
                  onOpenInChats={openInChats}
                  renderChat={renderCardChat}
                />
              </>
            )}
          </div>
        </div>
      )}
    </GraphActionsContext.Provider>
  );
}
