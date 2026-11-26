import type { BlockOrders } from './block-orders';
import { orderedWithin } from './block-orders';
import { blockIdOf } from './block-places';
import {
  BLOCK_ATTENTION_ORDER,
  isWorkingThread,
  orderByAttention,
  type ThreadCardView,
} from './card-view';
import type { CardBand } from './open-cards';
import type { ProjectColor } from './project-colors';

export interface GraphThread {
  id: string;
  projectId: string | null;
  createdAt: string;
  view: ThreadCardView;
}

export type OpenBands = ReadonlyMap<string, { band: CardBand }>;

export interface OrderedBlock {
  id: string;
  projectId: string | null;
  threads: GraphThread[];
  members: GraphThread[];
}

export function threadsByAttention(
  threads: readonly GraphThread[],
  open: OpenBands,
): GraphThread[] {
  return orderByAttention(
    threads.map((thread) => ({
      id: thread.id,
      createdAt: thread.createdAt,
      view: open.get(thread.id)?.band ?? thread.view,
      thread,
    })),
  ).map((entry) => entry.thread);
}

export function orderedBlocks(
  shown: readonly GraphThread[],
  projects: readonly Pick<ProjectColor, 'id'>[],
  open: OpenBands,
  all: readonly GraphThread[] = shown,
  orders: BlockOrders = {},
): OrderedBlock[] {
  const rank = (thread: GraphThread): number =>
    BLOCK_ATTENTION_ORDER.indexOf(
      open.get(thread.id)?.band.attention ?? thread.view.attention,
    );
  const known = new Set(projects.map((project) => project.id));
  const order = [
    ...projects.map((project) => project.id),
    ...new Set(
      all.flatMap((thread) =>
        thread.projectId === null || known.has(thread.projectId)
          ? []
          : [thread.projectId],
      ),
    ),
  ];
  const blockOf = (projectId: string | null): OrderedBlock => {
    const ofProject = (thread: GraphThread): boolean =>
      thread.projectId === projectId;
    const id = blockIdOf({ projectId });
    const ranked = shown.filter(ofProject).sort((a, b) => rank(a) - rank(b));
    const byId = new Map(ranked.map((thread) => [thread.id, thread]));
    return {
      id,
      projectId,
      threads: orderedWithin(
        ranked.map((thread) => thread.id),
        orders[id],
      ).map((threadId) => byId.get(threadId)!),
      members: all.filter(ofProject),
    };
  };
  return [...order.map(blockOf), blockOf(null)].filter(
    (block) => block.members.length + block.threads.length > 0,
  );
}

export function workingThreadsInGraphOrder(
  threads: readonly GraphThread[],
  projects: readonly Pick<ProjectColor, 'id'>[],
  open: OpenBands,
  orders: BlockOrders,
): GraphThread[] {
  return orderedBlocks(
    threadsByAttention(threads, open),
    projects,
    open,
    threads,
    orders,
  )
    .flatMap((block) => block.threads)
    .filter((thread) => isWorkingThread(thread.view));
}
