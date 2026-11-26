// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { useWaitingItems } from './use-waiting-items';
import type { WaitingItemsStore } from './waiting-items-context';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latest: WaitingItemsStore | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe({
  apis,
  client,
  enabled,
}: {
  apis: DaemonApis;
  client: DaemonClient;
  enabled: boolean;
}): null {
  latest = useWaitingItems(apis, client, enabled, [], []);
  return null;
}

type Listener = () => void;

function fakeClient() {
  const listeners = {
    memory: new Set<Listener>(),
    lessons: new Set<Listener>(),
    knowledge: new Set<Listener>(),
    reconnect: new Set<Listener>(),
  };
  const on =
    (set: Set<Listener>) =>
    (listener: Listener): (() => void) => {
      set.add(listener);
      return () => set.delete(listener);
    };
  const client = {
    onMemoryChanged: on(listeners.memory),
    onLessonsChanged: on(listeners.lessons),
    onKnowledgeChanged: on(listeners.knowledge),
    onReconnect: on(listeners.reconnect),
  } as unknown as DaemonClient;
  const fire = (set: Set<Listener>) => set.forEach((listener) => listener());
  return { client, listeners, fire };
}

const entry = (id: string) => ({ id, handle: id, title: id });

function fakeApis(over: { memoryPages?: unknown[] } = {}) {
  const pages = over.memoryPages ?? [
    {
      memories: [entry('m1')],
      tracks: [],
      next: { beforeUpdatedAt: 't', beforeId: 'm1' },
    },
    { memories: [entry('m2')], tracks: [], next: null },
  ];
  const listMemories = vi.fn();
  pages.forEach((page) => listMemories.mockResolvedValueOnce(page));
  const listLessonProposals = vi
    .fn()
    .mockResolvedValue({ proposals: [{ id: 'p1' }] });
  const listKnowledge = vi.fn().mockResolvedValue({
    documents: [{ id: 'd1' }, { id: 'd2' }],
    next: null,
  });
  const listKnowledgeRevisions = vi.fn(async ({ id }: { id: string }) => ({
    revisions:
      id === 'd1'
        ? [
            { id: 'r1', status: 'approved' },
            { id: 'r2', status: 'pending' },
          ]
        : [{ id: 'r3', status: 'pending' }],
  }));
  const apis = {
    memories: { listMemories },
    lessons: { listLessonProposals },
    knowledge: { listKnowledge, listKnowledgeRevisions },
  } as unknown as DaemonApis;
  return { apis, listMemories, listLessonProposals, listKnowledge };
}

async function render(
  apis: DaemonApis,
  client: DaemonClient,
  enabled = true,
): Promise<void> {
  await act(async () => {
    root.render(<Probe apis={apis} client={client} enabled={enabled} />);
  });
}

describe('useWaitingItems', () => {
  it('is null while not enabled and reads nothing', async () => {
    const { apis, listMemories, listLessonProposals } = fakeApis();
    const { client } = fakeClient();
    await render(apis, client, false);

    expect(latest).toBeNull();
    expect(listMemories).not.toHaveBeenCalled();
    expect(listLessonProposals).not.toHaveBeenCalled();
  });

  it('keys every waiting set by id, reading every memory page and only the pending revisions', async () => {
    const { apis, listMemories, listLessonProposals } = fakeApis();
    const { client } = fakeClient();
    await render(apis, client);

    expect([...(latest?.memories?.keys() ?? [])]).toEqual(['m1', 'm2']);
    expect(listMemories).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'pending' }),
    );
    expect(listMemories).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ beforeUpdatedAt: 't', beforeId: 'm1' }),
    );
    expect([...(latest?.lessons?.keys() ?? [])]).toEqual(['p1']);
    expect(listLessonProposals).toHaveBeenCalledWith({
      status: 'proposed,check_failed',
    });
    expect([...(latest?.knowledge?.keys() ?? [])]).toEqual(['r2', 'r3']);
  });

  it('is not loaded before the first answer', async () => {
    const { apis } = fakeApis();
    const { client } = fakeClient();
    act(() => {
      root.render(<Probe apis={apis} client={client} enabled />);
    });

    expect(latest?.memories).toBeNull();
    expect(latest?.lessons).toBeNull();
    expect(latest?.knowledge).toBeNull();
    await act(async () => undefined);
  });

  it('re-reads only the kind that changed, and every kind after a reconnect', async () => {
    const { apis, listMemories, listLessonProposals, listKnowledge } = fakeApis(
      {
        memoryPages: [
          { memories: [], tracks: [], next: null },
          { memories: [], tracks: [], next: null },
          { memories: [], tracks: [], next: null },
        ],
      },
    );
    const { client, listeners, fire } = fakeClient();
    await render(apis, client);
    expect(listMemories).toHaveBeenCalledTimes(1);

    await act(async () => fire(listeners.lessons));
    expect(listLessonProposals).toHaveBeenCalledTimes(2);
    expect(listMemories).toHaveBeenCalledTimes(1);
    expect(listKnowledge).toHaveBeenCalledTimes(1);

    await act(async () => fire(listeners.memory));
    expect(listMemories).toHaveBeenCalledTimes(2);

    await act(async () => fire(listeners.knowledge));
    expect(listKnowledge).toHaveBeenCalledTimes(2);

    await act(async () => fire(listeners.reconnect));
    expect(listMemories).toHaveBeenCalledTimes(3);
    expect(listLessonProposals).toHaveBeenCalledTimes(3);
    expect(listKnowledge).toHaveBeenCalledTimes(3);
  });

  it('drops an answer that a newer read overtook', async () => {
    const first = Promise.withResolvers<unknown>();
    const { apis, listMemories } = fakeApis();
    listMemories.mockReset();
    listMemories.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      memories: [entry('fresh')],
      tracks: [],
      next: null,
    });
    const { client, listeners, fire } = fakeClient();
    await render(apis, client);

    await act(async () => fire(listeners.memory));
    expect([...(latest?.memories?.keys() ?? [])]).toEqual(['fresh']);

    await act(async () => {
      first.resolve({ memories: [entry('stale')], tracks: [], next: null });
    });
    expect([...(latest?.memories?.keys() ?? [])]).toEqual(['fresh']);
  });

  it('stops listening once disabled', async () => {
    const { apis } = fakeApis();
    const { client, listeners } = fakeClient();
    await render(apis, client);
    expect(listeners.memory.size).toBe(1);

    await render(apis, client, false);
    expect(listeners.memory.size).toBe(0);
    expect(listeners.reconnect.size).toBe(0);
    expect(latest).toBeNull();
  });
});
