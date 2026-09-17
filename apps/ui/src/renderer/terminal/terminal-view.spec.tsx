// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GeniroApi,
  TerminalDataEvent,
  TerminalExitEvent,
} from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';

const xterm = vi.hoisted(() => ({
  instances: [] as {
    written: string[];
    disposed: boolean;
    options: Record<string, unknown>;
    type: (data: string) => void;
    press: () => void;
    resize: (cols: number, rows: number) => void;
    setSize: (cols: number, rows: number) => void;
  }[],
  fit: vi.fn(),
  undrawn: [] as (() => void)[],
  resizeCallbacks: [] as (() => void)[],
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      xterm.fit();
    }
  },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    private onDataListener: ((data: string) => void) | null = null;
    private onKeyListener: (() => void) | null = null;
    private onResizeListener:
      ((size: { cols: number; rows: number }) => void) | null = null;
    readonly record;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.record = {
        written: [] as string[],
        disposed: false,
        options: this.options,
        type: (data: string) => this.onDataListener?.(data),
        press: () => this.onKeyListener?.(),
        resize: (cols: number, rows: number) =>
          this.onResizeListener?.({ cols, rows }),
        setSize: (cols: number, rows: number) => {
          this.cols = cols;
          this.rows = rows;
        },
      };
      xterm.instances.push(this.record);
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(data: string, drawn?: () => void): void {
      this.record.written.push(data);
      // Held, like xterm's timer-driven parser: a test decides when it draws.
      if (drawn) {
        xterm.undrawn.push(drawn);
      }
    }
    onData(listener: (data: string) => void): { dispose(): void } {
      this.onDataListener = listener;
      return { dispose: () => undefined };
    }
    onKey(listener: () => void): { dispose(): void } {
      this.onKeyListener = listener;
      return { dispose: () => undefined };
    }
    onResize(listener: (size: { cols: number; rows: number }) => void): {
      dispose(): void;
    } {
      this.onResizeListener = listener;
      return { dispose: () => undefined };
    }
    dispose(): void {
      this.record.disposed = true;
    }
  },
}));

const { default: TerminalView } = await import('./terminal-view');
type TerminalEnding = import('./terminal-view').TerminalEnding;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let dataListeners: ((event: TerminalDataEvent) => void)[];
let exitListeners: ((event: TerminalExitEvent) => void)[];
let api: GeniroApi;

/** jsdom measures every box 0×0; this gives them all a size for one call. */
function withBoxSize(width: number, height: number, run: () => void): void {
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
  });
  try {
    run();
  } finally {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
}

beforeEach(() => {
  // Captured rather than stubbed empty: the refit is what a test drives.
  xterm.resizeCallbacks.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        xterm.resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  xterm.instances.length = 0;
  xterm.fit.mockReset();
  xterm.undrawn.length = 0;
  dataListeners = [];
  exitListeners = [];
  api = createPreloadStub({
    terminalCreate: vi.fn(() => Promise.resolve()),
    terminalWrite: vi.fn(() => Promise.resolve()),
    terminalResize: vi.fn(() => Promise.resolve()),
    terminalAck: vi.fn(() => Promise.resolve()),
    terminalKill: vi.fn(() => Promise.resolve()),
    onTerminalData: (listener) => {
      dataListeners.push(listener);
      return () => {
        dataListeners = dataListeners.filter((l) => l !== listener);
      };
    },
    onTerminalExit: (listener) => {
      exitListeners.push(listener);
      return () => {
        exitListeners = exitListeners.filter((l) => l !== listener);
      };
    },
  });
  (window as unknown as { geniro: GeniroApi }).geniro = api;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

async function mount(
  views: {
    cwd: string | null;
    onEnded?: (ending: TerminalEnding) => void;
  }[],
): Promise<string[]> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <>
        {views.map((view, index) => (
          <TerminalView
            key={index}
            cwd={view.cwd}
            shown
            onEnded={view.onEnded ?? (() => undefined)}
          />
        ))}
      </>,
    );
  });
  return vi.mocked(api.terminalCreate).mock.calls.map(([input]) => input.id);
}

function emitData(event: TerminalDataEvent): void {
  act(() => dataListeners.forEach((listener) => listener(event)));
}

function emitExit(event: TerminalExitEvent): void {
  act(() => exitListeners.forEach((listener) => listener(event)));
}

describe('TerminalView', () => {
  it('starts a shell in the tab’s folder, sized to the emulator', async () => {
    await mount([{ cwd: '/work/app' }]);

    expect(api.terminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/work/app', cols: 80, rows: 24 }),
    );
  });

  it('asks for the home folder by naming none', async () => {
    await mount([{ cwd: null }]);

    expect(vi.mocked(api.terminalCreate).mock.calls[0]![0]).not.toHaveProperty(
      'cwd',
    );
  });

  it('routes each shell’s output to its own tab over ONE pair of listeners', async () => {
    const [first, second] = await mount([{ cwd: '/a' }, { cwd: '/b' }]);

    expect(dataListeners).toHaveLength(1);
    expect(exitListeners).toHaveLength(1);
    emitData({ id: second!, data: 'from b' });
    emitData({ id: first!, data: 'from a' });
    emitData({ id: crypto.randomUUID(), data: 'someone else' });

    expect(xterm.instances.map((term) => term.written)).toEqual([
      ['from a'],
      ['from b'],
    ]);
  });

  it('sends keystrokes to its own shell', async () => {
    const [id] = await mount([{ cwd: '/work/app' }]);

    xterm.instances[0]!.type('ls\r');

    expect(api.terminalWrite).toHaveBeenCalledWith(id, 'ls\r');
  });

  it('says so in the terminal when a keystroke could not be sent', async () => {
    await mount([{ cwd: '/work/app' }]);
    vi.mocked(api.terminalWrite).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'geniro:terminalWrite': Error: too big",
      ),
    );

    await act(async () => xterm.instances[0]!.type('x'));

    expect(xterm.instances[0]!.written.join('')).toContain(
      '[input was not sent: too big]',
    );
  });

  it('forwards a new size, clamped to what main accepts', async () => {
    const [id] = await mount([{ cwd: '/work/app' }]);
    vi.mocked(api.terminalResize).mockClear();

    act(() => xterm.instances[0]!.resize(4000, 900));

    expect(api.terminalResize).toHaveBeenCalledWith(id, 1000, 500);
  });

  it('starts a shell at the cap when the window fits more columns', async () => {
    // The fit runs synchronously in the effect, before create reads the size.
    xterm.fit.mockImplementation(() =>
      xterm.instances.at(-1)!.setSize(1400, 60),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    withBoxSize(10_000, 800, () => {
      act(() => {
        root!.render(
          <TerminalView cwd="/work/app" shown onEnded={() => undefined} />,
        );
      });
    });

    expect(api.terminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 1000, rows: 60 }),
    );
  });

  it('never fits to a hidden 0×0 box, and fits once the box has a size', async () => {
    await mount([{ cwd: '/work/app' }]);
    xterm.resizeCallbacks.forEach((callback) => callback());
    expect(xterm.fit).not.toHaveBeenCalled();

    withBoxSize(600, 200, () =>
      xterm.resizeCallbacks.forEach((callback) => callback()),
    );

    expect(xterm.fit).toHaveBeenCalledOnce();
  });

  it('repaints its colours when the theme changes', async () => {
    await mount([{ cwd: '/work/app' }]);
    const before = xterm.instances[0]!.options.theme;

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      // MutationObserver delivers on a microtask.
      await Promise.resolve();
    });

    expect(xterm.instances[0]!.options.theme).not.toBe(before);
  });

  it('hangs its shell up when the tab goes away', async () => {
    const [id] = await mount([{ cwd: '/work/app' }]);

    act(() => root!.unmount());
    root = null;

    expect(api.terminalKill).toHaveBeenCalledWith(id);
    expect(xterm.instances[0]!.disposed).toBe(true);
    expect(dataListeners).toHaveLength(0);
  });

  it('reports the exit, stops typing into the dead shell and does not kill it again', async () => {
    const onEnded = vi.fn();
    const [id] = await mount([{ cwd: '/work/app', onEnded }]);

    emitExit({ id: id!, exitCode: 2, signal: null });
    xterm.instances[0]!.type('x');
    act(() => root!.unmount());
    root = null;

    expect(onEnded).toHaveBeenCalledWith({
      kind: 'exited',
      exitCode: 2,
      signal: null,
      used: false,
    });
    expect(xterm.instances[0]!.written.join('')).toContain(
      'exited with code 2',
    );
    expect(api.terminalWrite).not.toHaveBeenCalled();
    expect(api.terminalKill).not.toHaveBeenCalled();
  });

  it('names the signal that killed the shell', async () => {
    const onEnded = vi.fn();
    const [id] = await mount([{ cwd: '/work/app', onEnded }]);

    emitExit({ id: id!, exitCode: 0, signal: 9 });

    expect(onEnded).toHaveBeenCalledWith({
      kind: 'exited',
      exitCode: 0,
      signal: 9,
      used: false,
    });
    expect(xterm.instances[0]!.written.join('')).toContain(
      'killed by signal 9',
    );
  });

  it('says why a shell could not start, without the IPC wrapper, and kills nothing', async () => {
    vi.mocked(api.terminalCreate).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'geniro:terminalCreate': Error: the folder no longer exists: /gone",
      ),
    );
    const onEnded = vi.fn();

    await mount([{ cwd: '/gone', onEnded }]);
    act(() => root!.unmount());
    root = null;

    expect(xterm.instances[0]!.written).toEqual([
      'Could not start a shell: the folder no longer exists: /gone\r\n',
    ]);
    expect(onEnded).toHaveBeenCalledWith({ kind: 'failed-to-start' });
    expect(api.terminalKill).not.toHaveBeenCalled();
  });

  it('starts a fresh shell when StrictMode runs the effect twice, hanging up only the first', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <StrictMode>
          <TerminalView cwd="/work/app" shown onEnded={() => undefined} />
        </StrictMode>,
      );
    });

    const ids = vi
      .mocked(api.terminalCreate)
      .mock.calls.map(([input]) => input.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(vi.mocked(api.terminalKill).mock.calls).toEqual([[ids[0]]]);
  });

  it('resends the size once the shell exists, since a resize before that reaches no shell', async () => {
    let started: () => void = () => undefined;
    vi.mocked(api.terminalCreate).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          started = resolve;
        }),
    );
    const [id] = await mount([{ cwd: '/work/app' }]);
    xterm.instances[0]!.setSize(120, 40);
    vi.mocked(api.terminalResize).mockClear();

    await act(async () => started());

    expect(api.terminalResize).toHaveBeenLastCalledWith(id, 120, 40);
  });

  it('reports a shell as used only once a key was pressed or text pasted', async () => {
    const onEnded = vi.fn();
    const [first, second, third] = await mount([
      { cwd: '/a', onEnded },
      { cwd: '/b', onEnded },
      { cwd: '/c', onEnded },
    ]);
    // The terminal's own reply to a prompt's query arrives as data, not a press.
    xterm.instances[0]!.type('\u001b[1;1R');
    xterm.instances[1]!.press();
    const hosts = document.querySelectorAll<HTMLElement>('div.flex-1 > div');
    hosts[2]!.dispatchEvent(new Event('paste', { bubbles: true }));

    emitExit({ id: first!, exitCode: 1, signal: null });
    emitExit({ id: second!, exitCode: 1, signal: null });
    emitExit({ id: third!, exitCode: 1, signal: null });

    expect(
      onEnded.mock.calls.map(([ending]) => (ending as { used: boolean }).used),
    ).toEqual([false, true, true]);
  });

  it('acknowledges output once drawn, not once received', async () => {
    const [id] = await mount([{ cwd: '/work/app' }]);

    emitData({ id: id!, data: 'twelve chars' });
    expect(api.terminalAck).not.toHaveBeenCalled();

    xterm.undrawn.splice(0).forEach((draw) => draw());
    expect(vi.mocked(api.terminalAck).mock.calls).toEqual([[id, 12]]);
  });

  it('acknowledges nothing drawn after the shell ended', async () => {
    const [id] = await mount([{ cwd: '/work/app' }]);

    emitData({ id: id!, data: 'twelve chars' });
    emitExit({ id: id!, exitCode: 0, signal: null });
    xterm.undrawn.splice(0).forEach((draw) => draw());

    expect(api.terminalAck).not.toHaveBeenCalled();
  });

  it('acknowledges on receipt while hidden, and once for output still undrawn when it hides', async () => {
    const [id] = await mount([{ cwd: '/work/app' }]);
    emitData({ id: id!, data: 'before' });
    const state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      emitData({ id: id!, data: 'hidden' });
      // Drawing later must not acknowledge the same output a second time.
      xterm.undrawn.splice(0).forEach((draw) => draw());
    } finally {
      delete (document as { visibilityState?: DocumentVisibilityState })
        .visibilityState;
    }

    expect(vi.mocked(api.terminalAck).mock.calls).toEqual([
      [id, 6],
      [id, 6],
    ]);
  });
});
