// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../__fixtures__/preload-stub';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import type { WorkflowChatState } from './use-workflow-chat';
import { WorkflowChatPanel } from './workflow-chat-panel';

// The hook has its own spec; what this one is about is the panel's contract
// with the BUILDER — flush before a send, report the turn, count the settles.
const { chat } = vi.hoisted(() => ({
  chat: { current: null as WorkflowChatState | null },
}));
vi.mock('./use-workflow-chat', () => ({
  useWorkflowChat: () => chat.current,
}));

const APIS = {
  agents: {
    listAgentModels: vi.fn(async () => []),
    listAgentEfforts: vi.fn(async () => ({
      efforts: [],
      unavailableReason: null,
    })),
    listAgentContextWindows: vi.fn(async () => ({
      windows: [],
      unavailableReason: null,
      unavailableKind: null,
    })),
    listAgentModelParameters: vi.fn(async () => ({
      parameters: [],
      unavailableReason: null,
    })),
  },
} as unknown as DaemonApis;

function chatState(overrides: Partial<WorkflowChatState>): WorkflowChatState {
  return {
    run: { id: 'run-1', status: 'pending' } as WorkflowChatState['run'],
    items: [],
    loading: false,
    error: null,
    working: false,
    settledTurns: 0,
    send: vi.fn(async () => {}),
    patchSettings: vi.fn(async () => {}),
    respond: vi.fn(),
    cancel: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('WorkflowChatPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onBeforeSend: Mock<() => Promise<void>>;
  let onWorkingChange: Mock<(working: boolean) => void>;
  let onTurnSettled: Mock<() => void>;

  beforeEach(() => {
    stubResizeObserver();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.geniro = createPreloadStub();
    onBeforeSend = vi.fn(async (): Promise<void> => {});
    onWorkingChange = vi.fn<(working: boolean) => void>();
    onTurnSettled = vi.fn<() => void>();
    chat.current = chatState({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function paint(): Promise<void> {
    await act(async () => {
      root.render(
        <WorkflowChatPanel
          slug="dev-team"
          workflowName="Dev Team"
          apis={APIS}
          client={null as unknown as DaemonClient}
          capabilities={null}
          capabilitiesLoading={false}
          recentConfigDirs={[]}
          onClose={vi.fn()}
          onBeforeSend={onBeforeSend}
          onWorkingChange={onWorkingChange}
          onTurnSettled={onTurnSettled}
        />,
      );
    });
  }

  const textarea = (): HTMLTextAreaElement => {
    const field = container.querySelector('textarea');
    if (field === null) {
      throw new Error('no composer field');
    }
    return field;
  };

  const sendButton = (): HTMLButtonElement => {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((candidate) => candidate.textContent?.trim() === 'Send');
    if (button === undefined) {
      throw new Error('no Send control');
    }
    return button;
  };

  async function type(text: string): Promise<void> {
    await act(async () => {
      const field = textarea();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // The agent reads the FILE, so a canvas edit still sitting in the autosave
  // debounce is invisible to the turn about to start — and would then be
  // written over whatever that turn produced.
  it('writes pending canvas edits before the message reaches the daemon', async () => {
    await paint();
    await type('rename the reviewer');

    await act(async () => {
      sendButton().click();
    });

    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    const send = chat.current?.send as ReturnType<typeof vi.fn>;
    expect(send).toHaveBeenCalledWith('rename the reviewer');
    expect(onBeforeSend.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      send.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('sends nothing at all when the box is empty', async () => {
    await paint();

    await act(async () => {
      sendButton().click();
    });

    expect(onBeforeSend).not.toHaveBeenCalled();
    expect(chat.current?.send).not.toHaveBeenCalled();
  });

  it('reports the turn to the builder, so autosave can stand down', async () => {
    await paint();
    expect(onWorkingChange).toHaveBeenLastCalledWith(false);

    chat.current = chatState({ working: true });
    await paint();
    expect(onWorkingChange).toHaveBeenLastCalledWith(true);

    chat.current = chatState({ working: false, settledTurns: 1 });
    await paint();
    expect(onWorkingChange).toHaveBeenLastCalledWith(false);
  });

  // Keyed on the COUNT, so a second turn reloads the canvas a second time —
  // a boolean going false cannot tell one settle from the next.
  it('asks the builder to reload once per settled turn', async () => {
    await paint();
    expect(onTurnSettled).not.toHaveBeenCalled();

    chat.current = chatState({ settledTurns: 1 });
    await paint();
    expect(onTurnSettled).toHaveBeenCalledTimes(1);

    chat.current = chatState({ settledTurns: 2 });
    await paint();
    expect(onTurnSettled).toHaveBeenCalledTimes(2);
  });

  it('does not ask for a reload on a re-render that settled nothing', async () => {
    await paint();
    chat.current = chatState({ settledTurns: 1 });
    await paint();

    chat.current = chatState({ settledTurns: 1, items: [] });
    await paint();

    expect(onTurnSettled).toHaveBeenCalledTimes(1);
  });

  it('offers Stop only while a turn is running', async () => {
    const stop = (): Element | null =>
      container.querySelector('[aria-label="Stop the agent"]');
    await paint();
    expect(stop()).toBeNull();

    chat.current = chatState({ working: true });
    await paint();

    expect(stop()).not.toBeNull();
  });

  it('surfaces the daemon sentence when the chat refuses', async () => {
    chat.current = chatState({ error: 'daemon said no' });

    await paint();

    expect(container.textContent).toContain('daemon said no');
  });
});
