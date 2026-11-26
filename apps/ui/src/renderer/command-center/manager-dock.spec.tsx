// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DaemonHandle,
  DEFAULT_SETTINGS,
  type ManagerConfig,
} from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import type { HostedThread } from '../chats/hosted-thread';
import type { ThreadIdentity } from '../components/thread-head';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { ManagerDock } from './manager-dock';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The chat screen itself is stubbed. Its discard branch is pinned in
// Chats.spec; this stub follows the same contract, so what this spec checks is
// what ManagerDock hands the chat screen: after a discard the surface is told
// when it asked to be, and otherwise the pinned run is opened again.
const { drawn } = vi.hoisted(() => ({
  drawn: { hosted: null as HostedThread | null },
}));
vi.mock('../chats/Chats', async () => {
  const { createElement, Fragment, useEffect } = await import('react');
  return {
    Chats: function ChatsStub({
      hosted,
    }: {
      hosted: HostedThread;
    }): React.JSX.Element {
      drawn.hosted = hosted;
      useEffect(() => {
        void hosted.open();
      }, []);
      const discard = hosted.discard;
      const discardAndTell = async (): Promise<void> => {
        if (discard !== undefined) {
          await discard();
        }
        if (hosted.onDiscarded === undefined) {
          await hosted.open();
        } else {
          hosted.onDiscarded();
        }
      };
      return createElement(
        Fragment,
        null,
        hosted.headerActions?.({
          discard: discard === undefined ? null : () => void discardAndTell(),
        }),
      );
    },
  };
});

const HANDLE = { host: '127.0.0.1', port: 1, token: 't' } as DaemonHandle;
const CLIENT = {} as DaemonClient;
const CHOICE: ManagerConfig = {
  agent: 'claude',
  configDir: null,
  model: 'opus',
  effort: 'high',
  contextWindow: null,
  modelParameters: {},
  approval: null,
  autoCompactPercent: null,
};

const openCommandCenterChat = vi.fn();
const discardCommandCenterChat = vi.fn();
const APIS = {
  commandCenter: { openCommandCenterChat, discardCommandCenterChat },
} as unknown as DaemonApis;

let container: HTMLDivElement;
let root: Root;
let onDiscarded: () => void;

beforeEach(() => {
  stubResizeObserver();
  window.localStorage.clear();
  window.geniro = createPreloadStub({
    getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS }),
  });
  drawn.hosted = null;
  openCommandCenterChat
    .mockReset()
    .mockImplementation(async () => ({ id: 'manager-1', status: 'pending' }));
  discardCommandCenterChat.mockReset().mockResolvedValue(undefined);
  onDiscarded = vi.fn();
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

const IDENTITIES = new Map<string, ThreadIdentity>([
  [
    'run-a',
    {
      title: 'Fix the login redirect',
      project: 'Web',
      projectColor: 'teal' as const,
      agentLabel: 'claude',
      isTeam: false,
      face: { kind: 'unknown' },
      pullRequest: null,
      status: null,
      boardCard: null,
    },
  ],
]);

const REPORTS: ReadonlyMap<string, string> = new Map([['r1', 'Shipped it']]);

async function paint(): Promise<void> {
  await act(async () => {
    root.render(
      <ManagerDock
        apis={APIS}
        handle={HANDLE}
        client={CLIENT}
        choice={CHOICE}
        hidden={false}
        threadIdentities={IDENTITIES}
        threadReports={REPORTS}
        active
        onOpenThread={vi.fn()}
        onTurnSettled={vi.fn()}
        onDiscarded={onDiscarded}
      />,
    );
  });
  await act(async () => undefined);
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) {
    throw new Error('no dialog is open');
  }
  return found;
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) {
    throw new Error(`no button named ${label}`);
  }
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await act(async () => undefined);
}

describe('ManagerDock', () => {
  it('hands the board threads’ identities to the manager’s transcript', async () => {
    await paint();

    expect(drawn.hosted?.threadIdentities).toBe(IDENTITIES);
  });

  it('hands the board threads’ reports to the manager’s transcript and marks it the manager', async () => {
    await paint();

    expect(drawn.hosted?.threadReports).toBe(REPORTS);
    expect(drawn.hosted?.commandCenterManager).toBe(true);
  });

  it('starts a new manager chat from its header, after the confirmation, without re-opening the old one', async () => {
    await paint();
    expect(openCommandCenterChat).toHaveBeenCalledTimes(1);

    await click(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="New chat with the manager"]',
      )!,
    );
    expect(dialog().textContent).toContain('Start a new manager chat?');

    await click(buttonIn(dialog(), 'New chat'));

    expect(discardCommandCenterChat).toHaveBeenCalledTimes(1);
    expect(onDiscarded).toHaveBeenCalledTimes(1);
    expect(openCommandCenterChat).toHaveBeenCalledTimes(1);
  });

  it('keeps the manager when the new chat is cancelled', async () => {
    await paint();

    await click(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="New chat with the manager"]',
      )!,
    );
    await click(buttonIn(dialog(), 'Cancel'));

    expect(discardCommandCenterChat).not.toHaveBeenCalled();
    expect(onDiscarded).not.toHaveBeenCalled();
  });
});
