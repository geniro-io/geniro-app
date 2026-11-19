// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../../shared/contracts';
import type { DaemonClient } from '../daemon-client';
import { CommandCenter } from './CommandCenter';
import type { GraphViewProps } from './graph-view';

const { probes, fakes } = vi.hoisted(() => ({
  probes: {
    graph: null as GraphViewProps | null,
    dock: null as { onOpenThread: (runId: string) => void } | null,
  },
  fakes: {
    board: null as unknown,
    timeline: null as unknown,
    requests: null as unknown,
    projects: null as unknown,
    sources: null as unknown,
    capabilities: null as unknown,
    managerChoice: null as unknown,
    pullRequests: null as unknown,
    apis: null as unknown,
  },
}));

vi.mock('./use-command-center-board', () => ({
  useCommandCenterBoard: () => fakes.board,
}));
vi.mock('./use-command-center-timeline', () => ({
  useCommandCenterTimeline: () => fakes.timeline,
}));
vi.mock('./use-open-requests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./use-open-requests')>()),
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
  ...(await importOriginal<
    typeof import('../chats/use-thread-pull-requests')
  >()),
  useThreadPullRequests: () => fakes.pullRequests,
}));
vi.mock('../daemon-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-api')>()),
  createDaemonApis: () => fakes.apis,
}));
vi.mock('./graph-view', () => ({
  GraphView: (props: GraphViewProps) => {
    probes.graph = props;
    return <div data-slot="stub-graph" />;
  },
}));
vi.mock('./manager-dock', () => ({
  ManagerDock: (props: { onOpenThread: (runId: string) => void }) => {
    probes.dock = props;
    return <div data-slot="stub-manager-dock" />;
  },
}));
vi.mock('../components/ui/select', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/ui/select')>()),
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

function cardOf(runId: string, projectId: string): unknown {
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
    column: 'idle',
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
      await new Promise((resolve) => setTimeout(resolve, 0));
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

  it('turns the chat view into the split when a thread is shown from it', async () => {
    localStorage.setItem('commandCenter.view', 'chat');
    await renderPage();
    expect(probes.graph).toBeNull();

    act(() => {
      probes.dock!.onOpenThread('run-b');
    });
    await settle();

    expect(localStorage.getItem('commandCenter.view')).toBe('both');
    expect(probes.graph!.openCards.map((card) => card.runId)).toEqual([
      'run-b',
    ]);
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
