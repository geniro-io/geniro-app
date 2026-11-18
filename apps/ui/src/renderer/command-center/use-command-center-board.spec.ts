// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import type { CommandCenterChangedEvent, DaemonClient } from '../daemon-client';
import { useCommandCenterBoard } from './use-command-center-board';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FIVE_MINUTES_MS = 5 * 60_000;

const BOARD = {
  cards: [],
  manager: null,
  pendingStarts: 0,
  generatedAt: '2026-11-18T10:00:00.000Z',
};

interface ProbeProps {
  apis: DaemonApis;
  client: DaemonClient;
  active: boolean;
}

function Probe(props: ProbeProps): null {
  useCommandCenterBoard(props.apis, props.client, props.active);
  return null;
}

function fakes() {
  const readCommandCenterBoard = vi.fn((_request: { runIds?: string }) =>
    Promise.resolve(BOARD),
  );
  const listeners: {
    changed: ((event: CommandCenterChangedEvent) => void) | null;
    reconnect: (() => void) | null;
  } = { changed: null, reconnect: null };
  const apis = {
    commandCenter: { readCommandCenterBoard },
  } as unknown as DaemonApis;
  const client = {
    onCommandCenterChanged: (
      listener: (event: CommandCenterChangedEvent) => void,
    ) => {
      listeners.changed = listener;
      return () => undefined;
    },
    onCommandCenterContact: () => () => undefined,
    onReconnect: (listener: () => void) => {
      listeners.reconnect = listener;
      return () => undefined;
    },
  } as unknown as DaemonClient;
  return {
    apis,
    client,
    readCommandCenterBoard,
    announce: (runIds: string[]) =>
      act(async () => {
        listeners.changed?.({ runIds } as CommandCenterChangedEvent);
      }),
    reconnect: () =>
      act(async () => {
        listeners.reconnect?.();
      }),
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(props: ProbeProps): Promise<void> {
  if (root === null) {
    container = document.createElement('div');
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(createElement(Probe, props));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('useCommandCenterBoard', () => {
  it('reads nothing while hidden, and reads the whole board once when shown again', async () => {
    vi.useFakeTimers();
    const { apis, client, readCommandCenterBoard, announce, reconnect } =
      fakes();

    await render({ apis, client, active: false });
    await announce(['run-1']);
    await reconnect();
    await act(async () => {
      vi.advanceTimersByTime(FIVE_MINUTES_MS);
    });
    expect(readCommandCenterBoard).not.toHaveBeenCalled();

    await render({ apis, client, active: true });
    expect(readCommandCenterBoard.mock.calls).toEqual([[{}]]);
  });

  it('reads the whole board again on every return, even when nothing was announced while hidden', async () => {
    const { apis, client, readCommandCenterBoard } = fakes();

    await render({ apis, client, active: true });
    await render({ apis, client, active: false });
    await render({ apis, client, active: true });

    expect(readCommandCenterBoard.mock.calls).toEqual([[{}], [{}]]);
  });

  it('re-reads only the named cards while shown', async () => {
    const { apis, client, readCommandCenterBoard, announce } = fakes();

    await render({ apis, client, active: true });
    expect(readCommandCenterBoard.mock.calls).toEqual([[{}]]);

    await announce(['run-1', 'run-2']);
    expect(readCommandCenterBoard.mock.calls).toEqual([
      [{}],
      [{ runIds: 'run-1,run-2' }],
    ]);
  });
});
