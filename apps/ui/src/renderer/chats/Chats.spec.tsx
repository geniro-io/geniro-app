// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatItem, ChatRun, GeniroApi } from '../../shared/contracts';
import type { DaemonClient, VerdictAck } from '../daemon-client';
import { Chats } from './Chats';

// Tell React this is an act()-aware environment (testing-library sets this for
// you; with raw react-dom/client + react's act we set it ourselves).
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ChatApi is mocked so the component never issues real fetches; the test drives
// history/listChats through these spies.
const api = vi.hoisted(() => ({
  listChats: vi.fn(),
  getHistory: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  createChat: vi.fn(),
  rename: vi.fn(),
  listSkills: vi.fn(),
}));
// A constructable mock (an arrow fn can't be `new`-ed) whose instance exposes
// the shared spies — so `new ChatApi(handle)` inside the component returns them.
vi.mock('../chat-api', () => ({
  ChatApi: vi.fn(function ChatApiMock(this: Record<string, unknown>) {
    Object.assign(this, api);
  }),
}));

// WorkflowApi is mocked the same way; the mount path lists workflows + runs.
const workflowApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  listRuns: vi.fn(),
  run: vi.fn(),
  cancelRun: vi.fn(),
}));
vi.mock('../workflow-api', () => ({
  WorkflowApi: vi.fn(function WorkflowApiMock(this: Record<string, unknown>) {
    Object.assign(this, workflowApi);
  }),
}));

// TerminalApi + TerminalPanel are mocked so opening a terminal never touches
// xterm or a real socket; the panel stub renders its title for assertions.
const terminalApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('../terminal-api', () => ({
  TerminalApi: vi.fn(function TerminalApiMock(this: Record<string, unknown>) {
    Object.assign(this, terminalApi);
  }),
}));
vi.mock('../terminals/terminal-panel', () => ({
  TerminalPanel: (props: { title: string; onClose: () => void }) => (
    <div data-testid="terminal-panel">
      {props.title}
      <button onClick={props.onClose}>stub-close</button>
    </div>
  ),
}));

const handle = { host: '127.0.0.1', port: 8123, token: 'tok', version: '1' };

function msg(seq: number, role: 'user' | 'assistant', text: string): ChatItem {
  return {
    id: `i${seq}`,
    runId: 'r1',
    nodeId: null,
    seq,
    kind: 'message',
    role,
    payload: { text },
    createdAt: 'now',
  };
}

function terminal(seq: number): ChatItem {
  return {
    id: `i${seq}`,
    runId: 'r1',
    nodeId: null,
    seq,
    kind: 'turn_complete',
    role: null,
    payload: { usage: null, stopReason: null },
    createdAt: 'now',
  };
}

function approval(runId: string, seq: number, requestId: string): ChatItem {
  return {
    id: `${runId}-approval-${seq}`,
    runId,
    nodeId: null,
    seq,
    kind: 'approval_request',
    role: null,
    payload: { id: requestId, toolName: 'Write', input: { path: '/tmp/a' } },
    createdAt: 'now',
  };
}

const run1: ChatRun = {
  id: 'r1',
  status: 'running',
  title: 'My chat',
  agentKind: 'claude',
  workflowId: null,
  cwd: '/proj',
  model: null,
  createdAt: 'now',
  updatedAt: 'now',
  lastMessage: null,
};

// A fake DaemonClient whose item/reconnect listeners the test can fire.
function makeClient(): {
  client: DaemonClient;
  emitItem: (item: ChatItem) => void;
  fireDisconnect: () => void;
  fireReconnect: () => void;
  fireVerdictAck: (ack: VerdictAck) => void;
  joinRun: ReturnType<typeof vi.fn>;
} {
  let itemListener: ((item: ChatItem) => void) | null = null;
  let reconnectListener: ((error?: Error) => void) | null = null;
  let disconnectListener: (() => void) | null = null;
  let verdictAckListener: ((ack: VerdictAck) => void) | null = null;
  const joinRun = vi.fn(async () => {});
  const client = {
    onItem: (l: (item: ChatItem) => void) => {
      itemListener = l;
      return () => {
        itemListener = null;
      };
    },
    onReconnect: (l: (error?: Error) => void) => {
      reconnectListener = l;
      return () => {
        reconnectListener = null;
      };
    },
    onDisconnect: (l: () => void) => {
      disconnectListener = l;
      return () => {
        disconnectListener = null;
      };
    },
    onVerdictAck: (l: (ack: VerdictAck) => void) => {
      verdictAckListener = l;
      return () => {
        verdictAckListener = null;
      };
    },
    joinRun,
    leaveRun: vi.fn(),
    sendVerdict: vi.fn(),
  } as unknown as DaemonClient;
  return {
    client,
    emitItem: (item) => itemListener?.(item),
    fireDisconnect: () => disconnectListener?.(),
    fireReconnect: () => reconnectListener?.(),
    fireVerdictAck: (ack) => verdictAckListener?.(ack),
    joinRun,
  };
}

const roots: Root[] = [];

async function mount(client: DaemonClient): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<Chats client={client} handle={handle} />);
  });
  return container;
}

async function clickRun(container: HTMLElement, title: string): Promise<void> {
  const li = [...container.querySelectorAll('li')].find((el) =>
    el.textContent?.includes(title),
  );
  // The row's activation surface is its overlay button (the li's first child).
  const activate = li?.querySelector<HTMLButtonElement>('button');
  await act(async () => {
    activate?.click();
  });
}

/** The composer's round icon actions, looked up by their accessible name. */
function composerButton(
  container: HTMLElement,
  label: 'Send' | 'Stop' | 'Queue',
): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

beforeEach(() => {
  // jsdom has no scrollIntoView; the transcript auto-scroll effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { geniro: Partial<GeniroApi> }).geniro = {
    getSettings: vi.fn().mockResolvedValue({
      onboardingComplete: true,
      projectFolder: '/proj',
      recentFolders: [],
      lastChatTarget: null,
      cliPaths: {},
      checkForUpdates: true,
    }),
    updateSettings: vi.fn().mockResolvedValue({}),
  };
  api.listChats.mockReset().mockResolvedValue([run1]);
  api.getHistory.mockReset().mockResolvedValue([]);
  api.sendMessage.mockReset();
  api.cancel.mockReset().mockResolvedValue({ cancelled: true });
  api.createChat.mockReset();
  api.rename.mockReset();
  api.listSkills.mockReset().mockResolvedValue([]);
  workflowApi.list.mockReset().mockResolvedValue([]);
  workflowApi.get.mockReset().mockResolvedValue({
    slug: 'review-team',
    workflow: { name: 'Review team', nodes: [], edges: [] },
  });
  workflowApi.listRuns.mockReset().mockResolvedValue([]);
  workflowApi.run.mockReset();
  workflowApi.cancelRun.mockReset().mockResolvedValue({ cancelled: true });
  terminalApi.create.mockReset();
  terminalApi.list.mockReset().mockResolvedValue([]);
  terminalApi.dispose.mockReset().mockResolvedValue({ disposed: true });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots) {
      root.unmount();
    }
  });
  roots.length = 0;
  document.body.replaceChildren(); // reset the jsdom document between tests
});

describe('Chats reconnect seam', () => {
  it('waits for room membership before fetching the history snapshot', async () => {
    let resolveJoin!: () => void;
    const joined = new Promise<void>((resolve) => {
      resolveJoin = resolve;
    });
    const { client, joinRun } = makeClient();
    joinRun.mockReturnValueOnce(joined);
    const container = await mount(client);

    await clickRun(container, 'My chat');
    expect(api.getHistory).not.toHaveBeenCalled();

    await act(async () => {
      resolveJoin();
      await joined;
    });
    expect(api.getHistory).toHaveBeenCalledWith('r1');
  });

  it('de-dupes a live item that repeats a replayed history seq (renders once)', async () => {
    api.getHistory.mockResolvedValue([
      msg(0, 'user', 'hi'),
      msg(1, 'assistant', 'hello'),
    ]);
    const { client, emitItem } = makeClient();
    const container = await mount(client);

    await clickRun(container, 'My chat');
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(
      1,
    );

    // A live WS copy of the seq-1 item arrives (the join/replay overlap).
    await act(async () => {
      emitItem(msg(1, 'assistant', 'hello'));
    });
    // Still one assistant row — de-duped by seq, not appended twice.
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(
      1,
    );

    // A genuinely new seq DOES append.
    await act(async () => {
      emitItem(msg(2, 'assistant', 'more'));
    });
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(
      2,
    );
  });

  it('inserts an out-of-order live item in seq order, not at the tail', async () => {
    // History arrives seq-sorted; a reconnect/replay delta can deliver a seq
    // BELOW the tail. That skips the fast-path append and must re-sort — the
    // late item has to land between its neighbours, not after a higher seq.
    api.getHistory.mockResolvedValue([
      msg(0, 'assistant', 'ITEM-A'),
      msg(2, 'assistant', 'ITEM-C'),
    ]);
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    // seq 1 < the tail's seq 2 → fast-path append is skipped; the slow path
    // must place B between A and C.
    await act(async () => {
      emitItem(msg(1, 'assistant', 'ITEM-B'));
    });

    const rendered = [...container.querySelectorAll('[data-role="assistant"]')]
      .map((el) => el.textContent ?? '')
      .join('|');
    // Reverting the .sort() to a plain [...prev, item] append lands B AFTER C.
    expect(rendered.indexOf('ITEM-A')).toBeLessThan(rendered.indexOf('ITEM-B'));
    expect(rendered.indexOf('ITEM-B')).toBeLessThan(rendered.indexOf('ITEM-C'));
  });

  it('ignores a live item addressed to a non-active run', async () => {
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi')]);
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    const before = container.querySelectorAll('[data-role]').length;
    await act(async () => {
      emitItem({ ...msg(5, 'assistant', 'other run'), runId: 'r2' });
    });
    expect(container.querySelectorAll('[data-role]')).toHaveLength(before);
  });

  it('on reconnect fetches only the delta past the last rendered seq', async () => {
    api.getHistory.mockImplementation((_runId: string, afterSeq?: number) => {
      if (afterSeq === undefined) {
        return Promise.resolve([
          msg(0, 'user', 'hi'),
          msg(1, 'assistant', 'a'),
        ]);
      }
      if (afterSeq === 1) {
        return Promise.resolve([msg(2, 'assistant', 'delta')]);
      }
      return Promise.resolve([]);
    });
    const { client, fireDisconnect, fireReconnect } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(
      1,
    );

    await act(async () => {
      fireDisconnect();
      fireReconnect();
    });

    // onReconnect asked for items strictly after the last rendered seq (1)…
    expect(api.getHistory).toHaveBeenCalledWith('r1', 1);
    // …and merged the delta in.
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(
      2,
    );
    expect(container.textContent).toContain('delta');
  });

  it('replays offline items when a newer live item arrives before reconnect recovery starts', async () => {
    api.getHistory.mockImplementation((_runId: string, afterSeq?: number) => {
      if (afterSeq === undefined) {
        return Promise.resolve([
          msg(0, 'user', 'initial'),
          msg(1, 'assistant', 'before-disconnect'),
        ]);
      }
      if (afterSeq === 1) {
        return Promise.resolve([
          msg(2, 'assistant', 'missed-offline-2'),
          msg(3, 'assistant', 'missed-offline-3'),
          msg(4, 'assistant', 'first-live-after-rejoin'),
        ]);
      }
      return Promise.resolve([]);
    });
    const { client, emitItem, fireDisconnect, fireReconnect } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await act(async () => {
      fireDisconnect();
      // Room membership is restored before the reconnect callback runs, so a
      // persisted live item can advance the rendered cursor before delta replay.
      emitItem(msg(4, 'assistant', 'first-live-after-rejoin'));
      fireReconnect();
    });

    expect(container.textContent).toContain('missed-offline-2');
    expect(container.textContent).toContain('missed-offline-3');
    expect(container.textContent).toContain('first-live-after-rejoin');
  });

  it('shows the working state (Stop) when activating an in-flight run', async () => {
    // Run is `running` and the transcript does not end on a terminal item, so the
    // composer must reflect the in-flight turn rather than offer an enabled Send.
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi')]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    expect(composerButton(container, 'Stop')).not.toBeNull();
    expect(composerButton(container, 'Send')).toBeNull();
  });

  it('ignores a stale activateRun completion after switching to another run', async () => {
    // Click running run A (slow history fetch), then idle run B before A's
    // fetch resolves: A's late completion must not replay its items into B's
    // transcript nor re-arm Stop/streaming for B.
    const run2: ChatRun = {
      ...run1,
      id: 'r2',
      title: 'Second chat',
      status: 'completed',
    };
    api.listChats.mockResolvedValue([run1, run2]);
    let resolveSlow!: (items: ChatItem[]) => void;
    api.getHistory.mockImplementation((runId: string) => {
      if (runId === 'r1') {
        return new Promise<ChatItem[]>((resolve) => {
          resolveSlow = resolve;
        });
      }
      // No terminal item: B is idle via its `completed` status, so the
      // stale-A derive (which checks sawTerminalRef) stays observable.
      return Promise.resolve([
        { ...msg(0, 'user', 'finished-B-transcript'), runId: 'r2' },
      ]);
    });
    const { client } = makeClient();
    const container = await mount(client);

    await clickRun(container, 'My chat'); // A — fetch hangs
    await clickRun(container, 'Second chat'); // B activates meanwhile

    await act(async () => {
      // A's fetch finally resolves: run A is `running` with a non-terminal
      // transcript — exactly the shape that would arm Stop without the guard.
      resolveSlow([msg(0, 'user', 'stale-A-item')]);
    });

    expect(composerButton(container, 'Stop')).toBeNull();
    expect(container.textContent).not.toContain('stale-A-item');
    expect(container.textContent).toContain('finished-B-transcript');
  });

  it('does not surface a failed reconnect fetch as an error on the run switched to meanwhile', async () => {
    // Reconnect fires for run A and its delta fetch hangs; the user switches to
    // run B before A's fetch settles, then A's fetch REJECTS. The rejection is
    // addressed to the no-longer-active run A, so it must not paint an error
    // banner over run B (the same cross-run contamination the activateRun
    // fetch guards against on its own catch).
    const run2: ChatRun = {
      ...run1,
      id: 'r2',
      title: 'Second chat',
      status: 'completed',
    };
    api.listChats.mockResolvedValue([run1, run2]);
    let rejectReconnect!: (err: unknown) => void;
    api.getHistory.mockImplementation((runId: string, afterSeq?: number) => {
      // A's reconnect delta (afterSeq set) hangs until the test rejects it.
      if (runId === 'r1' && afterSeq !== undefined) {
        return new Promise<ChatItem[]>((_resolve, reject) => {
          rejectReconnect = reject;
        });
      }
      if (runId === 'r2') {
        // msg() hardcodes runId 'r1'; addItem is run-scoped by item.runId, so
        // B's own transcript item must carry runId 'r2' to render under run B.
        return Promise.resolve([
          { ...msg(0, 'user', 'B-transcript'), runId: 'r2' },
        ]);
      }
      // A's initial activate history.
      return Promise.resolve([msg(0, 'user', 'A-transcript')]);
    });
    const { client, fireDisconnect, fireReconnect } = makeClient();
    const container = await mount(client);

    await clickRun(container, 'My chat'); // A active
    await act(async () => {
      fireDisconnect();
      fireReconnect(); // A's delta fetch starts hanging
    });
    await clickRun(container, 'Second chat'); // switch to B while A's fetch hangs

    await act(async () => {
      rejectReconnect(new Error('reconnect delta failed for A'));
      await Promise.resolve();
    });

    // The error belonged to run A, which is no longer active — B must not show it.
    expect(container.textContent).not.toContain('reconnect delta failed for A');
    expect(container.textContent).toContain('B-transcript');
  });

  it('does not show the working state when an in-flight run already ended on a terminal item', async () => {
    // status 'running' but the replayed transcript ends on a terminal item → the
    // derive must NOT re-arm Stop.
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi'), terminal(1)]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    expect(composerButton(container, 'Send')).not.toBeNull();
    expect(composerButton(container, 'Stop')).toBeNull();
  });

  it('clears the stuck working state when Stop finds nothing in flight (cancelled:false)', async () => {
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi')]); // in-flight → Stop shows
    api.cancel.mockResolvedValue({ cancelled: false });
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');
    expect(composerButton(container, 'Stop')).not.toBeNull();

    await act(async () => {
      composerButton(container, 'Stop')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    // cancel reported nothing was in flight → the composer returns to Send.
    expect(composerButton(container, 'Send')).not.toBeNull();
    expect(composerButton(container, 'Stop')).toBeNull();
  });

  it('activates a run via its real activation button (keyboard-activatable by native button semantics)', async () => {
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi')]);
    const { client } = makeClient();
    const container = await mount(client);
    const li = [...container.querySelectorAll('li')].find((el) =>
      el.textContent?.includes('My chat'),
    );
    // The activation surface is a REAL <button> — Enter/Space fire click as
    // native button behavior (which jsdom does not synthesize), so pin the
    // element identity plus its click-driven activation.
    const activate = li?.querySelector<HTMLButtonElement>('button');
    expect(activate?.tagName).toBe('BUTTON');
    await act(async () => {
      activate?.click();
    });

    const active = [...container.querySelectorAll('li')].find((el) =>
      el.querySelector('[aria-current="true"]'),
    );
    expect(active?.textContent).toContain('My chat');
    expect(container.textContent).toContain('hi');
  });
});

describe('Chats verdict acknowledgments', () => {
  it('keeps a second run actionable when a late expired ack reuses its request id', async () => {
    const run2: ChatRun = {
      ...run1,
      id: 'r2',
      title: 'Second chat',
      status: 'running',
    };
    api.listChats.mockResolvedValue([run1, run2]);
    api.getHistory.mockImplementation((runId: string) =>
      Promise.resolve([approval(runId, 0, 'shared-request-id')]),
    );
    const { client, fireVerdictAck } = makeClient();
    const container = await mount(client);

    await clickRun(container, 'My chat');
    const approveFirst = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Approve',
    );
    await act(async () => {
      approveFirst?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await clickRun(container, 'Second chat');
    await act(async () => {
      fireVerdictAck({
        runId: 'r1',
        requestId: 'shared-request-id',
        status: 'expired',
      });
    });

    expect(container.textContent).not.toContain(
      'expired — the turn ended before an answer',
    );
    expect(
      [...container.querySelectorAll('button')].map(
        (button) => button.textContent,
      ),
    ).toContain('Approve');
  });

  it('keeps a later run actionable after the active run receives an expired ack with the same request id', async () => {
    const run2: ChatRun = {
      ...run1,
      id: 'r2',
      title: 'Second chat',
      status: 'running',
    };
    api.listChats.mockResolvedValue([run1, run2]);
    api.getHistory.mockImplementation((runId: string) =>
      Promise.resolve([approval(runId, 0, 'shared-request-id')]),
    );
    const { client, fireVerdictAck } = makeClient();
    const container = await mount(client);

    await clickRun(container, 'My chat');
    await act(async () => {
      fireVerdictAck({
        runId: 'r1',
        requestId: 'shared-request-id',
        status: 'expired',
      });
    });
    expect(container.textContent).toContain(
      'expired — the turn ended before an answer',
    );

    await clickRun(container, 'Second chat');

    expect(container.textContent).not.toContain(
      'expired — the turn ended before an answer',
    );
    expect(
      [...container.querySelectorAll('button')].map(
        (button) => button.textContent,
      ),
    ).toContain('Approve');
  });
});

describe('Chats workflow runs', () => {
  const wfRun: ChatRun = {
    id: 'w1',
    status: 'running',
    title: 'Review team',
    agentKind: null,
    workflowId: 'review-team',
    cwd: '/proj',
    model: null,
    createdAt: 'later',
    updatedAt: 'later',
    lastMessage: null,
  };

  function wfItem(
    seq: number,
    kind: ChatItem['kind'],
    nodeId: string | null,
  ): ChatItem {
    return {
      id: `w-i${seq}`,
      runId: 'w1',
      nodeId,
      seq,
      kind,
      role: null,
      payload: kind === 'status' ? { status: 'completed' } : {},
      createdAt: 'now',
    };
  }

  it('keeps the working state past a NODE terminal item, clears it on the RUN terminal', async () => {
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Review team');

    const sidebarRow = (): string =>
      [...container.querySelectorAll('aside li')].find((el) =>
        el.textContent?.includes('Review team'),
      )?.textContent ?? '';
    expect(composerButton(container, 'Stop')).not.toBeNull();
    expect(sidebarRow()).toContain('running');

    // A node's own turn_complete must NOT re-enable the composer…
    await act(async () => {
      emitItem(wfItem(5, 'turn_complete', 'coder'));
    });
    expect(composerButton(container, 'Stop')).not.toBeNull();
    expect(sidebarRow()).toContain('running');

    // …only the run-level terminal item does — and it settles the sidebar
    // status too (a finished run must not keep its stale 'running' badge).
    await act(async () => {
      emitItem(wfItem(6, 'turn_complete', null));
    });
    expect(composerButton(container, 'Stop')).toBeNull();
    expect(sidebarRow()).toContain('completed');
    expect(sidebarRow()).not.toContain('running');
  });

  it('a callee sub-turn streams into ONE communication card — no separate "started" row, no interleaved text', async () => {
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Review team');

    await act(async () => {
      emitItem({
        ...wfItem(5, 'call_started', 'orch'),
        payload: {
          callId: 'call-1',
          calleeNodeId: 'helper',
          mode: 'async',
          message: 'summarize the diff',
        },
      });
      emitItem({
        ...wfItem(6, 'status', 'helper'),
        payload: { nodeId: 'helper', status: 'running', callId: 'call-1' },
      });
      emitItem({
        ...wfItem(7, 'message', 'helper'),
        payload: { text: 'the diff summary', callId: 'call-1' },
      });
    });

    const block = container.querySelector('[data-role="call-block"]');
    expect(block).not.toBeNull();
    // ONE communication card, not the old redundant pair: no separate
    // started note, and everything the callee streams renders INSIDE the
    // card — the main flow never interleaves it.
    const transcript = container.querySelector('section')!;
    expect(transcript.textContent).not.toContain('helper started');
    expect(block?.textContent).toContain('orch → helper');
    expect(block?.textContent).toContain('summarize the diff');
    expect(block?.textContent).toContain('the diff summary');
    // The callee text lives ONLY in the card (one occurrence in the section).
    const occurrences =
      transcript.textContent?.split('the diff summary').length ?? 0;
    expect(occurrences - 1).toBe(1);
  });

  it('streamed tool calls land as a COLLAPSED group row, not raw payload rows', async () => {
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Review team');

    await act(async () => {
      emitItem({
        ...wfItem(5, 'tool_call', 'coder'),
        payload: { id: 't1', name: 'Bash', input: { command: 'ls -la' } },
      });
      emitItem({
        ...wfItem(6, 'tool_result', 'coder'),
        payload: { id: 't1', name: null, result: 'file-list' },
      });
    });

    expect(container.textContent).toContain('Used 1 tool');
    // Collapsed by default: neither the input nor the result payload shows.
    expect(container.textContent).not.toContain('ls -la');
    expect(container.textContent).not.toContain('file-list');
  });

  it("a workflow that rolled up failed settles the sidebar as failed — the terminal item's kind alone must not read as success", async () => {
    // The daemon ends EVERY workflow run with a run-level turn_complete whose
    // stopReason carries the roll-up; with a failed node the run row says
    // 'failed' while the item kind still says turn_complete.
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Review team');

    const sidebarRow = (): string =>
      [...container.querySelectorAll('aside li')].find((el) =>
        el.textContent?.includes('Review team'),
      )?.textContent ?? '';

    await act(async () => {
      emitItem({
        ...wfItem(6, 'turn_complete', null),
        payload: { usage: null, stopReason: 'workflow_failed' },
      });
    });
    expect(composerButton(container, 'Stop')).toBeNull();
    expect(sidebarRow()).toContain('failed');
    expect(sidebarRow()).not.toContain('completed');
    // The transcript's run-level note tells the same story.
    expect(container.textContent).toContain('✗ failed');
    expect(container.textContent).not.toContain('✓ done');
  });

  it('starts a NEW workflow run from the + composer even while a chat run is open (never routes into the chat)', async () => {
    workflowApi.list.mockResolvedValue([
      {
        slug: 'review-team',
        name: 'Review team',
        description: null,
        nodeCount: 2,
        updatedAt: 'now',
      },
    ]);
    workflowApi.run.mockResolvedValue({ ...wfRun, id: 'w2' });
    // An ordinary FINISHED chat is open (an in-flight one would show Stop).
    api.listChats.mockResolvedValue([{ ...run1, status: 'completed' }]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    // The open chat shows no target select — a new run starts from +.
    const plus = container.querySelector('[aria-label="New chat"]')!;
    await act(async () => {
      plus.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const select = container.querySelector('select')!;
    await act(async () => {
      const setSelect = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setSelect.call(select, 'wf:review-team');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setValue.call(textarea, 'build it');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const startButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Start run"]',
    )!;
    await act(async () => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(workflowApi.run).toHaveBeenCalledWith('review-team', {
      cwd: '/proj',
      prompt: 'build it',
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('a failed run start restores the typed task into the composer (no data loss)', async () => {
    workflowApi.list.mockResolvedValue([
      {
        slug: 'review-team',
        name: 'Review team',
        description: null,
        nodeCount: 2,
        updatedAt: 'now',
      },
    ]);
    // The daemon is briefly down (e.g. a Settings save just restarted it).
    workflowApi.run.mockRejectedValue(new Error('daemon POST failed'));
    const { client } = makeClient();
    const container = await mount(client);

    const select = container.querySelector('select')!;
    await act(async () => {
      const setSelect = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setSelect.call(select, 'wf:review-team');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setValue.call(textarea, 'precious task text');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Start run"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The error surfaces AND the typed task stays editable (mirror of the
    // queued path's restoreHead) — a failed send must never eat the prompt.
    expect(container.textContent).toContain('daemon POST failed');
    expect(container.querySelector('textarea')!.value).toBe(
      'precious task text',
    );
  });

  it('does not arm Stop when the new workflow run already ended during activation', async () => {
    workflowApi.list.mockResolvedValue([
      {
        slug: 'review-team',
        name: 'Review team',
        description: null,
        nodeCount: 2,
        updatedAt: 'now',
      },
    ]);
    workflowApi.run.mockResolvedValue({ ...wfRun, id: 'w3' });
    // The run failed fast: its replayed history already carries the run-level
    // terminal item (e.g. the CLI binary was missing).
    api.getHistory.mockResolvedValue([
      { ...wfItem(0, 'error', null), runId: 'w3' },
    ]);
    const { client } = makeClient();
    const container = await mount(client);

    const select = container.querySelector('select')!;
    await act(async () => {
      const setSelect = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setSelect.call(select, 'wf:review-team');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setValue.call(textarea, 'doomed task');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const startButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Start run"]',
    )!;
    await act(async () => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(workflowApi.run).toHaveBeenCalled();
    expect(composerButton(container, 'Stop')).toBeNull();
  });

  it('refetches the workflow library when the tab becomes active again', async () => {
    // The tab stays mounted (hidden) while the user saves a workflow on the
    // Graphs page — coming back must refresh the target selector, not serve
    // the mount-time snapshot.
    const { client } = makeClient();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<Chats client={client} handle={handle} active />);
    });
    expect(workflowApi.list).toHaveBeenCalledTimes(1);
    expect(container.querySelector('select')!.textContent).not.toContain(
      'demo-duo',
    );

    // Hidden behind the Graphs page (no refetch fires)…
    workflowApi.list.mockResolvedValue([
      {
        slug: 'demo-duo',
        name: 'demo-duo',
        description: null,
        nodeCount: 2,
        updatedAt: 'now',
      },
    ]);
    await act(async () => {
      root.render(<Chats client={client} handle={handle} active={false} />);
    });
    expect(workflowApi.list).toHaveBeenCalledTimes(1);

    // …and back: the selector now offers the workflow saved over there.
    await act(async () => {
      root.render(<Chats client={client} handle={handle} active />);
    });
    expect(workflowApi.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('select')!.textContent).toContain(
      'demo-duo',
    );
  });

  it('surfaces the workflow trigger under the composer — the entry the run starts from', async () => {
    workflowApi.list.mockResolvedValue([
      {
        slug: 'review-team',
        name: 'Review team',
        description: null,
        nodeCount: 2,
        updatedAt: 'now',
      },
    ]);
    workflowApi.get.mockResolvedValue({
      slug: 'review-team',
      workflow: {
        name: 'Review team',
        nodes: [
          { id: 'start', kind: 'trigger', trigger: 'manual', name: 'Start' },
          { id: 'a1', kind: 'agent', agent: 'claude', approval: 'auto' },
        ],
        edges: [],
      },
    });
    const { client } = makeClient();
    const container = await mount(client);

    // Agent target: no trigger select in the composer.
    expect(
      container.querySelector('[aria-label="Trigger the run starts from"]'),
    ).toBeNull();

    const select = container.querySelector('select')!;
    await act(async () => {
      const setSelect = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setSelect.call(select, 'wf:review-team');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const triggerSelect = container.querySelector(
      '[aria-label="Trigger the run starts from"]',
    )!;
    expect(triggerSelect.textContent).toContain('Start · manual trigger');
  });

  it('routes Stop on a workflow run to the workflow cancel endpoint', async () => {
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Review team');

    await act(async () => {
      composerButton(container, 'Stop')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(workflowApi.cancelRun).toHaveBeenCalledWith('w1');
    expect(api.cancel).not.toHaveBeenCalled();
  });
});

describe('Chats terminal mirror', () => {
  const session = {
    id: 't-1',
    runId: 'r1',
    nodeId: null,
    resumeSessionId: null,
    cwd: '/proj',
    status: 'running',
    exitCode: null,
    createdAt: 0,
  };

  /** Terminals live in the agents side panel: open it, expand the agent,
   *  click the thread's terminal action. */
  async function openThreadTerminal(
    container: HTMLElement,
    agentLabel: string,
    threadId = 'main',
  ): Promise<void> {
    const toggle = container.querySelector(
      'button[aria-label="Open side panel"]',
    );
    if (toggle) {
      await act(async () => {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }
    await act(async () => {
      container
        .querySelector(`button[aria-label="${agentLabel} threads"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector(
          `button[aria-label="Open terminal for ${agentLabel} — ${threadId}"]`,
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('opens a terminal panel for a claude chat run', async () => {
    terminalApi.create.mockResolvedValue(session);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await openThreadTerminal(container, 'claude');

    expect(terminalApi.create).toHaveBeenCalledWith({ runId: 'r1' });
    expect(
      container.querySelector('[data-testid="terminal-panel"]')?.textContent,
    ).toContain('My chat — terminal');
  });

  it('offers a per-node terminal on a workflow run and passes the nodeId', async () => {
    const wfRun: ChatRun = {
      id: 'w1',
      status: 'running',
      title: 'Review team',
      agentKind: null,
      workflowId: 'review-team',
      cwd: '/proj',
      model: null,
      createdAt: 'later',
      updatedAt: 'later',
      lastMessage: null,
    };
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    workflowApi.get.mockResolvedValue({
      slug: 'review-team',
      workflow: {
        name: 'Review team',
        nodes: [
          {
            id: 'agent-1',
            kind: 'agent',
            agent: 'claude',
            approval: 'auto',
          },
        ],
        edges: [],
      },
    });
    api.getHistory.mockResolvedValue([
      // The node's DAG turn started — that running transition IS its main
      // thread (the panel derives threads from status items).
      {
        id: 'w-s1',
        runId: 'w1',
        nodeId: 'agent-1',
        seq: 0,
        kind: 'status',
        role: null,
        payload: { nodeId: 'agent-1', status: 'running' },
        createdAt: 'now',
      },
      {
        id: 'w-i1',
        runId: 'w1',
        nodeId: 'agent-1',
        seq: 1,
        kind: 'message',
        role: 'assistant',
        payload: { text: 'planning' },
        createdAt: 'now',
      },
    ]);
    terminalApi.create.mockResolvedValue({
      ...session,
      runId: 'w1',
      nodeId: 'agent-1',
    });
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Review team');

    await openThreadTerminal(container, 'agent-1');

    expect(terminalApi.create).toHaveBeenCalledWith({
      runId: 'w1',
      nodeId: 'agent-1',
    });
    expect(
      container.querySelector('[data-testid="terminal-panel"]')?.textContent,
    ).toContain('agent-1 — terminal');
  });

  it('hides terminal actions for trigger and cursor-agent workflow nodes', async () => {
    const wfRun: ChatRun = {
      id: 'w1',
      status: 'running',
      title: 'Mixed team',
      agentKind: null,
      workflowId: 'mixed-team',
      cwd: '/proj',
      model: null,
      createdAt: 'later',
      updatedAt: 'later',
      lastMessage: null,
    };
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    workflowApi.get.mockResolvedValue({
      slug: 'mixed-team',
      workflow: {
        name: 'Mixed team',
        nodes: [
          { id: 'start', kind: 'trigger', trigger: 'manual' },
          {
            id: 'cursor',
            kind: 'agent',
            agent: 'cursor-agent',
            approval: 'auto',
          },
          {
            id: 'claude',
            kind: 'agent',
            agent: 'claude',
            approval: 'auto',
          },
        ],
        edges: [],
      },
    });
    api.getHistory.mockResolvedValue(
      ['start', 'cursor', 'claude'].map((nodeId, index) => ({
        id: `w-i${index}`,
        runId: 'w1',
        nodeId,
        seq: index,
        kind: 'status',
        role: null,
        payload: { nodeId, status: 'running' },
        createdAt: 'now',
      })),
    );
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Mixed team');

    // The panel lists cursor as a WORKING agent with its thread, but only
    // claude gets a terminal affordance; the trigger is no agent at all.
    await act(async () => {
      container
        .querySelector('button[aria-label="Open side panel"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const panel = container.querySelector('aside[aria-label="Run agents"]')!;
    expect(panel.textContent).not.toContain('start');
    for (const agentLabel of ['cursor', 'claude']) {
      await act(async () => {
        panel
          .querySelector(`button[aria-label="${agentLabel} threads"]`)
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }
    expect(
      panel.querySelector(
        'button[aria-label="Open terminal for claude — main"]',
      ),
    ).not.toBeNull();
    expect(
      panel.querySelector(
        'button[aria-label="Open terminal for cursor — main"]',
      ),
    ).toBeNull();
  });

  it('unmounts the fixed panel while the tab is hidden and restores it on return', async () => {
    terminalApi.create.mockResolvedValue(session);
    const { client } = makeClient();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<Chats client={client} handle={handle} active />);
    });
    await clickRun(container, 'My chat');
    await openThreadTerminal(container, 'claude');
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeTruthy();

    // Hidden tab: the fixed-position drawer must NOT overlay Graphs/Settings —
    // and hiding is a detach, never an End session.
    await act(async () => {
      root.render(<Chats client={client} handle={handle} active={false} />);
    });
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeNull();
    expect(terminalApi.dispose).not.toHaveBeenCalled();

    // Back to the tab: the kept session state re-mounts the panel.
    await act(async () => {
      root.render(<Chats client={client} handle={handle} active />);
    });
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeTruthy();
  });

  it('re-attaches to a running session instead of creating a second one', async () => {
    // The daemon keeps a detached session alive for exactly this re-open; a
    // blind create() would leak one live claude REPL per open→close→open.
    terminalApi.list.mockResolvedValue([session]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await openThreadTerminal(container, 'claude');

    expect(terminalApi.create).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeTruthy();
  });

  it('Close only DETACHES — the popup never disposes the daemon session', async () => {
    terminalApi.create.mockResolvedValue(session);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');
    await openThreadTerminal(container, 'claude');

    const close = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'stub-close',
    );
    await act(async () => {
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(terminalApi.dispose).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeNull();
  });

  it('surfaces a daemon rejection (unsupported agent) in the error line', async () => {
    terminalApi.create.mockRejectedValue(
      new Error('daemon POST /v1/terminals failed (400): TERMINAL_UNSUPPORTED'),
    );
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await openThreadTerminal(container, 'claude');

    expect(container.textContent).toContain('TERMINAL_UNSUPPORTED');
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeNull();
  });
});

describe('Chats composer memory & suggestions', () => {
  function stubSettings(overrides: Record<string, unknown>): void {
    (
      window as unknown as { geniro: { getSettings: ReturnType<typeof vi.fn> } }
    ).geniro.getSettings = vi.fn().mockResolvedValue({
      onboardingComplete: true,
      projectFolder: '/proj',
      recentFolders: [],
      lastChatTarget: null,
      cliPaths: {},
      checkForUpdates: true,
      ...overrides,
    });
  }

  const reviewTeamSummary = {
    slug: 'review-team',
    name: 'Review team',
    description: null,
    nodeCount: 2,
    updatedAt: 'now',
  };

  it('restores the remembered target once the workflow library confirms it', async () => {
    stubSettings({ lastChatTarget: 'wf:review-team' });
    workflowApi.list.mockResolvedValue([reviewTeamSummary]);
    const { client } = makeClient();
    const container = await mount(client);

    expect(container.querySelector('select')!.value).toBe('wf:review-team');
  });

  it('falls back to claude when the remembered workflow no longer exists', async () => {
    stubSettings({ lastChatTarget: 'wf:deleted-team' });
    workflowApi.list.mockResolvedValue([reviewTeamSummary]);
    const { client } = makeClient();
    const container = await mount(client);

    expect(container.querySelector('select')!.value).toBe('claude');
  });

  it('persists a target change as the next default', async () => {
    workflowApi.list.mockResolvedValue([reviewTeamSummary]);
    const { client } = makeClient();
    const container = await mount(client);

    const select = container.querySelector('select')!;
    await act(async () => {
      const setSelect = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setSelect.call(select, 'wf:review-team');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(window.geniro.updateSettings).toHaveBeenCalledWith({
      lastChatTarget: 'wf:review-team',
    });
  });

  it('a recent-folder chip adopts the folder and re-persists recency order', async () => {
    stubSettings({ recentFolders: ['/proj', '/alpha', '/beta'] });
    const { client } = makeClient();
    const container = await mount(client);

    // The CURRENT folder (/proj) is not suggested — only the other two.
    const chips = [...container.querySelectorAll('button')].filter((b) =>
      /alpha|beta|proj/.test(b.textContent ?? ''),
    );
    expect(chips.map((b) => b.textContent?.trim())).toEqual([
      'proj', // the folder control inside the card
      'alpha',
      'beta',
    ]);

    await act(async () => {
      chips[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.geniro.updateSettings).toHaveBeenCalledWith({
      projectFolder: '/beta',
      recentFolders: ['/beta', '/proj', '/alpha'],
    });
  });

  it('a workflow chip targets that workflow (and the chip disappears)', async () => {
    workflowApi.list.mockResolvedValue([reviewTeamSummary]);
    const { client } = makeClient();
    const container = await mount(client);

    const chip = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Review team'),
    )!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('select')!.value).toBe('wf:review-team');
    expect(window.geniro.updateSettings).toHaveBeenCalledWith({
      lastChatTarget: 'wf:review-team',
    });
    // The chip for the now-selected workflow is gone.
    expect(
      [...container.querySelectorAll('button')].filter((b) =>
        b.textContent?.includes('Review team'),
      ),
    ).toHaveLength(0);
  });
});

describe('Chats defaults', () => {
  it('creates a new chat with no model — new chats use the CLI default', async () => {
    // The default-model setting was removed; a new chat must NOT carry a model
    // (regressing it would re-introduce the concept this pins as gone).
    // The run is only created when the composer sends its first message.
    api.createChat.mockResolvedValue({ ...run1, id: 'r-new' });
    api.sendMessage.mockResolvedValue(msg(0, 'user', 'hello'));
    const { client } = makeClient();
    const container = await mount(client);

    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setValue.call(textarea, 'hello');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Send"]',
    )!;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(api.createChat).toHaveBeenCalled();
    for (const [arg] of api.createChat.mock.calls) {
      expect(arg).not.toHaveProperty('model');
    }
  });
});

describe('Chats queued messages', () => {
  async function type(container: HTMLElement, text: string): Promise<void> {
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setValue.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function clickButton(
    container: HTMLElement,
    label: string,
  ): Promise<void> {
    await act(async () => {
      container
        .querySelector(`button[aria-label="${label}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  // run1 is 'running' with an empty history → the open transcript arms the
  // working state (Stop) straight from activation.
  it('queues a message written mid-turn and auto-sends it when the turn ends', async () => {
    api.sendMessage.mockResolvedValue(msg(10, 'user', 'queued question'));
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');
    expect(composerButton(container, 'Stop')).not.toBeNull();

    await type(container, 'queued question');
    await clickButton(container, 'Queue');

    // Nothing sent yet — the message waits, visibly, above the composer.
    expect(api.sendMessage).not.toHaveBeenCalled();
    const queueRegion = container.querySelector(
      '[aria-label="Queued messages"]',
    )!;
    expect(queueRegion.textContent).toContain('queued question');
    expect(container.querySelector('textarea')!.value).toBe('');

    // The turn settles → the queued message fires and the run works again.
    await act(async () => {
      emitItem(terminal(5));
    });
    expect(api.sendMessage).toHaveBeenCalledWith('r1', 'queued question');
    expect(
      container.querySelector('[aria-label="Queued messages"]'),
    ).toBeNull();
    expect(composerButton(container, 'Stop')).not.toBeNull();
  });

  it('Cmd+Enter also queues while the agent is working', async () => {
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await type(container, 'via keyboard');
    await act(async () => {
      container.querySelector('textarea')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
        }),
      );
    });

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(
      container.querySelector('[aria-label="Queued messages"]')?.textContent,
    ).toContain('via keyboard');
  });

  it('drains ONE queued message per settled turn, in order', async () => {
    api.sendMessage
      .mockResolvedValueOnce(msg(10, 'user', 'first'))
      .mockResolvedValueOnce(msg(12, 'user', 'second'));
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await type(container, 'first');
    await clickButton(container, 'Queue');
    await type(container, 'second');
    await clickButton(container, 'Queue');

    await act(async () => {
      emitItem(terminal(5));
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenLastCalledWith('r1', 'first');
    // 'second' still waits its turn.
    expect(
      container.querySelector('[aria-label="Queued messages"]')?.textContent,
    ).toContain('second');

    await act(async () => {
      emitItem(terminal(11));
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenLastCalledWith('r1', 'second');
  });

  it('a removed queued message never sends', async () => {
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await type(container, 'changed my mind');
    await clickButton(container, 'Queue');
    await act(async () => {
      container
        .querySelector('button[aria-label="Remove queued message 1"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('[aria-label="Queued messages"]'),
    ).toBeNull();

    await act(async () => {
      emitItem(terminal(5));
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('a failed auto-send keeps the message at the queue head with the error', async () => {
    api.sendMessage.mockRejectedValue(new Error('daemon POST failed (400)'));
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await type(container, 'unlucky');
    await clickButton(container, 'Queue');
    await act(async () => {
      emitItem(terminal(5));
    });

    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('daemon POST failed (400)');
    // The message survives, editable/removable — and does NOT auto-retry
    // (no turn started, so no terminal item will fire the drain).
    expect(
      container.querySelector('[aria-label="Queued messages"]')?.textContent,
    ).toContain('unlucky');
  });

  it('retries a RUN_BUSY auto-send — the daemon frees the turn slot a beat after the terminal item', async () => {
    vi.useFakeTimers();
    try {
      // The terminal item races the daemon's claim release: first two sends
      // hit RUN_BUSY, the third lands.
      api.sendMessage
        .mockRejectedValueOnce(new Error('daemon POST failed (409): RUN_BUSY'))
        .mockRejectedValueOnce(new Error('daemon POST failed (409): RUN_BUSY'))
        .mockResolvedValueOnce(msg(10, 'user', 'delayed'));
      const { client, emitItem } = makeClient();
      const container = await mount(client);
      await clickRun(container, 'My chat');

      await type(container, 'delayed');
      await clickButton(container, 'Queue');
      await act(async () => {
        emitItem(terminal(5));
      });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(api.sendMessage).toHaveBeenCalledTimes(3);

      // Third attempt succeeded: no error line, nothing left queued.
      expect(container.textContent).not.toContain('RUN_BUSY');
      expect(
        container.querySelector('[aria-label="Queued messages"]'),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the queue SURVIVES leaving the transcript and shows again on return', async () => {
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await type(container, 'kept safe');
    await clickButton(container, 'Queue');
    // Leave for the new-run composer — the queue is hidden there, not lost.
    await act(async () => {
      container
        .querySelector('[aria-label="New chat"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('[aria-label="Queued messages"]'),
    ).toBeNull();

    // Back into the still-running chat: the queued message is still there
    // (and stays queued — the run has not settled).
    await clickRun(container, 'My chat');
    expect(
      container.querySelector('[aria-label="Queued messages"]')?.textContent,
    ).toContain('kept safe');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('reopening a run that SETTLED while away drains its queue automatically', async () => {
    api.sendMessage.mockResolvedValue(msg(10, 'user', 'later message'));
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await type(container, 'later message');
    await clickButton(container, 'Queue');
    await act(async () => {
      container
        .querySelector('[aria-label="New chat"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(api.sendMessage).not.toHaveBeenCalled();

    // While away the turn finished — the reopened transcript replays a
    // history that ends on a terminal item, which fires the drain.
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi'), terminal(1)]);
    await clickRun(container, 'My chat');

    expect(api.sendMessage).toHaveBeenCalledWith('r1', 'later message');
    expect(
      container.querySelector('[aria-label="Queued messages"]'),
    ).toBeNull();
  });
});

describe('Chats run composer chips', () => {
  function chips(container: HTMLElement): HTMLElement[] {
    // The info chips are non-interactive Badges — NEVER disabled buttons: a
    // disabled button's pointer-events-none would block the cwd tooltip and
    // its 50% opacity fails AA contrast.
    return [
      ...container.querySelectorAll<HTMLElement>('[data-slot="badge"]'),
    ].filter((el) => el.className.includes('rounded-lg'));
  }

  it("a chat run shows its agent + folder as INACTIVE chips with the create screen's card", async () => {
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi'), terminal(1)]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    const labels = chips(container).map((b) => b.textContent);
    expect(labels).toContain('claude');
    expect(labels.some((l) => l?.includes('proj'))).toBe(true);
    // No chip is rendered as a disabled button (the tooltip-blocking shape).
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
        (b) => b.disabled && b.className.includes('rounded-lg'),
      ),
    ).toEqual([]);
    // The folder chip's full-path tooltip is reachable again (native title).
    const folderChip = chips(container).find((el) =>
      el.textContent?.includes('proj'),
    );
    expect(folderChip?.getAttribute('title')).toBe('/proj');
    // The send action is the same round icon button as the create screen.
    expect(composerButton(container, 'Send')).not.toBeNull();
  });

  it('a workflow run shows workflow + folder + trigger chips and a disabled send', async () => {
    workflowApi.listRuns.mockResolvedValue([
      {
        id: 'w1',
        status: 'completed',
        title: null,
        agentKind: null,
        workflowId: 'review-team',
        cwd: '/proj',
        model: null,
        createdAt: 'later',
        updatedAt: 'later',
        lastMessage: null,
      },
    ]);
    workflowApi.list.mockResolvedValue([
      {
        slug: 'review-team',
        name: 'Review team',
        description: null,
        nodeCount: 2,
        updatedAt: 'now',
      },
    ]);
    workflowApi.get.mockResolvedValue({
      slug: 'review-team',
      workflow: {
        name: 'Review team',
        nodes: [
          { id: 'start', kind: 'trigger', trigger: 'manual', name: 'Start' },
          { id: 'a1', kind: 'agent', agent: 'claude', approval: 'auto' },
        ],
        edges: [],
      },
    });
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Review team');

    const labels = chips(container).map((b) => b.textContent);
    expect(labels.some((l) => l?.includes('Review team'))).toBe(true);
    expect(labels.some((l) => l?.includes('proj'))).toBe(true);
    expect(labels.some((l) => l?.includes('Start · manual trigger'))).toBe(
      true,
    );
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
        (b) => b.disabled && b.className.includes('rounded-lg'),
      ),
    ).toEqual([]);
    // Workflow runs take one task — the round send stays disabled.
    expect(composerButton(container, 'Send')?.disabled).toBe(true);
  });
});

describe('Chats sidebar list', () => {
  const wfSummary = {
    slug: 'review-team',
    name: 'Review team',
    description: null,
    nodeCount: 2,
    updatedAt: 'now',
  };

  it('labels an untitled workflow run with its workflow NAME, not the slug', async () => {
    workflowApi.list.mockResolvedValue([wfSummary]);
    workflowApi.listRuns.mockResolvedValue([
      {
        id: 'w1',
        status: 'completed',
        title: null,
        agentKind: null,
        workflowId: 'review-team',
        cwd: '/proj',
        model: null,
        createdAt: 'later',
        updatedAt: new Date().toISOString(),
        lastMessage: 'Merged the fix.',
      },
    ]);
    api.listChats.mockResolvedValue([]);
    const { client } = makeClient();
    const container = await mount(client);

    const row = [...container.querySelectorAll('aside li')].find((el) =>
      el.textContent?.includes('Review team'),
    );
    expect(row).toBeDefined();
    // The slug never shows as the label; the preview line does.
    expect(row!.textContent).not.toContain('review-team');
    expect(row!.textContent).toContain('Merged the fix.');
  });

  it('renames a run through the dialog and updates the row label', async () => {
    api.rename.mockResolvedValue({ ...run1, title: 'Auth deep-dive' });
    const { client } = makeClient();
    const container = await mount(client);

    const pencil = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename My chat"]',
    )!;
    await act(async () => {
      pencil.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input =
      container.querySelector<HTMLInputElement>('#chat-rename-title')!;
    expect(input.value).toBe('My chat');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setValue.call(input, 'Auth deep-dive');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });

    expect(api.rename).toHaveBeenCalledWith('r1', 'Auth deep-dive');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const row = [...container.querySelectorAll('aside li')].find((el) =>
      el.textContent?.includes('Auth deep-dive'),
    );
    expect(row).toBeDefined();
  });

  it('mirrors a streamed message into the active row as the live preview', async () => {
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    await act(async () => {
      emitItem(msg(0, 'assistant', 'Deploy finished cleanly.'));
    });

    const row = [...container.querySelectorAll('aside li')].find((el) =>
      el.textContent?.includes('My chat'),
    );
    expect(row!.textContent).toContain('Deploy finished cleanly.');
  });

  it('the side panel tracks live agent state — parallel turns, context ring, spend', async () => {
    workflowApi.listRuns.mockResolvedValue([
      {
        id: 'w1',
        status: 'running',
        title: 'Big team',
        agentKind: null,
        workflowId: 'big-team',
        cwd: '/proj',
        model: null,
        createdAt: 'later',
        updatedAt: 'later',
        lastMessage: null,
      },
    ]);
    workflowApi.get.mockResolvedValue({
      slug: 'big-team',
      workflow: {
        name: 'Big team',
        nodes: [
          { id: 'start', kind: 'trigger', trigger: 'manual' },
          {
            id: 'orch',
            kind: 'agent',
            name: 'Orchestrator',
            agent: 'claude',
            approval: 'auto',
          },
          {
            id: 'w-a',
            kind: 'agent',
            name: 'Worker A',
            agent: 'claude',
            approval: 'auto',
          },
          {
            id: 'w-b',
            kind: 'agent',
            name: 'Worker B',
            agent: 'claude',
            approval: 'auto',
          },
          {
            id: 'w-c',
            kind: 'agent',
            name: 'Worker C',
            agent: 'claude',
            approval: 'auto',
          },
        ],
        edges: [],
      },
    });
    const { client, emitItem } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Big team');

    // The header carries NO per-agent chips — only the one generic toggle.
    expect(container.querySelector('button[aria-label^="Agent "]')).toBeNull();
    const toggle = container.querySelector(
      'button[aria-label="Open side panel"]',
    )!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Two parallel callee turns for Worker A + a settled turn with usage.
    await act(async () => {
      emitItem({
        id: 's1',
        runId: 'w1',
        nodeId: 'w-a',
        seq: 10,
        kind: 'status',
        role: null,
        payload: { nodeId: 'w-a', status: 'running' },
        createdAt: 'now',
      });
      emitItem({
        id: 's2',
        runId: 'w1',
        nodeId: 'w-a',
        seq: 11,
        kind: 'status',
        role: null,
        payload: { nodeId: 'w-a', status: 'running' },
        createdAt: 'now',
      });
    });
    const panel = container.querySelector('aside[aria-label="Run agents"]')!;
    const workerRowEl = [...panel.querySelectorAll('li')].find((row) =>
      row.textContent?.includes('Worker A'),
    )!;
    expect(workerRowEl.textContent).toContain('2 active');
    expect(workerRowEl.querySelector('svg.animate-spin')).not.toBeNull();

    await act(async () => {
      emitItem({
        id: 't1',
        runId: 'w1',
        nodeId: 'w-a',
        seq: 12,
        kind: 'turn_complete',
        role: null,
        payload: {
          usage: { contextTokens: 45_200, costUsd: 0.23 },
          stopReason: null,
        },
        createdAt: 'now',
      });
      emitItem({
        id: 's3',
        runId: 'w1',
        nodeId: 'w-a',
        seq: 13,
        kind: 'status',
        role: null,
        payload: { nodeId: 'w-a', status: 'completed' },
        createdAt: 'now',
      });
    });
    const rows = [...panel.querySelectorAll('li')].map(
      (row) => row.textContent,
    );
    expect(rows).toHaveLength(4);
    const workerRow = rows.find((text) => text?.includes('Worker A'));
    // One of its two turns settled — one still live, usage + ring recorded.
    expect(workerRow).toContain('running');
    expect(workerRow).toContain('ctx 45.2k / 200k');
    expect(workerRow).toContain('$0.23');
    expect(
      panel.querySelector('svg[aria-label="Context 23% full"]'),
    ).not.toBeNull();
    expect(rows.some((text) => text?.includes('start'))).toBe(false);

    // ✕ closes the panel.
    await act(async () => {
      panel
        .querySelector('button[aria-label="Close agents panel"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('aside[aria-label="Run agents"]'),
    ).toBeNull();
  });

  it('shows the activity time for a settled run and hides it while running', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    api.listChats.mockResolvedValue([
      {
        ...run1,
        id: 'done',
        title: 'Done chat',
        status: 'completed',
        updatedAt: fiveMinAgo,
      },
      {
        ...run1,
        id: 'live',
        title: 'Live chat',
        status: 'running',
        updatedAt: fiveMinAgo,
      },
    ]);
    const { client } = makeClient();
    const container = await mount(client);

    const rowText = (title: string): string =>
      [...container.querySelectorAll('aside li')].find((el) =>
        el.textContent?.includes(title),
      )!.textContent!;
    expect(rowText('Done chat')).toContain('5m');
    expect(rowText('Live chat')).not.toContain('5m');
  });
});

describe('Chats skill autocomplete', () => {
  const SKILLS = [
    {
      name: 'deploy',
      description: 'Ship the app',
      kind: 'skill' as const,
      source: 'project' as const,
    },
    {
      name: 'review',
      description: null,
      kind: 'command' as const,
      source: 'user' as const,
    },
  ];

  /** Type `value` into the (only) composer textarea through React's setter. */
  async function type(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setValue.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function keydown(textarea: HTMLTextAreaElement, key: string) {
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });
  }

  it('lists the open chat agent\'s skills on "/", filters, and inserts the pick on Enter', async () => {
    api.listSkills.mockResolvedValue(SKILLS);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');
    // The list is fetched for the RUN's agent in the RUN's folder.
    expect(api.listSkills).toHaveBeenCalledWith('claude', '/proj');

    const textarea = container.querySelector('textarea')!;
    await type(textarea, '/');
    const listbox = container.querySelector('[role="listbox"]')!;
    expect(listbox).not.toBeNull();
    expect(listbox.textContent).toContain('/deploy');
    expect(listbox.textContent).toContain('Ship the app');
    expect(listbox.textContent).toContain('/review');

    // Typing narrows the list…
    await type(textarea, '/rev');
    expect(
      container.querySelector('[role="listbox"]')!.textContent,
    ).not.toContain('/deploy');

    // …and Enter inserts the highlighted skill (never sends, never newlines).
    await keydown(textarea, 'Enter');
    expect(textarea.value).toBe('/review ');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('closes on Escape for that query, stays closed for arguments, reopens on edit', async () => {
    api.listSkills.mockResolvedValue(SKILLS);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    const textarea = container.querySelector('textarea')!;
    await type(textarea, '/de');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    await keydown(textarea, 'Escape');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    // Same dismissed query stays closed; editing the token reopens.
    await type(textarea, '/dep');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    // Arguments after the command never show the menu.
    await type(textarea, '/deploy now');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("resolves a workflow target's skills through the selected trigger's downstream agents", async () => {
    api.listSkills.mockResolvedValue([]);
    workflowApi.list.mockResolvedValue([
      {
        slug: 'review-team',
        name: 'Review team',
        description: null,
        nodeCount: 2,
        edgeCount: 1,
        agentCounts: [],
        updatedAt: 'now',
      },
    ]);
    workflowApi.get.mockResolvedValue({
      slug: 'review-team',
      workflow: {
        name: 'Review team',
        nodes: [
          { id: 'start', kind: 'trigger', trigger: 'manual' },
          {
            id: 'coder',
            kind: 'agent',
            agent: 'cursor-agent',
            approval: 'auto',
          },
        ],
        edges: [{ from: 'start', to: 'coder', kind: 'data' }],
      },
    });
    const { client } = makeClient();
    const container = await mount(client);

    const select = container.querySelector('select')!;
    await act(async () => {
      const setSelect = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setSelect.call(select, 'wf:review-team');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // The skills fetched are the TRIGGER's downstream agent's, not the
    // composer's bare-agent default.
    expect(api.listSkills).toHaveBeenCalledWith('cursor-agent', '/proj');
  });
});
