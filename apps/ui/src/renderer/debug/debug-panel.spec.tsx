// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import type { DaemonClient, DebugLogEntry } from '../daemon-client';
import { DebugPanel } from './debug-panel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function entry(seq: number, over: Partial<DebugLogEntry> = {}): DebugLogEntry {
  return {
    seq,
    at: `2026-08-07T12:00:0${seq}.000Z`,
    channel: 'daemon',
    level: 'info',
    message: `line ${seq}`,
    context: null,
    ...over,
  };
}

function makeApis(
  page: Partial<{
    entries: DebugLogEntry[];
    channels: string[];
    filePath: string | null;
    dropped: number;
    lastSeq: number;
  }> = {},
): {
  apis: DaemonApis;
  readDebugLog: ReturnType<typeof vi.fn>;
  setDebugChannels: ReturnType<typeof vi.fn>;
} {
  const readDebugLog = vi.fn().mockResolvedValue({
    entries: page.entries ?? [],
    channels: page.channels ?? ['daemon', 'transcript', 'ui'],
    filePath: page.filePath ?? '/tmp/logs/geniro-daemon-1.jsonl',
    dropped: page.dropped ?? 0,
    lastSeq: page.lastSeq ?? 0,
  });
  const setDebugChannels = vi
    .fn()
    .mockImplementation(
      ({ debugSettingsDto }: { debugSettingsDto: { channels: string[] } }) =>
        Promise.resolve({ channels: debugSettingsDto.channels }),
    );
  return {
    readDebugLog,
    setDebugChannels,
    apis: {
      diagnostics: {
        readDebugLog,
        setDebugChannels,
        buildDiagnosticsReport: vi.fn(),
        recordUiLog: vi.fn(),
      },
    } as unknown as DaemonApis,
  };
}

function makeClient(): {
  client: DaemonClient;
  emit: (entry: DebugLogEntry) => void;
  setDebugStream: ReturnType<typeof vi.fn>;
} {
  let listener: ((entry: DebugLogEntry) => void) | null = null;
  const setDebugStream = vi.fn();
  return {
    setDebugStream,
    emit: (value) => listener?.(value),
    client: {
      setDebugStream,
      onDebugEntry: (fn: (entry: DebugLogEntry) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    } as unknown as DaemonClient,
  };
}

async function mount(apis: DaemonApis, client: DaemonClient): Promise<void> {
  await act(async () => {
    root.render(<DebugPanel apis={apis} client={client} onClose={vi.fn()} />);
  });
}

beforeEach(() => {
  // jsdom has no scrollIntoView; the panel's tail-follow effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
  (
    window as unknown as {
      geniro: { revealPath: unknown; toggleDevTools: unknown };
    }
  ).geniro = {
    revealPath: vi.fn().mockResolvedValue({ revealed: true, reason: null }),
    toggleDevTools: vi.fn().mockResolvedValue(undefined),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DebugPanel', () => {
  it('backfills over REST and then streams live entries', async () => {
    // Both halves matter: a panel opened mid-incident must show what led up to
    // it, not only what happens after someone thought to look.
    const { apis, readDebugLog } = makeApis({
      entries: [entry(1)],
      lastSeq: 1,
    });
    const { client, emit } = makeClient();
    await mount(apis, client);

    expect(readDebugLog).toHaveBeenCalled();
    expect(container.textContent).toContain('line 1');

    await act(async () => emit(entry(2, { message: 'live line' })));
    expect(container.textContent).toContain('live line');
  });

  it('asks the daemon to start streaming, and to stop on unmount', async () => {
    // The daemon only sends the debug room to sockets that asked. Failing to
    // unsubscribe would keep every agent-stdio line flowing to a panel nobody
    // is looking at, for the rest of the session.
    const { apis } = makeApis();
    const { client, setDebugStream } = makeClient();
    await mount(apis, client);

    expect(setDebugStream).toHaveBeenCalledWith(true);

    await act(async () => root.unmount());
    expect(setDebugStream).toHaveBeenLastCalledWith(false);
  });

  it('opens Chrome DevTools from the panel, without closing it', async () => {
    // The two are consulted for the SAME symptom and each holds half the
    // answer, so reaching the browser's inspector must not cost the daemon
    // view that is already on screen.
    const { apis } = makeApis({ entries: [entry(1)], lastSeq: 1 });
    const { client } = makeClient();
    await mount(apis, client);

    const devtools = [...container.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.includes('DevTools'),
    )!;
    await act(async () => devtools.click());

    expect(
      (
        window as unknown as {
          geniro: { toggleDevTools: ReturnType<typeof vi.fn> };
        }
      ).geniro.toggleDevTools,
    ).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('line 1');
  });

  it('holds the list still while paused, and does not buffer', async () => {
    // Pausing is what someone does to READ. Buffering would dump the backlog
    // the instant they resume — deferring the movement rather than stopping it.
    const { apis } = makeApis();
    const { client, emit } = makeClient();
    await mount(apis, client);

    const pause = [...container.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.includes('Pause'),
    )!;
    await act(async () => pause.click());
    await act(async () => emit(entry(9, { message: 'while-paused' })));

    expect(container.textContent).not.toContain('while-paused');
  });

  it('filters on the message, the channel and the context', async () => {
    const { apis } = makeApis({
      entries: [
        entry(1, { message: 'keep me' }),
        entry(2, { message: 'other', channel: 'transcript' }),
        entry(3, { message: 'third', context: { runId: 'abc123' } }),
      ],
      lastSeq: 3,
    });
    const { client } = makeClient();
    await mount(apis, client);

    const filter = container.querySelector('input')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setValue.call(filter, 'abc123');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('third');
    expect(container.textContent).not.toContain('keep me');
  });

  it('toggles a channel through the daemon', async () => {
    const { apis, setDebugChannels } = makeApis({
      channels: ['daemon', 'transcript', 'ui'],
    });
    const { client } = makeClient();
    await mount(apis, client);

    const agentIo = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Agent I/O',
    )!;
    // OFF by default — it is the one channel that records the user's own
    // source, so turning it on is a decision they make.
    expect(agentIo.getAttribute('aria-pressed')).toBe('false');

    await act(async () => agentIo.click());

    expect(setDebugChannels).toHaveBeenCalledWith({
      debugSettingsDto: {
        channels: ['daemon', 'transcript', 'ui', 'agent-stdio'],
      },
    });
  });

  it('says out loud when the daemon dropped entries', async () => {
    // A debug log that quietly loses the lines you were looking for is worse
    // than one that admits it did.
    const { apis } = makeApis({ dropped: 42 });
    const { client } = makeClient();
    await mount(apis, client);

    expect(container.textContent).toContain('42 earlier entries');
    expect(container.textContent).toContain('still in the log file');
  });

  it('clears the VIEW without touching the record', async () => {
    const { apis } = makeApis({ entries: [entry(1)], lastSeq: 1 });
    const { client } = makeClient();
    await mount(apis, client);

    const clear = [...container.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.includes('Clear'),
    )!;
    // The title has to say so: a bare "Clear" reads like it destroys evidence.
    expect(clear.getAttribute('title')).toContain('log file is untouched');

    await act(async () => clear.click());
    expect(container.textContent).not.toContain('line 1');
  });
});
