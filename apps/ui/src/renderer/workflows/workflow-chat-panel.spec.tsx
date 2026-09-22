// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../__fixtures__/preload-stub';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { CHAT_LIVE_KEY } from '../chats/live-text';
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
    liveText: new Map(),
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
          handle={null}
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
    // By its accessible NAME: Send and Stop share one slot in the composer, as
    // they do in the chat screen, so the control is a glyph rather than a word.
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send"]',
    );
    if (button === null) {
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

  it('puts Stop in the COMPOSER, in the Send slot, while a turn runs', async () => {
    // REPORTED as "кнопочка «Стоп» должна быть в текстере, то есть те же самые
    // компоненты, которые у нас есть уже". It was an icon in the panel's own
    // header, which is a second place to stop a turn and a second place for the
    // two to disagree about whether there is one; the chat screen has always
    // kept it in the composer, where the hand already is.
    const stop = (): Element | null =>
      container.querySelector('button[aria-label="Stop"]');
    const header = (): Element | null =>
      container.querySelector('header [aria-label="Stop the agent"]');
    await paint();
    expect(stop()).toBeNull();
    expect(sendButton()).not.toBeNull();

    chat.current = chatState({ working: true });
    await paint();

    const composer = container.querySelector('[data-slot="composer-card"]');
    expect(composer?.contains(stop())).toBe(true);
    expect(header()).toBeNull();
    // ONE slot: while the turn runs there is nothing to send, so Send is not
    // drawn beside it.
    expect(container.querySelector('button[aria-label="Send"]')).toBeNull();
  });

  it('surfaces the daemon sentence when the chat refuses', async () => {
    chat.current = chatState({ error: 'daemon said no' });

    await paint();

    expect(container.textContent).toContain('daemon said no');
  });
});

describe('WorkflowChatPanel — the transcript is the chat screen’s own', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubResizeObserver();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.geniro = createPreloadStub();
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
          handle={null}
          client={null as unknown as DaemonClient}
          capabilities={null}
          capabilitiesLoading={false}
          recentConfigDirs={[]}
          onClose={vi.fn()}
          onBeforeSend={vi.fn(async () => {})}
          onWorkingChange={vi.fn()}
          onTurnSettled={vi.fn()}
        />,
      );
    });
  }

  const row = (
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    role = 'assistant',
  ): WorkflowChatState['items'][number] =>
    ({
      id,
      runId: 'run-1',
      seq: Number(id.replace(/\D/g, '')) || 1,
      kind,
      role,
      nodeId: null,
      payload,
      createdAt: '2026-09-01T00:00:00.000Z',
    }) as WorkflowChatState['items'][number];

  it('FOLDS a turn’s tool calls into one group, as the chat screen does', async () => {
    // It used to map one row per item, so a turn that read three files was
    // three bare rows with nothing to collapse — the panel looked nothing like
    // the surface it is meant to BE. Reusing `groupTranscript` is also what
    // keeps the two honest: a row that looks wrong here looks wrong there.
    chat.current = chatState({
      items: [
        row('i1', 'tool_call', { id: 'c1', name: 'Read', input: { a: 1 } }),
        row('i2', 'tool_result', { id: 'c1', output: 'ok' }),
        row('i3', 'tool_call', { id: 'c2', name: 'Read', input: { a: 2 } }),
        row('i4', 'tool_result', { id: 'c2', output: 'ok' }),
      ],
    });

    await paint();

    // ONE group holding both calls, collapsed behind its own disclosure —
    // which is the whole of what the fold buys and what a row-per-item map
    // could not produce. Unfolded, the two calls would be two loose rows and
    // there would be no `tool-group` element at all.
    const groups = container.querySelectorAll('[data-role="tool-group"]');
    expect(groups).toHaveLength(1);
    expect(
      groups[0]?.querySelector('button')?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(groups[0]?.textContent).toContain('2 tools');
  });

  it('draws the WORKING row while a turn runs — the loading state it had none of', async () => {
    // REPORTED as "сейчас там нет ни иконки загрузки, ничего": a turn could run
    // for minutes with the dock showing the transcript exactly as it was.
    chat.current = chatState({ working: true });

    await paint();

    expect(container.textContent).toContain('Working…');
  });

  it('draws the agent’s words as they STREAM, before any row exists', async () => {
    // The live plane, folded in by `withLiveText` — the same channel and the
    // same reducer the chat screen reads. With `items` empty, nothing but the
    // live text can put this sentence on screen.
    chat.current = chatState({
      working: true,
      liveText: new Map([
        [
          CHAT_LIVE_KEY,
          {
            text: 'Adding the reviewer node',
            thinkingTokens: null,
            thinkingText: null,
            thinkingSince: null,
            thinkingStretch: null,
            composingTool: null,
            composingBytes: null,
            contextTokens: null,
            contextWindowTokens: null,
            spentInputTokens: null,
            spentOutputTokens: null,
            spentCacheReadTokens: null,
          },
        ],
      ]),
    });

    await paint();

    expect(container.textContent).toContain('Adding the reviewer node');
  });
});
