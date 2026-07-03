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
