// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../../shared/contracts';
import type * as chatsUseThreadPullRequestsModule from '../chats/use-thread-pull-requests';
import type * as componentsUiSelectModule from '../components/ui/select';
import type * as daemonApiModule from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { CommandCenter } from './CommandCenter';
import type { GraphViewProps } from './graph-view';
import { ThreadCard } from './thread-card';
import type { ThreadCardChatProps } from './thread-card-chat';
import type * as useOpenRequestsModule from './use-open-requests';

const { probes, fakes } = vi.hoisted(() => {
  const unset: unknown = null;
  return {
    probes: {
      graph: null as GraphViewProps | null,
      dock: null as { onOpenThread: (runId: string) => void } | null,
    },
    fakes: {
      board: unset,
      timeline: unset,
      requests: unset,
      projects: unset,
      sources: unset,
      capabilities: unset,
      managerChoice: unset,
      pullRequests: unset,
      apis: unset,
    },
  };
});

vi.mock('./use-command-center-board', () => ({
  useCommandCenterBoard: () => fakes.board,
}));
vi.mock('./use-command-center-timeline', () => ({
  useCommandCenterTimeline: () => fakes.timeline,
}));
vi.mock('./use-open-requests', async (importOriginal) => ({
  ...(await importOriginal<typeof useOpenRequestsModule>()),
  useOpenRequests: () => fakes.requests,
}));
vi.mock('../projects/use-projects', () => ({
  useProjects: () => fakes.projects,
}));
vi.mock('../projects/use-run-config-sources', () => ({
  useRunConfigSources: () => fakes.sources,
}));
vi.mock('../use-capabilities', () => ({
  useSharedCapabilities: () => fakes.capabilities,
}));
vi.mock('./use-manager-choice', () => ({
  useManagerChoice: () => fakes.managerChoice,
}));
vi.mock('../chats/use-thread-pull-requests', async (importOriginal) => ({
  ...(await importOriginal<typeof chatsUseThreadPullRequestsModule>()),
  useThreadPullRequests: () => fakes.pullRequests,
}));
vi.mock('../daemon-api', async (importOriginal) => ({
  ...(await importOriginal<typeof daemonApiModule>()),
  createDaemonApis: () => fakes.apis,
}));
vi.mock('./graph-view', () => ({
  GraphView: (props: GraphViewProps) => {
    probes.graph = props;
    return (
      <div data-slot="stub-graph">
        {props.threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            {...thread.view}
            onOpenInChats={() => undefined}
          />
        ))}
      </div>
    );
  },
}));
vi.mock('./manager-dock', () => ({
  ManagerDock: (props: { onOpenThread: (runId: string) => void }) => {
    probes.dock = props;
    return <div data-slot="stub-manager-dock" />;
  },
}));
vi.mock('../components/ui/select', async (importOriginal) => ({
  ...(await importOriginal<typeof componentsUiSelectModule>()),
  Select: ({
    groups,
    value,
    onValueChange,
  }: {
    groups: { items: { value: string; label: string }[] }[];
    value: string;
    onValueChange: (next: string) => void;
  }) => (
    <div data-slot="stub-select" data-current={value}>
      {groups
        .flatMap((group) => group.items)
        .map((item) => (
          <button
            key={item.value}
            type="button"
            data-value={item.value}
            onClick={() => onValueChange(item.value)}>
            {item.label}
          </button>
        ))}
    </div>
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const onOpenThread = vi.fn();
const NOW_ISO = new Date().toISOString();

function cardOf(
  runId: string,
  projectId: string,
  column: 'idle' | 'done' | 'working' | 'waiting' = 'idle',
): unknown {
  return {
    run: {
      id: runId,
      title: `Thread ${runId}`,
      createdAt: NOW_ISO,
      lastActivityAt: NOW_ISO,
      status: 'completed',
      awaiting: null,
      teamId: null,
      agentKind: 'claude',
      project: { id: projectId, name: projectId },
      pullRequests: [],
    },
    column,
    contact: { lastAt: null, awaitingReply: false },
    task: null,
    note: null,
    activity: null,
  };
}

function boardOf(cards: unknown[]): unknown {
  return {
    cards,
    manager: {
      id: 'manager-run',
      agentKind: 'claude',
      status: 'completed',
      model: 'opus',
      createdAt: NOW_ISO,
      lastActivityAt: NOW_ISO,
    },
    pulses: [],
    pendingStarts: 0,
    error: null,
    reload: vi.fn(),
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  onOpenThread.mockClear();
  probes.graph = null;
  probes.dock = null;
  fakes.board = boardOf([cardOf('run-a', 'p1'), cardOf('run-b', 'p2')]);
  fakes.timeline = {
    events: [],
    loading: false,
    error: null,
    hasMore: false,
    loadOlder: vi.fn(),
  };
  fakes.requests = { requests: [], error: null, answer: vi.fn() };
  fakes.projects = {
    projects: [
      { id: 'p1', name: 'Billing' },
      { id: 'p2', name: 'Cache' },
    ],
  };
  fakes.sources = {
    cliDetections: [],
    approvalCapabilityFor: () => null,
    recentConfigDirs: [],
    configProfiles: [],
  };
  fakes.capabilities = { capabilities: [], loading: false };
  fakes.managerChoice = { choice: { kind: 'claude' }, pick: vi.fn() };
  fakes.pullRequests = { byKey: new Map() };
  fakes.apis = { teams: { listTeams: () => Promise.resolve([]) } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  localStorage.clear();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

async function renderPage(): Promise<void> {
  act(() => {
    root.render(
      <CommandCenter
        handle={{} as DaemonHandle}
        client={{} as DaemonClient}
        active
        onOpenThread={onOpenThread}
      />,
    );
  });
  await settle();
}

function pressOption(value: string): void {
  act(() => {
    container
      .querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!
      .click();
  });
}

function buttonNamed(text: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === text,
  )!;
}

describe('CommandCenter — the identities a card’s chat heads threads with', () => {
  const identitiesOfCardChat = (): ThreadCardChatProps['threadIdentities'] =>
    (
      probes.graph!.renderCardChat(
        'run-a',
      ) as React.ReactElement<ThreadCardChatProps>
    ).props.threadIdentities;

  it('hands the same identities object across a board update that names every thread the same way, and a new one once a title changes', async () => {
    await renderPage();
    const first = identitiesOfCardChat();

    fakes.board = boardOf([cardOf('run-a', 'p1'), cardOf('run-b', 'p2')]);
    await renderPage();
    expect(identitiesOfCardChat()).toBe(first);

    const renamed = cardOf('run-b', 'p2') as { run: { title: string } };
    renamed.run.title = 'Renamed thread';
    fakes.board = boardOf([cardOf('run-a', 'p1'), renamed]);
    await renderPage();
    const next = identitiesOfCardChat();
    expect(next).not.toBe(first);
    expect(next.get('run-b')?.title).toBe('Renamed thread');
  });
});

describe('CommandCenter — showing a thread on the canvas', () => {
  it('shows a thread from the board as a card on the canvas, and brings it into view', async () => {
    await renderPage();
    expect(probes.graph!.openCards).toEqual([]);

    act(() => {
      probes.dock!.onOpenThread('run-b');
    });

    expect(probes.graph!.openCards.map((card) => card.runId)).toEqual([
      'run-b',
    ]);
    expect(probes.graph!.focus).toEqual({
      runId: 'run-b',
      seq: expect.any(Number),
    });
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('draws the graph with no view switch, and opens the manager’s chat in a window from the chat button', async () => {
    await renderPage();
    expect(probes.graph).not.toBeNull();
    expect(container.querySelector('[aria-label="View"]')).toBeNull();
    const chat = container.querySelector<HTMLElement>(
      '[data-slot="command-center-chat-bounds"]',
    )!;
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-slot="command-center-chat-toggle"]',
    )!;
    expect(chat.hidden).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(probes.dock).not.toBeNull();

    clickOn(toggle);
    expect(chat.hidden).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    clickOn(container.querySelector('[data-slot="command-center-chat-close"]'));
    expect(chat.hidden).toBe(true);
  });

  it('opens the manager’s chat window when the manager’s own thread is shown', async () => {
    await renderPage();
    act(() => {
      probes.dock!.onOpenThread('manager-run');
    });
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="command-center-chat-bounds"]',
      )!.hidden,
    ).toBe(false);
    expect(probes.graph!.openCards).toEqual([]);
  });

  it('moves the project filter to the thread’s project when another project is picked', async () => {
    await renderPage();
    pressOption('p1');
    expect(probes.graph!.threads.map((thread) => thread.id)).toEqual(['run-a']);

    act(() => {
      probes.dock!.onOpenThread('run-b');
    });

    expect(probes.graph!.threads.map((thread) => thread.id)).toEqual(['run-b']);
    expect(
      container
        .querySelector('[data-slot="stub-select"]')!
        .getAttribute('data-current'),
    ).toBe('p2');
  });

  it('tells a thread no longer on the board, and takes it to Chats only when its Open in Chats is pressed', async () => {
    await renderPage();

    act(() => {
      probes.dock!.onOpenThread('run-gone');
    });

    expect(probes.graph!.openCards).toEqual([]);
    expect(container.textContent).toContain(
      'This thread is no longer on the board',
    );
    expect(onOpenThread).not.toHaveBeenCalled();

    act(() => {
      buttonNamed('Open in Chats').click();
    });

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith('run-gone');
  });

  it('takes a thread to Chats only from the graph’s Open in Chats, never when a thread is shown', async () => {
    await renderPage();
    act(() => {
      probes.dock!.onOpenThread('run-b');
    });
    expect(onOpenThread).not.toHaveBeenCalled();

    act(() => {
      probes.graph!.onOpenInChats('run-a');
    });

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith('run-a');
  });

  it('opens and shuts a card from the graph’s toggle, without going to Chats', async () => {
    await renderPage();

    act(() => {
      probes.graph!.onToggleCard('run-a');
    });
    expect(probes.graph!.openCards.map((card) => card.runId)).toEqual([
      'run-a',
    ]);

    act(() => {
      probes.graph!.onToggleCard('run-a');
    });
    expect(probes.graph!.openCards).toEqual([]);
    expect(onOpenThread).not.toHaveBeenCalled();
  });
});

describe('CommandCenter — the phone sidebar and the focus', () => {
  it.each([
    ['command-center-needs-toggle'],
    ['command-center-timeline-toggle'],
  ])(
    'closes an open sidebar (%s) when a thread is shown on a phone',
    async (toggle) => {
      stubMatchMedia(true);
      await renderPage();
      act(() => {
        container
          .querySelector<HTMLButtonElement>(`[data-slot="${toggle}"]`)!
          .click();
      });
      expect(
        container.querySelector('[data-slot="command-center-sidebar"]'),
      ).not.toBeNull();

      act(() => {
        probes.dock!.onOpenThread('run-b');
      });

      expect(
        container.querySelector('[data-slot="command-center-sidebar"]'),
      ).toBeNull();
    },
  );

  it('shows the thread’s card instead of a popover when Reply is pressed on a phone', async () => {
    stubMatchMedia(true);
    fakes.requests = {
      requests: [
        openRequestOf('run-a', 'item-7', 'How should the export retry?'),
      ],
      error: null,
      answer: vi.fn(),
    };
    timelineWith([questionEventOf('run-a', 'item-7', 'Billing export')]);
    await renderPage();
    clickOn(timelineToggle());

    clickOn(replyButton());

    expect(answerPopover()).toBeNull();
    expect(
      container.querySelector('[data-slot="command-center-sidebar"]'),
    ).toBeNull();
    expect(probes.graph!.openCards.map((card) => card.runId)).toEqual([
      'run-a',
    ]);
  });

  it('keeps an open sidebar when a thread is shown on a wide screen', async () => {
    stubMatchMedia(false);
    await renderPage();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="command-center-needs-toggle"]',
        )!
        .click();
    });

    act(() => {
      probes.dock!.onOpenThread('run-b');
    });

    expect(
      container.querySelector('[data-slot="command-center-sidebar"]'),
    ).not.toBeNull();
  });

  it('clears the focus once the graph has handled it, and a stale seq leaves it be', async () => {
    await renderPage();
    act(() => {
      probes.dock!.onOpenThread('run-b');
    });
    const focus = probes.graph!.focus!;
    expect(focus.runId).toBe('run-b');

    act(() => {
      probes.graph!.onFocused(focus.seq - 1);
    });
    expect(probes.graph!.focus).toEqual(focus);

    act(() => {
      probes.graph!.onFocused(focus.seq);
    });
    expect(probes.graph!.focus).toBeNull();
  });
});

describe('CommandCenter — the places nodes were moved to', () => {
  it('hands the graph the places this device keeps, and forgets those of threads that left the board', async () => {
    localStorage.setItem(
      'commandCenter.nodePositions',
      JSON.stringify({
        'run-a': { x: 40, y: 300 },
        'run-gone': { x: 0, y: 0 },
      }),
    );

    await renderPage();

    expect(probes.graph!.positions).toEqual({ 'run-a': { x: 40, y: 300 } });
    expect(
      JSON.parse(localStorage.getItem('commandCenter.nodePositions')!),
    ).toEqual({ 'run-a': { x: 40, y: 300 } });
  });

  it('forgets the block places of projects with no thread on the board, and the threads that left the board from block orders', async () => {
    localStorage.setItem(
      'commandCenter.blockPositions',
      JSON.stringify({
        'block:p1': { x: 10, y: 20 },
        'block:gone': { x: 0, y: 0 },
      }),
    );
    localStorage.setItem(
      'commandCenter.blockOrders',
      JSON.stringify({
        'block:p1': ['run-gone', 'run-a'],
        'block:gone': ['run-gone'],
      }),
    );

    await renderPage();

    expect(probes.graph!.blockPlaces).toEqual({ 'block:p1': { x: 10, y: 20 } });
    expect(probes.graph!.blockOrders).toEqual({ 'block:p1': ['run-a'] });
    expect(
      JSON.parse(localStorage.getItem('commandCenter.blockPositions')!),
    ).toEqual({ 'block:p1': { x: 10, y: 20 } });
    expect(
      JSON.parse(localStorage.getItem('commandCenter.blockOrders')!),
    ).toEqual({ 'block:p1': ['run-a'] });
  });

  it('gives every node, block place and block order back to the automatic layout on Reset layout', async () => {
    localStorage.setItem(
      'commandCenter.nodePositions',
      JSON.stringify({ 'run-a': { x: 40, y: 300 } }),
    );
    localStorage.setItem(
      'commandCenter.blockPositions',
      JSON.stringify({ 'block:p1': { x: 10, y: 20 } }),
    );
    localStorage.setItem(
      'commandCenter.blockOrders',
      JSON.stringify({ 'block:p1': ['run-a'] }),
    );
    await renderPage();
    expect(probes.graph!.blockPlaces).toEqual({ 'block:p1': { x: 10, y: 20 } });
    expect(probes.graph!.blockOrders).toEqual({ 'block:p1': ['run-a'] });

    act(() => probes.graph!.onResetLayout());

    expect(probes.graph!.positions).toEqual({});
    expect(probes.graph!.blockPlaces).toEqual({});
    expect(probes.graph!.blockOrders).toEqual({});
    expect(
      JSON.parse(localStorage.getItem('commandCenter.nodePositions')!),
    ).toEqual({});
    expect(
      JSON.parse(localStorage.getItem('commandCenter.blockPositions')!),
    ).toEqual({});
    expect(
      JSON.parse(localStorage.getItem('commandCenter.blockOrders')!),
    ).toEqual({});
  });

  it('keeps a dropped node’s place and gives it up on Reset layout', async () => {
    await renderPage();

    act(() => probes.graph!.onPlaceNode('run-b', { x: 12, y: 340 }));
    expect(probes.graph!.positions).toEqual({ 'run-b': { x: 12, y: 340 } });

    act(() => probes.graph!.onResetLayout());
    expect(probes.graph!.positions).toEqual({});
  });
});

const NO_LESSONS = {
  signals: 0,
  lessonsOn: false,
  typical: null,
  estimate: { agentKind: 'claude', model: null, tokens: 0, usd: 0 },
  check: null,
  fromSeq: 0,
  toSeq: 0,
};

function dialogButton(text: string): HTMLButtonElement {
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  return [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === text,
  )!;
}

describe('CommandCenter — archiving a finished thread', () => {
  it('archives a finished thread from its node once the dialog confirms, and Undo puts it back', async () => {
    const archiveChat = vi.fn(() => Promise.resolve());
    const unarchiveChat = vi.fn(() => Promise.resolve());
    const estimateLessons = vi.fn(() => Promise.resolve(NO_LESSONS));
    fakes.board = boardOf([
      cardOf('run-a', 'p1'),
      cardOf('run-d', 'p2', 'done'),
    ]);
    fakes.apis = {
      teams: { listTeams: () => Promise.resolve([]) },
      chats: { archiveChat, unarchiveChat },
      lessons: { estimateLessons },
    };
    await renderPage();

    expect(
      container.querySelectorAll('[data-slot="thread-card-archive"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector(
        '[data-attention="done"] [data-slot="thread-card-archive"]',
      ),
    ).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-slot="thread-card-archive"]')!
        .click();
    });
    await settle();

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'Archive chat',
    );
    expect(estimateLessons).toHaveBeenCalledWith({ runId: 'run-d' });

    await act(async () => {
      dialogButton('Archive').click();
    });
    await settle();

    expect(archiveChat).toHaveBeenCalledTimes(1);
    expect(archiveChat).toHaveBeenCalledWith({
      runId: 'run-d',
      lessons: undefined,
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('Archived Thread run-d');

    await act(async () => {
      buttonNamed('Undo').click();
    });
    await settle();

    expect(unarchiveChat).toHaveBeenCalledTimes(1);
    expect(unarchiveChat).toHaveBeenCalledWith({ runId: 'run-d' });
    expect(container.textContent).not.toContain('Archived Thread run-d');
  });

  it('keeps the toast up with the error when Undo fails, and re-reads nothing', async () => {
    const archiveChat = vi.fn(() => Promise.resolve());
    const unarchiveChat = vi.fn(() => Promise.reject(new Error('daemon gone')));
    const board = boardOf([cardOf('run-d', 'p2', 'done')]) as {
      reload: ReturnType<typeof vi.fn>;
    };
    fakes.board = board;
    fakes.apis = {
      teams: { listTeams: () => Promise.resolve([]) },
      chats: { archiveChat, unarchiveChat },
      lessons: { estimateLessons: vi.fn(() => Promise.resolve(NO_LESSONS)) },
    };
    await renderPage();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-slot="thread-card-archive"]')!
        .click();
    });
    await settle();
    await act(async () => {
      dialogButton('Archive').click();
    });
    await settle();
    const reloads = board.reload.mock.calls.length;

    await act(async () => {
      buttonNamed('Undo').click();
    });
    await settle();

    expect(unarchiveChat).toHaveBeenCalledWith({ runId: 'run-d' });
    expect(container.textContent).toContain('Archived Thread run-d');
    expect(container.textContent).toContain('daemon gone');
    expect(board.reload.mock.calls.length).toBe(reloads);
  });
});

function openRequestOf(runId: string, itemId: string, text: string): unknown {
  return {
    runId,
    title: `Thread ${runId}`,
    isTeam: false,
    requestId: `req-${itemId}`,
    item: {
      id: itemId,
      runId,
      kind: 'approval_request',
      payload: {
        id: `req-${itemId}`,
        toolName: 'AskUserQuestion',
        questions: [
          {
            question: text,
            options: [{ label: 'Retry' }, { label: 'Park' }],
          },
        ],
      },
    },
  };
}

function questionEventOf(
  runId: string,
  itemId: string,
  threadTitle: string,
): unknown {
  return {
    id: `question:${itemId}`,
    kind: 'question',
    at: NOW_ISO,
    threadRunId: runId,
    threadTitle,
    text: 'How should the export retry?',
    detail: null,
    awaitingReply: false,
  };
}

function timelineWith(events: unknown[]): void {
  fakes.timeline = {
    events,
    loading: false,
    error: null,
    hasMore: false,
    loadOlder: vi.fn(),
  };
}

function clickOn(el: Element | null): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function timelineToggle(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    '[data-slot="command-center-timeline-toggle"]',
  )!;
}

function replyButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-slot="timeline-event-reply"]',
  );
}

function answerPopover(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot="answer-popover"]');
}

describe('CommandCenter — answering a timeline question', () => {
  it('answers a question from the timeline in a popover, titled with its thread', async () => {
    fakes.requests = {
      requests: [
        openRequestOf('run-q', 'item-7', 'How should the export retry?'),
      ],
      error: null,
      answer: vi.fn(),
    };
    timelineWith([questionEventOf('run-q', 'item-7', 'Billing export')]);
    await renderPage();

    clickOn(timelineToggle());
    clickOn(replyButton());

    expect(answerPopover()).not.toBeNull();
    expect(
      container.querySelector('[data-slot="answer-popover-title"]')!
        .textContent,
    ).toBe('Billing export');
  });

  it('offers no Reply on a question the thread no longer waits on', async () => {
    fakes.requests = { requests: [], error: null, answer: vi.fn() };
    timelineWith([questionEventOf('run-q', 'item-7', 'Billing export')]);
    await renderPage();

    clickOn(timelineToggle());

    expect(replyButton()).toBeNull();
  });

  it('shuts the popover when its Reply is pressed again', async () => {
    fakes.requests = {
      requests: [
        openRequestOf('run-q', 'item-7', 'How should the export retry?'),
      ],
      error: null,
      answer: vi.fn(),
    };
    timelineWith([questionEventOf('run-q', 'item-7', 'Billing export')]);
    await renderPage();
    clickOn(timelineToggle());
    const reply = replyButton();

    clickOn(reply);
    expect(answerPopover()).not.toBeNull();
    clickOn(reply);

    expect(answerPopover()).toBeNull();
  });

  it('shuts the popover when the timeline sidebar is closed', async () => {
    fakes.requests = {
      requests: [
        openRequestOf('run-q', 'item-7', 'How should the export retry?'),
      ],
      error: null,
      answer: vi.fn(),
    };
    timelineWith([questionEventOf('run-q', 'item-7', 'Billing export')]);
    await renderPage();
    clickOn(timelineToggle());
    clickOn(replyButton());
    expect(answerPopover()).not.toBeNull();

    clickOn(container.querySelector('[aria-label="Close the sidebar"]'));

    expect(answerPopover()).toBeNull();
  });

  it('shuts the popover and drops the Reply once the question is answered', async () => {
    fakes.requests = {
      requests: [
        openRequestOf('run-q', 'item-7', 'How should the export retry?'),
      ],
      error: null,
      answer: vi.fn(),
    };
    timelineWith([questionEventOf('run-q', 'item-7', 'Billing export')]);
    await renderPage();
    clickOn(timelineToggle());
    clickOn(replyButton());
    expect(answerPopover()).not.toBeNull();

    fakes.requests = { requests: [], error: null, answer: vi.fn() };
    await renderPage();

    expect(answerPopover()).toBeNull();
    expect(replyButton()).toBeNull();
  });

  it('keeps the popover on its row after one of the thread’s two questions is answered', async () => {
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        const top = this.isConnected ? 100 : 0;
        return {
          top,
          bottom: top + 30,
          left: 0,
          right: 0,
          width: 0,
          height: this.isConnected ? 30 : 0,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      });
    fakes.requests = {
      requests: [
        openRequestOf('run-q', 'item-7', 'How should the export retry?'),
        openRequestOf('run-q', 'item-8', 'Which month first?'),
      ],
      error: null,
      answer: vi.fn(),
    };
    timelineWith([
      questionEventOf('run-q', 'item-7', 'Billing export'),
      questionEventOf('run-q', 'item-8', 'Billing export'),
    ]);
    await renderPage();
    clickOn(timelineToggle());
    clickOn(replyButton());

    fakes.requests = {
      requests: [openRequestOf('run-q', 'item-8', 'Which month first?')],
      error: null,
      answer: vi.fn(),
    };
    await renderPage();
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });

    const panel = answerPopover()!.closest<HTMLElement>('[style*="fixed"]')!;
    expect(panel.style.top).toBe('136px');
    rect.mockRestore();
  });

  it('titles the popover with the thread’s name on the board when the board has the thread', async () => {
    fakes.requests = {
      requests: [
        openRequestOf('run-a', 'item-9', 'Which invoices should we export?'),
      ],
      error: null,
      answer: vi.fn(),
    };
    timelineWith([questionEventOf('run-a', 'item-9', 'Old billing name')]);
    await renderPage();
    clickOn(timelineToggle());

    clickOn(replyButton());

    expect(
      container.querySelector('[data-slot="answer-popover-title"]')!
        .textContent,
    ).toBe('Thread run-a');
  });
});

describe('CommandCenter — showing a timeline row on the canvas', () => {
  it('shows a timeline row’s thread on the canvas, and never goes to Chats', async () => {
    timelineWith([
      {
        id: 'pull_request:418',
        kind: 'pull_request',
        at: NOW_ISO,
        threadRunId: 'run-b',
        threadTitle: 'Thread run-b',
        text: null,
        detail: '418',
        awaitingReply: false,
      },
    ]);
    await renderPage();
    clickOn(timelineToggle());

    clickOn(
      container.querySelector(
        'button[aria-label="Show Thread run-b on the canvas"]',
      ),
    );
    await settle();

    expect(probes.graph!.openCards.map((card) => card.runId)).toEqual([
      'run-b',
    ]);
    expect(onOpenThread).not.toHaveBeenCalled();
  });
});

describe('CommandCenter — the working tile on the canvas', () => {
  function workingBoard(): void {
    fakes.board = boardOf([
      cardOf('run-w', 'p1', 'working'),
      cardOf('run-a', 'p1'),
    ]);
  }

  it('draws the working tile on the canvas in the box of the chat button, left of it', async () => {
    workingBoard();
    await renderPage();

    const tile = container.querySelector<HTMLElement>(
      '[data-slot="working-threads-card"]',
    )!;
    const toggle = container.querySelector<HTMLElement>(
      '[data-slot="command-center-chat-toggle"]',
    )!;
    const box = tile.parentElement!;
    expect(box.parentElement).toBe(toggle.parentElement);
    expect(box.className).toContain('bottom-4');
    expect(box.className).toContain('right-17');
  });

  it('draws no working tile when no thread is working', async () => {
    await renderPage();

    expect(
      container.querySelector('[data-slot="working-threads-card"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="command-center-chat-toggle"]'),
    ).not.toBeNull();
  });

  it('hides the working tile with the chat button on a phone once a thread card is open', async () => {
    stubMatchMedia(true);
    workingBoard();
    await renderPage();
    expect(
      container.querySelector('[data-slot="working-threads-card"]'),
    ).not.toBeNull();

    act(() => {
      probes.dock!.onOpenThread('run-a');
    });

    expect(
      container.querySelector('[data-slot="command-center-chat-toggle"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="working-threads-card"]'),
    ).toBeNull();
  });

  it('opens a working thread from the tile as its card on the canvas', async () => {
    workingBoard();
    await renderPage();

    clickOn(
      container.querySelector('[data-slot="working-threads-toggle"] button'),
    );
    clickOn(
      container.querySelector(
        '[data-slot="working-thread-row"][data-run="run-w"]',
      ),
    );

    expect(probes.graph!.openCards.map((card) => card.runId)).toEqual([
      'run-w',
    ]);
    expect(onOpenThread).not.toHaveBeenCalled();
  });
});
