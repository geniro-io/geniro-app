// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle, TerminalSession } from '../../shared/contracts';
import { TerminalPanel } from './terminal-panel';

const mocks = vi.hoisted(() => {
  const term = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    reset: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    cols: 80,
    rows: 24,
  };
  interface ClientEvents {
    onSnapshot?: (s: string, status: string, code: number | null) => void;
    onData?: (d: string) => void;
    onExit?: (code: number | null) => void;
    onGone?: () => void;
  }
  const clients: {
    terminalId: string;
    events: ClientEvents;
    connect: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  class FakeTerminalClient {
    connect = vi.fn();
    input = vi.fn();
    resize = vi.fn();
    close = vi.fn();
    constructor(
      _handle: unknown,
      public readonly terminalId: string,
      public readonly events: ClientEvents,
    ) {
      clients.push(this);
    }
  }
  return { term, clients, FakeTerminalClient };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: function Terminal() {
    return mocks.term;
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function FitAddon() {
    return { fit: () => {} };
  },
}));
vi.mock('../terminal-client', () => ({
  TerminalClient: mocks.FakeTerminalClient,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  FakeResizeObserver;

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 8123,
  token: 'tok',
  version: '1',
};

const session: TerminalSession = {
  id: 't-1',
  runId: 'run-1',
  nodeId: null,
  resumeSessionId: null,
  cwd: '/tmp',
  status: 'running',
  exitCode: null,
  createdAt: 0,
};

let container: HTMLDivElement;
let root: Root;

function render(onClose = vi.fn()) {
  act(() => {
    root.render(
      <TerminalPanel
        handle={handle}
        session={session}
        title="claude · demo"
        onClose={onClose}
      />,
    );
  });
  return { onClose };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.clients.length = 0;
  mocks.term.write.mockClear();
  mocks.term.reset.mockClear();
  mocks.term.dispose.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TerminalPanel', () => {
  it('connects a client for the session and replays the snapshot into xterm', () => {
    render();

    const client = mocks.clients[0];
    expect(client?.terminalId).toBe('t-1');
    expect(client?.connect).toHaveBeenCalled();

    act(() => client?.events.onSnapshot?.('history', 'running', null));
    expect(mocks.term.reset).toHaveBeenCalled();
    expect(mocks.term.write).toHaveBeenCalledWith('history');
    expect(client?.resize).toHaveBeenCalledWith(80, 24);
  });

  it('shows a connecting state until the attach delivers its first payload', () => {
    render();

    expect(container.textContent).toContain('Connecting…');
    expect(container.textContent).toContain('connecting');
    expect(container.textContent).not.toContain('live');

    const client = mocks.clients[0];
    act(() => client?.events.onSnapshot?.('history', 'running', null));

    expect(container.textContent).not.toContain('Connecting…');
    expect(container.textContent).toContain('live');
  });

  it('writes live data and flips the badge on exit', () => {
    render();
    const client = mocks.clients[0];

    act(() => client?.events.onData?.('live'));
    expect(mocks.term.write).toHaveBeenCalledWith('live');
    expect(container.textContent).toContain('live');

    act(() => client?.events.onExit?.(0));
    expect(container.textContent).toContain('exited (0)');
  });

  it('shows the live badge when a fresh running session replaces an exited one', () => {
    render();
    const first = mocks.clients[0];
    act(() => first?.events.onExit?.(1));
    expect(container.textContent).toContain('exited (1)');

    // Chats swaps the session prop in place (same element position, no key):
    // the user re-opens a terminal after the previous TUI exited. The panel
    // already supports the swap without a remount (its effect re-runs on
    // session.id and connects a new client), so the status badge must reflect
    // the NEW session, not the exit of the old one.
    act(() => {
      root.render(
        <TerminalPanel
          handle={handle}
          session={{ ...session, id: 't-2' }}
          title="claude · demo"
          onClose={vi.fn()}
        />,
      );
    });
    const second = mocks.clients[1];
    expect(second?.terminalId).toBe('t-2');
    act(() => second?.events.onSnapshot?.('', 'running', null));

    expect(container.textContent).not.toContain('exited');
    expect(container.textContent).toContain('live');
  });

  it('shows the gone badge when the attach targets a reaped session', () => {
    render();
    const client = mocks.clients[0];

    act(() => client?.events.onGone?.());

    expect(container.textContent).toContain('gone');
    expect(container.textContent).not.toContain('live');
  });

  it('detaches the client and disposes xterm on unmount', () => {
    render();
    const client = mocks.clients[0];

    act(() => root.unmount());

    expect(client?.close).toHaveBeenCalled();
    expect(mocks.term.dispose).toHaveBeenCalled();
  });

  it('closes via the standard ✕ icon — and offers NO End session control', () => {
    const { onClose } = render();

    // The one header action: the standard icon close (no text label).
    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close terminal"]',
    )!;
    expect(close.textContent).toBe('');
    expect(close.querySelector('svg')).not.toBeNull();
    // Ending a session happens inside the TUI, never from the popup chrome.
    expect(container.textContent).not.toContain('End session');

    act(() => {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('is a modal popup: a backdrop click detaches, a click inside does not', () => {
    const { onClose } = render();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      container
        .querySelector('header')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      container
        .querySelector('[data-testid="terminal-backdrop"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
