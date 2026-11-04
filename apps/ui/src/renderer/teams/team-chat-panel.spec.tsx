// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import type { HostedThread } from '../chats/hosted-thread';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { TeamChatPanel } from './team-chat-panel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The chat screen draws the conversation and has its own spec for what it does
// with a hosted thread; this one is about what the DOCK hands it.
const { drawn } = vi.hoisted(() => ({
  drawn: {
    hosted: null as HostedThread | null,
    active: null as boolean | null,
    mounts: 0,
  },
}));
vi.mock('../chats/Chats', async () => {
  const { createElement, Fragment, useEffect } = await import('react');
  return {
    Chats: function ChatsStub({
      hosted,
      active,
    }: {
      hosted: HostedThread;
      active?: boolean;
    }): React.JSX.Element {
      drawn.hosted = hosted;
      drawn.active = active ?? true;
      useEffect(() => {
        drawn.mounts += 1;
      }, []);
      const discard = hosted.discard;
      return createElement(
        Fragment,
        null,
        hosted.headerActions?.({
          discard: discard === undefined ? null : () => void discard(),
        }),
      );
    },
  };
});

const HANDLE = { host: '127.0.0.1', port: 1, token: 't' } as DaemonHandle;
const CLIENT = {} as DaemonClient;

const openTeamChat = vi.fn();
const discardTeamChat = vi.fn();
const APIS = {
  teams: { openTeamChat, discardTeamChat },
} as unknown as DaemonApis;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubResizeObserver();
  window.localStorage.clear();
  window.geniro = createPreloadStub();
  drawn.hosted = null;
  drawn.active = null;
  drawn.mounts = 0;
  openTeamChat
    .mockReset()
    .mockImplementation(async () => ({ id: 'run-1', status: 'pending' }));
  discardTeamChat.mockReset().mockImplementation(async () => ({ deleted: 1 }));
  host.onClose.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

const host = {
  onBeforeSend: vi.fn(async () => true),
  onWorkingChange: vi.fn(),
  onAwaitingChange: vi.fn(),
  onTurnSettled: vi.fn(),
  onClose: vi.fn(),
};

async function paint(
  props: Partial<Parameters<typeof TeamChatPanel>[0]> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <TeamChatPanel
        slug="dev-team"
        teamName="Dev Team"
        apis={APIS}
        handle={HANDLE}
        client={CLIENT}
        {...host}
        {...props}
      />,
    );
  });
}

function thread(): HostedThread {
  if (drawn.hosted === null) {
    throw new Error('the dock drew no chat');
  }
  return drawn.hosted;
}

async function press(label: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  );
  if (button === null) {
    throw new Error(`no control ${label}`);
  }
  await act(async () => {
    button.click();
  });
}

describe('TeamChatPanel', () => {
  // `acceptEdits`: the chat's saves are the edits it was asked to make, and
  // `ask` would put a card in front of every one of them.
  it('opens the team’s chat on the agent picked for it, approving its own edits, with the user’s run settings', async () => {
    window.geniro = createPreloadStub({
      getSettings: vi.fn().mockResolvedValue({
        customInstructions: 'Prefer small diffs.',
        replyLanguage: 'Russian',
      }),
    });
    await paint({ initialAgent: 'codex' });

    await act(async () => {
      await thread().open();
    });

    expect(openTeamChat).toHaveBeenCalledWith({
      slug: 'dev-team',
      startTeamChatDto: {
        agentKind: 'codex',
        approval: 'acceptEdits',
        customInstructions: 'Prefer small diffs.',
        replyLanguage: 'Russian',
      },
    });
  });

  it('starts a team chat on the first agent when none was picked', async () => {
    await paint();

    await act(async () => {
      await thread().open();
    });

    expect(openTeamChat.mock.calls[0]![0].startTeamChatDto.agentKind).toBe(
      'claude',
    );
  });

  it('throws the conversation away from its trash control', async () => {
    await paint();

    await press('Start a new conversation');

    expect(discardTeamChat).toHaveBeenCalledWith({ slug: 'dev-team' });
  });

  it('hides from its own control, and stays mounted while hidden', async () => {
    await paint();

    await press('Hide the team chat panel');
    expect(host.onClose).toHaveBeenCalledTimes(1);

    await paint({ hidden: true });

    const dock = container.querySelector(
      '[aria-label="Change Dev Team with chat"]',
    );
    expect(dock?.hasAttribute('hidden')).toBe(true);
    expect(drawn.mounts).toBe(1);
    expect(drawn.active).toBe(false);
  });

  // The builder's whole contract with the conversation: flush before a send,
  // pause autosave while a turn runs, mark its toggle while the agent waits,
  // re-read the team after a turn.
  it('hands the builder’s reports through to the chat screen', async () => {
    await paint({ initialDraft: 'Add a QA member' });

    expect(thread().onBeforeSend).toBe(host.onBeforeSend);
    expect(thread().onWorkingChange).toBe(host.onWorkingChange);
    expect(thread().onAwaitingChange).toBe(host.onAwaitingChange);
    expect(thread().onTurnSettled).toBe(host.onTurnSettled);
    expect(thread().initialDraft).toBe('Add a QA member');
    expect(thread().composerLabel).toBe('Ask for a team change');
    expect(thread().queueScope).toBe('team-chat:dev-team');
  });
});
