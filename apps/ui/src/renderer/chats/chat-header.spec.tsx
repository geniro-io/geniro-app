// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatHeader } from './chat-header';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const baseProps = {
  label: 'Review team',
  isWorkflow: true,
  status: 'running' as const,
  lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
  sidePanelOpen: false,
  onToggleSidePanel: vi.fn(),
};

describe('ChatHeader', () => {
  it('shows the sidebar identity — label + status — and hides the date while running', () => {
    const el = render(<ChatHeader {...baseProps} />);
    expect(el.querySelector('h2')?.textContent).toBe('Review team');
    expect(el.textContent).toContain('running');
    expect(el.querySelector('svg.animate-spin')).not.toBeNull();
    expect(el.textContent).not.toContain('1m');
    // The working directory moved to the composer's folder chip — the header
    // carries no cwd line anymore.
    expect(el.textContent).not.toContain('/proj');
  });

  it('shows the activity time once settled', () => {
    const el = render(<ChatHeader {...baseProps} status="completed" />);
    expect(el.textContent).toContain('1m');
    expect(el.querySelector('svg.animate-spin')).toBeNull();
  });

  it('offers ONE generic side-panel toggle — no per-agent chips in the header', () => {
    const onToggleSidePanel = vi.fn();
    const el = render(
      <ChatHeader {...baseProps} onToggleSidePanel={onToggleSidePanel} />,
    );
    // The old agent chips must stay gone — the panel is the agents surface.
    expect(el.querySelector('button[aria-label^="Agent "]')).toBeNull();
    const toggle = el.querySelector('button[aria-label="Open side panel"]')!;
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onToggleSidePanel).toHaveBeenCalledOnce();
  });

  it('labels the toggle as closing while the panel is open', () => {
    const el = render(<ChatHeader {...baseProps} sidePanelOpen />);
    expect(
      el.querySelector('button[aria-label="Close side panel"]'),
    ).not.toBeNull();
    expect(el.querySelector('button[aria-label="Open side panel"]')).toBeNull();
  });
});

describe('ChatHeader — how long this turn has been running', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts up from the turn’s own start, ticking every second', () => {
    // While running, "when did it last do something" reads "just now" for the
    // whole turn and answers nothing; "how long has this been going" is the
    // question actually being asked.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:40Z'));
    const el = render(
      <ChatHeader
        {...baseProps}
        turnStartedAt="2026-08-04T00:00:00.000Z"
        lastActivityAt="2026-08-04T00:00:39.000Z"
      />,
    );

    expect(el.textContent).toContain('40s');

    act(() => {
      // Advancing the fake timers moves the mocked clock with them, which is
      // what makes this a test of the ticking rather than of the first render.
      vi.advanceTimersByTime(25_000);
    });
    // Real seconds, not a value frozen at render: an elapsed number passed in
    // from above would still read 40s here.
    expect(el.textContent).toContain('1m 5s');
  });

  it('measures from the TRANSCRIPT, so a reload mid-turn does not restart it', () => {
    // A clock started at mount would report a four-minute turn as brand new
    // every time the window reopened.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:04:00Z'));
    const el = render(
      <ChatHeader {...baseProps} turnStartedAt="2026-08-04T00:00:00.000Z" />,
    );

    expect(el.textContent).toContain('4m 0s');
  });

  it('shows no clock when nothing has started a turn', () => {
    const el = render(<ChatHeader {...baseProps} turnStartedAt={null} />);

    expect(el.textContent).toContain('running');
    expect(el.textContent).not.toMatch(/\d+s/);
  });

  it('names the config directory this run belongs to, leaf on the chip and path on hover', () => {
    // A run on a second profile is a different ACCOUNT with different tools —
    // the one fact about a conversation that is invisible everywhere else.
    const el = render(
      <ChatHeader
        {...baseProps}
        configDir="/Users/me/Desktop/Projects/Lab/.claude-lab"
      />,
    );

    expect(el.textContent).toContain('.claude-lab');
    // The full path is one hover away — the header is an identity line, not a
    // place to read a deep path.
    expect(
      el.querySelector('[title*="/Users/me/Desktop/Projects/Lab/.claude-lab"]'),
    ).not.toBeNull();
  });

  it('shows NO config chip for a run on the CLI’s own profile', () => {
    // The default is not news. A chip on every ordinary chat would be a line of
    // noise stating what is already true everywhere.
    const el = render(<ChatHeader {...baseProps} configDir={null} />);

    expect(el.querySelector('[title*="config directory"]')).toBeNull();
  });
});

describe('ChatHeader — how long this thread WORKED', () => {
  it('states the worked total beside the relative time, not instead of it', () => {
    // The two answer different questions, and it was the second that had no
    // answer anywhere once a turn had settled: `3h` says when this last spoke,
    // `worked 4m 12s` says how much work is in it.
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={252_000}
        turnCount={6}
      />,
    );

    expect(el.textContent).toContain('worked 4m 12s');
    expect(el.textContent).toContain('/ 6 turns');
    // The relative time is still there — this is an addition, not a swap.
    expect(el.textContent).toContain('1m');
  });

  it('renders nothing for a thread that has not worked yet', () => {
    // `worked 0s` on a brand-new chat would be a claim about work that has not
    // been asked for. Absent is the honest state.
    const el = render(
      <ChatHeader {...baseProps} status="completed" workedMs={0} />,
    );

    expect(el.querySelector('[data-slot="thread-worked"]')).toBeNull();
    expect(el.textContent).not.toContain('worked');
  });

  it('drops the turn count for a single-turn thread', () => {
    // `/ 1 turns` is wrong and `/ 1 turn` is noise — the figure IS that turn.
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={7618}
        turnCount={1}
      />,
    );

    expect(el.textContent).toContain('worked 7.6s');
    expect(el.textContent).not.toContain('turns');
  });
});

describe('ChatHeader — the worked total while a turn is in flight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps counting, second by second, instead of standing still', () => {
    // The reported defect: a header reading `running · 18s · worked 64m 34s`
    // where the 64m had not moved for the whole turn.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:01:00Z'));
    const el = render(
      <ChatHeader
        {...baseProps}
        workedMs={600_000}
        turnCount={5}
        turnStartedAt="2026-08-04T00:00:00.000Z"
        openTurn={{
          startedAt: Date.parse('2026-08-04T00:00:00.000Z'),
          parkedMs: 0,
          openSince: [],
        }}
      />,
    );

    // 10m settled + 1m of the turn in flight.
    expect(el.textContent).toContain('worked 11m 0s');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(el.textContent).toContain('worked 11m 30s');
  });

  it('counts the turn in flight in the tally its time is part of', () => {
    // A sum over six turns labelled "5 turns" is the kind of small lie a reader
    // has no way to catch.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:01:00Z'));
    const el = render(
      <ChatHeader
        {...baseProps}
        workedMs={600_000}
        turnCount={5}
        openTurn={{
          startedAt: Date.parse('2026-08-04T00:00:00.000Z'),
          parkedMs: 0,
          openSince: [],
        }}
      />,
    );

    expect(el.textContent).toContain('/ 6 turns');
  });

  it('freezes while the turn waits on the user, and never resumes late', () => {
    // The elapsed clock beside it keeps running — that one IS the wall clock.
    // This one claims WORK, and nothing is working while a card sits open.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:01:00Z'));
    const el = render(
      <ChatHeader
        {...baseProps}
        status="needs-input"
        workedMs={600_000}
        turnCount={5}
        openTurn={{
          startedAt: Date.parse('2026-08-04T00:00:00.000Z'),
          parkedMs: 0,
          openSince: [Date.parse('2026-08-04T00:00:20.000Z')],
        }}
      />,
    );

    // 10m settled + the 20s worked before the card opened.
    expect(el.textContent).toContain('worked 10m 20s');

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(el.textContent).toContain('worked 10m 20s');
  });

  it('stands still once the run has no turn in flight', () => {
    // The settled reading is the sum and nothing else — this pins that the
    // ticking is driven by the open turn, not by the component being mounted.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:01:00Z'));
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={600_000}
        turnCount={5}
        openTurn={null}
      />,
    );

    expect(el.textContent).toContain('worked 10m 0s');
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(el.textContent).toContain('worked 10m 0s');
  });

  it('shows a live figure for a first turn that has settled nothing yet', () => {
    // `workedMs` is 0 for the whole of a thread's first turn, and the old
    // `workedMs > 0` gate rendered nothing at all through it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:45Z'));
    const el = render(
      <ChatHeader
        {...baseProps}
        workedMs={0}
        turnCount={0}
        openTurn={{
          startedAt: Date.parse('2026-08-04T00:00:00.000Z'),
          parkedMs: 0,
          openSince: [],
        }}
      />,
    );

    expect(el.textContent).toContain('worked 45s');
    // One turn, so no tally — the figure IS that turn.
    expect(el.textContent).not.toContain('turns');
  });
});
