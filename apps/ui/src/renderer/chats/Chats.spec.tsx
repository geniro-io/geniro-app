// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatItem, ChatRun, GeniroApi } from '../../shared/contracts';
import type { DaemonClient } from '../daemon-client';
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
  TerminalPanel: (props: {
    title: string;
    onClose: () => void;
    onEndSession: () => void;
  }) => (
    <div data-testid="terminal-panel">
      {props.title}
      <button onClick={props.onEndSession}>stub-end-session</button>
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

const run1: ChatRun = {
  id: 'r1',
  status: 'running',
  title: 'My chat',
  agentKind: 'claude',
  workflowId: null,
  cwd: '/proj',
  model: null,
  createdAt: 'now',
};

// A fake DaemonClient whose item/reconnect listeners the test can fire.
function makeClient(): {
  client: DaemonClient;
  emitItem: (item: ChatItem) => void;
  fireReconnect: () => void;
} {
  let itemListener: ((item: ChatItem) => void) | null = null;
  let reconnectListener: (() => void) | null = null;
  const client = {
    onItem: (l: (item: ChatItem) => void) => {
      itemListener = l;
      return () => {
        itemListener = null;
      };
    },
    onReconnect: (l: () => void) => {
      reconnectListener = l;
      return () => {
        reconnectListener = null;
      };
    },
    onVerdictAck: () => () => {},
    joinRun: vi.fn(),
    leaveRun: vi.fn(),
    sendVerdict: vi.fn(),
  } as unknown as DaemonClient;
  return {
    client,
    emitItem: (item) => itemListener?.(item),
    fireReconnect: () => reconnectListener?.(),
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
  await act(async () => {
    li?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  // jsdom has no scrollIntoView; the transcript auto-scroll effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { geniro: Partial<GeniroApi> }).geniro = {
    getSettings: vi.fn().mockResolvedValue({
      onboardingComplete: true,
      projectFolder: '/proj',
      defaultModel: null,
      cliPaths: {},
      checkForUpdates: true,
    }),
  };
  api.listChats.mockReset().mockResolvedValue([run1]);
  api.getHistory.mockReset().mockResolvedValue([]);
  api.sendMessage.mockReset();
  api.cancel.mockReset().mockResolvedValue({ cancelled: true });
  api.createChat.mockReset();
  workflowApi.list.mockReset().mockResolvedValue([]);
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
    const { client, fireReconnect } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(
      1,
    );

    await act(async () => {
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

  it('shows the working state (Stop) when activating an in-flight run', async () => {
    // Run is `running` and the transcript does not end on a terminal item, so the
    // composer must reflect the in-flight turn rather than offer an enabled Send.
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi')]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    const buttons = [...container.querySelectorAll('button')].map(
      (b) => b.textContent,
    );
    expect(buttons).toContain('Stop');
    expect(buttons).not.toContain('Send');
  });

  it('does not show the working state when an in-flight run already ended on a terminal item', async () => {
    // status 'running' but the replayed transcript ends on a terminal item → the
    // derive must NOT re-arm Stop.
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi'), terminal(1)]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    const buttons = [...container.querySelectorAll('button')].map(
      (b) => b.textContent,
    );
    expect(buttons).toContain('Send');
    expect(buttons).not.toContain('Stop');
  });

  it('clears the stuck working state when Stop finds nothing in flight (cancelled:false)', async () => {
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi')]); // in-flight → Stop shows
    api.cancel.mockResolvedValue({ cancelled: false });
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');
    expect(
      [...container.querySelectorAll('button')].map((b) => b.textContent),
    ).toContain('Stop');

    const stop = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Stop',
    );
    await act(async () => {
      stop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // cancel reported nothing was in flight → the composer returns to Send.
    const buttons = [...container.querySelectorAll('button')].map(
      (b) => b.textContent,
    );
    expect(buttons).toContain('Send');
    expect(buttons).not.toContain('Stop');
  });

  it('activates a run via Enter keyboard activation of the list row', async () => {
    api.getHistory.mockResolvedValue([msg(0, 'user', 'hi')]);
    const { client } = makeClient();
    const container = await mount(client);
    const li = [...container.querySelectorAll('li')].find((el) =>
      el.textContent?.includes('My chat'),
    );
    await act(async () => {
      li?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    const active = [...container.querySelectorAll('li')].find(
      (el) => el.getAttribute('aria-current') === 'true',
    );
    expect(active?.textContent).toContain('My chat');
    expect(container.textContent).toContain('hi');
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

    expect(container.textContent).toContain('Stop');

    // A node's own turn_complete must NOT re-enable the composer…
    await act(async () => {
      emitItem(wfItem(5, 'turn_complete', 'coder'));
    });
    expect(container.textContent).toContain('Stop');

    // …only the run-level terminal item does.
    await act(async () => {
      emitItem(wfItem(6, 'turn_complete', null));
    });
    expect(container.textContent).not.toContain('Stop');
  });

  it('starts a NEW workflow run on Send even while a chat run is open (never routes into the chat)', async () => {
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
    const sendButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Send',
    )!;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(workflowApi.run).toHaveBeenCalledWith('review-team', {
      cwd: '/proj',
      prompt: 'build it',
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
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
    const sendButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Send',
    )!;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(workflowApi.run).toHaveBeenCalled();
    expect(container.textContent).not.toContain('Stop');
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

  it('routes Stop on a workflow run to the workflow cancel endpoint', async () => {
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'Review team');

    const stop = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Stop',
    )!;
    await act(async () => {
      stop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
    cwd: '/proj',
    status: 'running',
    exitCode: null,
    createdAt: 0,
  };

  it('opens a terminal panel for a claude chat run', async () => {
    terminalApi.create.mockResolvedValue(session);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');

    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Terminal'),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

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
    };
    workflowApi.listRuns.mockResolvedValue([wfRun]);
    api.getHistory.mockResolvedValue([
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

    const nodeButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'agent-1',
    );
    expect(nodeButton).toBeTruthy();
    await act(async () => {
      nodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(terminalApi.create).toHaveBeenCalledWith({
      runId: 'w1',
      nodeId: 'agent-1',
    });
    expect(
      container.querySelector('[data-testid="terminal-panel"]')?.textContent,
    ).toContain('agent-1 — terminal');
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
    const open = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Terminal'),
    );
    await act(async () => {
      open?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
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

    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Terminal'),
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(terminalApi.create).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeTruthy();
  });

  it('End session disposes the PTY and closes the panel; Close only detaches', async () => {
    terminalApi.create.mockResolvedValue(session);
    const { client } = makeClient();
    const container = await mount(client);
    await clickRun(container, 'My chat');
    const open = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Terminal'),
    );
    await act(async () => {
      open?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const end = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'stub-end-session',
    );
    await act(async () => {
      end?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(terminalApi.dispose).toHaveBeenCalledWith('t-1');
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeNull();

    // Re-open, then Close: the panel goes away but the session is NOT disposed.
    terminalApi.dispose.mockClear();
    await act(async () => {
      open?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
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

    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Terminal'),
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('TERMINAL_UNSUPPORTED');
    expect(
      container.querySelector('[data-testid="terminal-panel"]'),
    ).toBeNull();
  });
});

describe('Chats defaults', () => {
  it('applies the settings default model to a new chat', async () => {
    (window as unknown as { geniro: Partial<GeniroApi> }).geniro.getSettings =
      vi.fn().mockResolvedValue({
        onboardingComplete: true,
        projectFolder: '/proj',
        defaultModel: 'claude-sonnet-5',
        cliPaths: {},
        checkForUpdates: true,
      });
    api.createChat.mockResolvedValue({ ...run1, id: 'r-new' });
    const { client } = makeClient();
    const container = await mount(client);

    const newChat = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'New chat',
    );
    await act(async () => {
      newChat?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(api.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-5' }),
    );
  });
});
