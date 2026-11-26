import '@xyflow/react/dist/style.css';

import {
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
import {
  Maximize,
  Minus,
  Plus,
  RadioTower,
  RotateCcw,
  ZoomIn,
} from 'lucide-react';
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ThreadAttention } from '../components/thread-labels';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { useElementSize } from '../components/use-element-size';
import { useLatestCallback } from '../components/use-latest-callback';
import { formatUpdated } from '../teams/format-updated';
import type { BlockOrders } from './block-orders';
import type { BlockPlaces } from './block-places';
import {
  ATTENTION_ORDER,
  isWorkingThread,
  MANAGER_TITLE,
  type ThreadCardView,
} from './card-view';
import {
  ContactEdge,
  type ContactFlowEdge,
  type ContactPulse,
  type ContactState,
  type EdgeState,
  edgeStateOf,
  usePrefersReducedMotion,
} from './contact-edge';
import {
  BLOCK_HEAD,
  CENTRE_DEPTH,
  type GraphBox,
  type GraphGeometry,
  type LayoutBlock,
  layoutBlocks,
  layoutColumn,
  perLineFor,
  type PlacedBox,
  slotIndexFor,
  withBlockAt,
  withBlockItems,
  withBoxAt,
} from './graph-layout';
import {
  type GraphThread,
  orderedBlocks,
  threadsByAttention,
} from './graph-order';
import type { NodeOffset, NodeOffsets } from './node-positions';
import type { CardBand, CardSize } from './open-cards';
import { NO_PROJECT_NAME, ProjectBlock } from './project-block';
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
import { useWheelLatch, wheelStep } from './wheel-latch';

export const MAX_THREAD_NODES = 24;

export type { GraphThread } from './graph-order';

/** A thread open as a card on the canvas: where it stood when it opened, and the size it is at. */
export interface GraphOpenCard {
  runId: string;
  band: CardBand;
  size: CardSize;
  aboveWindow: boolean;
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
  /** A thread's node or card was dropped back inside its own block, which takes it back. */
  onUnplaceNode: (threadId: string) => void;
  /** Where the project blocks the user moved stand, by block id, from the manager node's top-left. */
  blockPlaces: BlockPlaces;
  /** A project block was dropped by its header at `offset` from the manager node's top-left. */
  onPlaceBlock: (blockId: string, offset: NodeOffset) => void;
  /** The order the user set for each block's threads, by block id. */
  blockOrders: BlockOrders;
  /** A card was dropped inside its own block, whose threads now stand in `runIds` order. */
  onOrderBlock: (blockId: string, runIds: readonly string[]) => void;
  /** Give every moved node and block, and every order set, back to the automatic layout. */
  onResetLayout: () => void;
  /** The chat a card holds under its head. */
  renderCardChat: (threadId: string) => React.ReactNode;
  /** Draw the open cards not opened from the manager's window over it rather than under it. */
  cardsInFront?: boolean;
  /** A press landed in an open card not opened from the manager's window. */
  onActivateCards?: () => void;
  /** The thread to pan to and flash; null for none. */
  focus: GraphFocus | null;
  /** The focus of this `seq` was handled, so it is never replayed on a later mount. */
  onFocused: (seq: number) => void;
  /** The projects of the threads on the graph, each with its colour, in the order their blocks stand. */
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
const MANAGER_WIDTH = 380;
const MANAGER_WIDTH_NARROW = THREAD_CARD_WIDTH;
const MANAGER_HEIGHT = 84;
const MANAGER_HEIGHT_NARROW = 112;
const MORE_WIDTH = 160;
const MORE_HEIGHT = 32;
function headingIdOf(blockId: string): string {
  return `heading:${blockId}`;
}

function dropSlotIdOf(runId: string): string {
  return `drop:${runId}`;
}

const THREAD_PREFIX = 'thread:';

/** What is being dragged: a thread's node or open card, or a project block by its header. */
type GraphDrag =
  | { kind: 'card'; id: string; runId: string; offset: NodeOffset }
  | { kind: 'block'; id: string; offset: NodeOffset };

/** What dropping a card where it is would do: `order` is its block's threads with it inside, null when it would be pinned. */
interface CardDrop {
  geometry: GraphGeometry;
  blockId: string;
  order: readonly string[] | null;
}

function moreIdOf(blockId: string): string {
  return `more:${blockId}`;
}
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
const FIT_MARGIN = 16;
const FIT_MS = 400;
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

interface BlockNodeData extends Record<string, unknown> {
  name: string;
  color: ProjectColor['color'] | null;
  threads: number;
  working: number;
  /** Whether the block moves when its header is dragged. */
  movable: boolean;
}

type ManagerFlowNode = Node<ManagerNodeData, 'manager'>;
type ThreadFlowNode = Node<ThreadNodeData, 'thread'>;
type SlotFlowNode = Node<ThreadNodeData, 'slot'>;
type MoreFlowNode = Node<MoreNodeData, 'more'>;
type BlockFlowNode = Node<BlockNodeData, 'block'>;
type DropSlotFlowNode = Node<Record<string, never>, 'dropSlot'>;
type GraphFlowNode =
  | ManagerFlowNode
  | ThreadFlowNode
  | SlotFlowNode
  | MoreFlowNode
  | BlockFlowNode
  | DropSlotFlowNode;

interface GraphActions {
  openInChats: (threadId: string) => void;
  toggleCard: (threadId: string) => void;
  answer: (threadId: string, anchor: HTMLElement) => void;
  /** A node's card was drawn this tall, which the layout gives it from then on. */
  measured: (threadId: string, height: number) => void;
}

const GraphActionsContext = createContext<GraphActions>({
  openInChats: () => undefined,
  toggleCard: () => undefined,
  answer: () => undefined,
  measured: () => undefined,
});

/** Tell the layout how tall `element` is drawn, now and whenever it changes. */
function useReportHeight(
  element: React.RefObject<HTMLElement | null>,
  report: (height: number) => void,
): void {
  const tell = useLatestCallback(report, []);
  useLayoutEffect(() => {
    const target = element.current;
    if (target === null) {
      return;
    }
    const send = (): void => {
      if (target.offsetHeight > 0) {
        tell(target.offsetHeight);
      }
    };
    send();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(send);
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, tell]);
}

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

function sameData<T extends Record<string, unknown>>(
  previous: { data: T },
  next: { data: T },
): boolean {
  const keys = Object.keys(next.data);
  return (
    keys.length === Object.keys(previous.data).length &&
    keys.every((key) => Object.is(previous.data[key], next.data[key]))
  );
}

const ManagerNode = memo(function ManagerNode({
  data,
}: NodeProps<ManagerFlowNode>): React.JSX.Element {
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
        className="flex size-full flex-col gap-2.5 rounded-card border border-primary/50 bg-linear-to-b from-primary/10 to-card px-3 py-2.5 text-left shadow-md">
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <RadioTower aria-hidden="true" className="size-4.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold">{MANAGER_TITLE}</span>
              <span
                data-slot="graph-manager-state"
                className={cn(
                  'flex items-center gap-1 rounded-pill px-1.5 text-xs',
                  started && manager.working
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-foreground/80',
                )}>
                {started && manager.working ? <Spinner pace="stepped" /> : null}
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
}, sameData);

const ThreadNode = memo(function ThreadNode({
  data,
}: NodeProps<ThreadFlowNode>): React.JSX.Element {
  const { openInChats, toggleCard, answer, measured } =
    useContext(GraphActionsContext);
  const { thread, summary, asking } = data;
  const drawn = useRef<HTMLDivElement | null>(null);
  useReportHeight(drawn, (height) => measured(thread.id, height));
  return (
    <div
      ref={drawn}
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
}, sameData);

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

/** The last line of a block whose threads passed the node cap: how many of them have no node. */
function MoreNode({ data }: NodeProps<MoreFlowNode>): React.JSX.Element {
  return (
    <span
      data-slot="graph-more"
      className="flex size-full items-center justify-center rounded-pill border border-dashed border-border-strong bg-card text-xs text-muted-foreground">
      +{data.count} more {data.count === 1 ? 'thread' : 'threads'}
    </span>
  );
}

/** One project's frame behind its threads, wired from the manager at its top; the pointer passes through it to the canvas, except on a draggable block's header, which moves it. */
const BlockNode = memo(function BlockNode({
  data: { movable, ...block },
}: NodeProps<BlockFlowNode>): React.JSX.Element {
  return (
    <>
      <WireEnds />
      <ProjectBlock
        {...block}
        headerClassName={movable ? BLOCK_HANDLE_CLASS : undefined}
      />
    </>
  );
}, sameData);

const BLOCK_HANDLE = 'cc-block-handle';
const BLOCK_HANDLE_CLASS = cn(
  BLOCK_HANDLE,
  'pointer-events-auto cursor-grab active:cursor-grabbing',
);

/** Where a dragged card lands inside its block: free room the size of the card. */
function DropSlotNode(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-slot="graph-drop-slot"
      className="size-full rounded-card border-2 border-dashed border-primary/60 bg-primary/5"
    />
  );
}

const NODE_TYPES = {
  manager: ManagerNode,
  thread: ThreadNode,
  slot: SlotNode,
  more: MoreNode,
  block: BlockNode,
  dropSlot: DropSlotNode,
};
const EDGE_TYPES = { contact: ContactEdge };

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

/** The threads of one project's block, and what its header says. */
export interface GraphBlock extends LayoutBlock {
  name: string;
  color: ProjectColor['color'] | null;
  /** The project's threads that have a node. */
  threads: readonly GraphThread[];
  /** Every thread of the project, those past the node cap included. */
  total: number;
}

/**
 * One block per project of `all`, in the order `projects` gives them, and one
 * for the threads of no project last; inside each, its `shown` threads, working
 * first and the rest by attention, and a "+N more" footer for those of `all`
 * left without a node. A thread whose card is open stands where it stood when
 * the card opened, as big as its card.
 */
export function graphBlocks(
  shown: readonly GraphThread[],
  projects: readonly ProjectColor[],
  open: ReadonlyMap<string, GraphOpenCard> = new Map(),
  heights: ReadonlyMap<string, number> = new Map(),
  all: readonly GraphThread[] = shown,
  orders: BlockOrders = {},
): GraphBlock[] {
  const boxOf = (thread: GraphThread): GraphBox => {
    const card = open.get(thread.id);
    return {
      id: `thread:${thread.id}`,
      ...(card === undefined
        ? {
            width: THREAD_CARD_WIDTH,
            height: heights.get(thread.id) ?? threadCardHeight(thread.view),
          }
        : cardBox(card.size)),
    };
  };
  const known = new Map(projects.map((project) => [project.id, project]));
  return orderedBlocks(shown, projects, open, all, orders).map(
    ({ id, projectId, threads, members }) => {
      const total = Math.max(members.length, threads.length);
      const project = projectId === null ? undefined : known.get(projectId);
      return {
        id,
        name:
          projectId === null
            ? NO_PROJECT_NAME
            : (project?.name ?? members[0]?.view.project ?? projectId),
        color: project?.color ?? null,
        threads,
        total,
        items: threads.map(boxOf),
        ...(total > threads.length
          ? {
              footer: {
                id: moreIdOf(id),
                width: MORE_WIDTH,
                height: MORE_HEIGHT,
              },
            }
          : {}),
      };
    },
  );
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
  return threadsByAttention(threads, open).filter(
    (thread, index) => index < MAX_THREAD_NODES || open.has(thread.id),
  );
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

/** How far the zoom may stray from the default before Reset zoom is offered. */
const ZOOM_TOLERANCE = 0.01;

/** Whether `zoom` is the default view's zoom, give or take float noise. */
export function atDefaultZoom(zoom: number, defaultZoom: number): boolean {
  return Math.abs(zoom - defaultZoom) <= ZOOM_TOLERANCE;
}

function ResetZoomButton({
  defaultZoom,
  onResetZoom,
}: {
  defaultZoom: number;
  onResetZoom: () => void;
}): React.JSX.Element | null {
  const zoom = useStore((state) => state.transform[2]);
  if (atDefaultZoom(zoom, defaultZoom)) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-slot="graph-reset-zoom"
      className="h-7 gap-1.5 bg-card px-2 text-xs shadow-sm"
      title="Back to the zoom the graph opens at"
      onClick={onResetZoom}>
      <ZoomIn aria-hidden="true" className="size-3.5" />
      Reset zoom
      <span className="text-muted-foreground tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
    </Button>
  );
}

function ZoomControls({
  onFit,
  onReset,
  defaultZoom,
  onResetZoom,
}: {
  onFit: () => void;
  onReset: (() => void) | null;
  defaultZoom: number;
  onResetZoom: () => void;
}): React.JSX.Element {
  const flow = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const duration = reduced ? 0 : 200;
  return (
    <div className="absolute right-3 bottom-20 z-10 flex flex-col items-end gap-2">
      <ResetZoomButton defaultZoom={defaultZoom} onResetZoom={onResetZoom} />
      <div
        role="group"
        aria-label="Zoom"
        className="flex flex-col gap-1 rounded-control border border-border bg-card p-1 shadow-sm">
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
  blockPlaces,
  onPlaceBlock,
  blockOrders,
  onOrderBlock,
  onResetLayout,
  renderCardChat,
  cardsInFront,
  onActivateCards,
  focus,
  onFocused,
  projects,
  asking,
  onAnswer,
  onUnplaceNode,
  onViewportMove,
  className,
}: GraphViewProps): React.JSX.Element {
  const flow = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const [measure, measured] = useElementSize();
  const pane = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(measured);
  // A hidden page measures 0×0; keeping the last real size keeps the flow and every open card's chat mounted.
  if (measured !== size && measured.width > 0 && measured.height > 0) {
    setSize(measured);
  }
  const fittedSize = useRef<string | null>(null);
  const fittedWidth = useRef<number | null>(null);
  const userMoved = useRef(false);
  const quietUntil = useRef(0);
  const focused = useRef<number | null>(null);
  const [flashing, setFlashing] = useState<GraphFocus | null>(null);
  const [drag, setDrag] = useState<GraphDrag | null>(null);
  const panZoomReady = useStore((state) => state.panZoom !== null);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const nodeMeasured = useLatestCallback((threadId: string, height: number) => {
    setHeights((known) =>
      Math.abs((known.get(threadId) ?? -1) - height) < 1
        ? known
        : new Map(known).set(threadId, height),
    );
  }, []);

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
  const canvasWidth = narrow ? 0 : size.width;
  const blocks = graphBlocks(
    shown,
    projects,
    onCanvas,
    heights,
    threads,
    blockOrders,
  );
  const perLine = perLineFor(shown.length, canvasWidth, THREAD_CARD_WIDTH);
  const columns = Math.max(1, perLine);
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
  }
  const placedBlocks = new Map<string, NodeOffset>();
  if (!narrow) {
    for (const block of blocks) {
      const offset = blockPlaces[block.id];
      if (offset !== undefined) {
        placedBlocks.set(block.id, offset);
      }
    }
  }
  const unopened =
    onCanvas.size === 0 && pinned.size === 0 && placedBlocks.size === 0
      ? null
      : layoutBlocks(
          root,
          graphBlocks(shown, projects, new Map(), heights, threads),
          perLine,
        );
  const laidOut: GraphGeometry = narrow
    ? layoutColumn(
        root,
        [
          ...blocks.flatMap((block) => [
            {
              id: headingIdOf(block.id),
              width: THREAD_CARD_WIDTH,
              height: BLOCK_HEAD,
            },
            ...block.items,
            ...(block.footer === undefined ? [] : [block.footer]),
          ]),
        ],
        new Set(
          blocks.flatMap((block) => [
            headingIdOf(block.id),
            ...(block.footer === undefined ? [] : [block.footer.id]),
          ]),
        ),
        blocks.map((block) => ({
          id: block.id,
          members: [
            headingIdOf(block.id),
            ...block.items.map((item) => item.id),
            ...(block.footer === undefined ? [] : [block.footer.id]),
          ],
        })),
      )
    : layoutBlocks(
        root,
        blocks,
        perLine,
        pinned,
        unopened ?? undefined,
        placedBlocks,
      );
  const freeItemsOf = (block: GraphBlock, except?: string): GraphBox[] =>
    block.items.filter((item) => item.id !== except && !pinned.has(item.id));
  const cardDrop = (runId: string, offset: NodeOffset): CardDrop | null => {
    const id = `${THREAD_PREFIX}${runId}`;
    const block = blocks.find((candidate) =>
      candidate.items.some((item) => item.id === id),
    );
    const moved = withBoxAt(laidOut, MANAGER_ID, id, offset);
    const box = moved.boxes.get(id);
    const frame = block === undefined ? undefined : laidOut.boxes.get(block.id);
    if (block === undefined || box === undefined || frame === undefined) {
      return null;
    }
    const others = freeItemsOf(block, id);
    const slot = {
      id: dropSlotIdOf(runId),
      width: box.width,
      height: box.height,
    };
    const centre = {
      x: box.x + box.width / 2,
      y: box.y + Math.min(box.height / 2, CENTRE_DEPTH),
    };
    const index = slotIndexFor(block, others, slot, columns, frame, centre);
    const items = others.toSpliced(index, 0, slot);
    const withSlot = withBlockItems(moved, block, items, columns);
    const room = withSlot.boxes.get(block.id)!;
    const inside =
      centre.x >= room.x &&
      centre.x <= room.x + room.width &&
      centre.y >= room.y &&
      centre.y <= room.y + room.height;
    return inside
      ? {
          geometry: withSlot,
          blockId: block.id,
          order: items.map((item) =>
            item.id === slot.id ? runId : item.id.slice(THREAD_PREFIX.length),
          ),
        }
      : {
          geometry: withBlockItems(moved, block, others, columns),
          blockId: block.id,
          order: null,
        };
  };
  const blockMembers = (blockId: string): string[] => {
    const block = blocks.find((candidate) => candidate.id === blockId);
    return block === undefined
      ? []
      : [
          ...freeItemsOf(block).map((item) => item.id),
          ...(block.footer === undefined ? [] : [block.footer.id]),
        ];
  };
  const drawn =
    drag === null || narrow
      ? laidOut
      : drag.kind === 'block'
        ? withBlockAt(
            laidOut,
            MANAGER_ID,
            drag.id,
            blockMembers(drag.id),
            drag.offset,
          )
        : (cardDrop(drag.runId, drag.offset)?.geometry ??
          withBoxAt(laidOut, MANAGER_ID, drag.id, drag.offset));
  const moving = new Set<string>(
    drag === null
      ? []
      : drag.kind === 'block'
        ? [drag.id, ...blockMembers(drag.id)]
        : [drag.id],
  );
  const automatic = unopened ?? drawn;
  const dragGone =
    drag !== null &&
    (narrow ||
      (drag.kind === 'block'
        ? !blocks.some((block) => block.id === drag.id)
        : !shown.some((t) => `${THREAD_PREFIX}${t.id}` === drag.id)));
  useEffect(() => {
    if (dragGone) {
      setDrag(null);
    }
  }, [dragGone]);
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
    void flow.setViewport(widthFit(automatic, size), { duration });
  }, []);
  const sizeKey = `${Math.round(size.width)}x${Math.round(size.height)}`;
  const graphWidth = Math.round(automatic.width);
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
  const actions = useMemo(
    () => ({ openInChats, toggleCard, answer, measured: nodeMeasured }),
    [openInChats, toggleCard, answer, nodeMeasured],
  );
  const viewportMoved = useLatestCallback(() => {
    if (performance.now() < quietUntil.current) {
      return;
    }
    userMoved.current = true;
    onViewportMove?.();
  }, []);
  useWheelLatch(
    () => pane.current?.querySelector<HTMLElement>('.react-flow') ?? null,
    active && !narrow && size.width > 0,
    (event) => {
      const box = pane.current?.getBoundingClientRect();
      if (box === undefined) {
        return;
      }
      void flow.setViewport(
        wheelStep(
          flow.getViewport(),
          event,
          { x: event.clientX - box.left, y: event.clientY - box.top },
          { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM },
        ),
      );
    },
  );
  const nodesChanged = useLatestCallback(
    (changes: NodeChange<GraphFlowNode>[]) => {
      for (const change of changes) {
        if (
          change.type === 'position' &&
          change.dragging === true &&
          change.position !== undefined
        ) {
          const offset = offsetOf(change.position);
          setDrag(
            change.id.startsWith(THREAD_PREFIX)
              ? {
                  kind: 'card',
                  id: change.id,
                  runId: change.id.slice(THREAD_PREFIX.length),
                  offset,
                }
              : { kind: 'block', id: change.id, offset },
          );
        }
      }
    },
    [],
  );
  const place = (runId: string, to: { x: number; y: number }): void => {
    const offset = offsetOf(to);
    const drop = cardDrop(runId, offset);
    if (drop === null || drop.order === null) {
      onPlaceNode(runId, offset);
      return;
    }
    const block = blocks.find((candidate) => candidate.id === drop.blockId)!;
    const unchanged =
      positions[runId] === undefined &&
      freeItemsOf(block).every(
        (item, index) =>
          item.id.slice(THREAD_PREFIX.length) === drop.order![index],
      );
    if (positions[runId] !== undefined) {
      onUnplaceNode(runId);
    }
    if (!unchanged) {
      onOrderBlock(drop.blockId, drop.order);
    }
  };
  const nodeDropped = useLatestCallback(
    (_event: unknown, node: GraphFlowNode) => {
      if (node.type === 'thread') {
        place(node.data.thread.id, node.position);
      } else if (node.type === 'block' && drag?.id === node.id) {
        onPlaceBlock(node.id, offsetOf(node.position));
      }
      setDrag(null);
    },
    [],
  );
  const cardMoved = useLatestCallback(
    (runId: string, to: { x: number; y: number }, done: boolean) => {
      if (done) {
        place(runId, to);
        setDrag(null);
      } else {
        setDrag({
          kind: 'card',
          id: `${THREAD_PREFIX}${runId}`,
          runId,
          offset: offsetOf(to),
        });
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
  const working = threads.filter((thread) =>
    isWorkingThread(thread.view),
  ).length;

  const base = (id: string) => {
    const box = drawn.boxes.get(id)!;
    return {
      id,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      handles: handlesFor(box.width, box.height),
      className: moving.has(id) ? undefined : NODE_CLASS,
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
  for (const block of blocks) {
    const id = block.id;
    if (!drawn.boxes.has(id)) {
      continue;
    }
    nodes.push({
      ...base(id),
      type: 'block',
      zIndex: -1,
      style: { pointerEvents: 'none' },
      draggable: !narrow,
      dragHandle: `.${BLOCK_HANDLE}`,
      data: {
        name: block.name,
        color: block.color,
        threads: block.total,
        working: block.threads.filter((thread) => isWorkingThread(thread.view))
          .length,
        movable: !narrow,
      },
    });
    const route = drawn.routes.get(id);
    if (route === undefined) {
      continue;
    }
    const inside = block.threads.filter(
      (thread) => !drawn.routes.has(`thread:${thread.id}`),
    );
    const blockPulses = inside.flatMap(
      (thread) => states.get(thread.id)?.pulses ?? [],
    );
    const state = inside.reduce<EdgeState>((loudest, thread) => {
      const own = states.get(thread.id)?.state ?? 'idle';
      return EDGE_PAINT_ORDER[own] > EDGE_PAINT_ORDER[loudest] ? own : loudest;
    }, 'idle');
    contactEdges.push({
      id: `contact:${id}`,
      type: 'contact',
      source: MANAGER_ID,
      sourceHandle: 'out',
      target: id,
      targetHandle: 'in',
      focusable: false,
      selectable: false,
      data: { route, state, pulses: blockPulses, now, moving: false },
    });
  }
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
        aboveWindow: card.aboveWindow,
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
        data: {
          route: wire,
          state: entry.state,
          pulses: entry.pulses,
          now,
          moving: drag?.id === id,
        },
      });
    }
  }
  if (drag?.kind === 'card' && drawn.boxes.has(dropSlotIdOf(drag.runId))) {
    nodes.push({
      ...base(dropSlotIdOf(drag.runId)),
      type: 'dropSlot',
      zIndex: -1,
      style: { pointerEvents: 'none' },
      data: {},
    });
  }
  for (const block of blocks) {
    if (block.footer !== undefined && drawn.boxes.has(block.footer.id)) {
      nodes.push({
        ...base(block.footer.id),
        type: 'more',
        data: { count: block.total - block.threads.length },
      });
    }
  }
  const edges = contactEdges.sort(
    (a, b) => EDGE_PAINT_ORDER[a.data!.state] - EDGE_PAINT_ORDER[b.data!.state],
  );

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
    <GraphActionsContext.Provider value={actions}>
      {narrow ? (
        <div
          role="group"
          aria-label={label}
          data-slot="command-center-graph"
          data-layout="column"
          className={cn('relative flex flex-col', className)}>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AttentionLegend threads={threads} />
            <div
              className="flow-touch-scroll mx-auto"
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
                aboveWindow: phoneCard.aboveWindow,
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
          data-layout="blocks"
          data-blocks={blocks.length}
          className={cn('flex flex-col', className)}>
          <AttentionLegend threads={threads} />
          <div
            ref={(element) => {
              pane.current = element;
              measure(element);
            }}
            className="relative min-h-0 flex-1">
            {size.width === 0 ? null : (
              <>
                <ReactFlow
                  {...flowProps}
                  defaultViewport={widthFit(automatic, size)}
                  minZoom={MIN_ZOOM}
                  maxZoom={MAX_ZOOM}
                  panOnDrag
                  panOnScroll
                  zoomOnScroll={false}
                  zoomOnPinch
                  zoomOnDoubleClick={false}
                  onMoveStart={viewportMoved}
                />
                <ZoomControls
                  onFit={() =>
                    void flow.setViewport(wholeFit(drawn, size), {
                      duration: reduced ? 0 : FIT_MS,
                    })
                  }
                  onReset={
                    Object.keys(positions).length === 0 &&
                    Object.keys(blockPlaces).length === 0 &&
                    Object.keys(blockOrders).length === 0
                      ? null
                      : onResetLayout
                  }
                  defaultZoom={widthFit(automatic, size).zoom}
                  onResetZoom={() => {
                    userMoved.current = false;
                    fit(true);
                  }}
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
                  inFront={cardsInFront}
                  onActivate={onActivateCards}
                />
              </>
            )}
          </div>
        </div>
      )}
    </GraphActionsContext.Provider>
  );
}
