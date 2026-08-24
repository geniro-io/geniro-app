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

  it('carries no side-panel control at all — the panel stands beside every chat', () => {
    const el = render(
      <ChatHeader
        {...baseProps}
        runningSubagents={2}
        tasks={{ done: 3, total: 8 }}
      />,
    );
    // The old agent chips must stay gone — the panel is the agents surface.
    expect(el.querySelector('button[aria-label^="Agent "]')).toBeNull();
    // And so must the toggle that used to open it, in both its labels.
    expect(el.querySelector('button[aria-label="Open side panel"]')).toBeNull();
    expect(
      el.querySelector('button[aria-label="Close side panel"]'),
    ).toBeNull();
    // The counts it used to carry survive it. They are pressable again — but
    // for their OWN readout (the delegates behind the number, the tasks behind
    // the pair), never to open or close the panel beside the chat.
    const counts = el.querySelector('[data-slot="side-panel-counts"]')!;
    expect(counts).not.toBeNull();
    expect(counts.tagName).toBe('SPAN');
    expect(counts.textContent).toContain('2');
    // The task figure names its DENOMINATOR. A lone "3" left the reader unable
    // to tell three-of-four from three-of-forty, and it only ever shrinks — the
    // reported "here we need to show all amount of tasks as well".
    expect(counts.querySelector('[data-slot="open-tasks"]')?.textContent).toBe(
      '3/8',
    );
  });

  it('never lets the counters wrap onto a line of their own', async () => {
    // REPORTED against a screenshot: "subagent icon не должен переноситься на
    // новую строку". The outer row used to wrap, and wrapping there is
    // all-or-nothing — the identity group grows with the thread until the whole
    // right-hand group drops to a second line.
    //
    // Asserted on the emitted classes, not on computed style: Tailwind is a
    // build step and jsdom loads no stylesheet, so `getComputedStyle` reports
    // the default for every element here and would pass with the fix deleted.
    // The class IS the mechanism, so the class is the observable.
    const el = render(
      <ChatHeader {...baseProps} runningSubagents={2} agentKind="claude" />,
    );
    const counts = el.querySelector('[data-slot="side-panel-counts"]')!;
    const row = counts.parentElement!.parentElement!;

    expect(row.className).not.toContain('flex-wrap');
    // Nor inside the identity — that variant kept the counters in place while
    // orphaning "· worked 2.7s · $0.20" on a line of its own.
    expect(row.firstElementChild!.className).not.toContain('flex-wrap');
    // It gives up width on the side that can truncate, never on the numbers.
    expect(counts.parentElement!.className).toContain('shrink-0');
    expect(row.firstElementChild!.className).toContain('min-w-0');
    expect(row.firstElementChild!.className).toContain('flex-1');
    expect(el.querySelector('h2')!.className).toContain('truncate');
  });

  it('keeps the sub-agent counter on screen at ZERO', async () => {
    // REPORTED: "здесь должна быть всегда иконка саб-эйджентов, даже если их
    // ноль". A counter that appears only once something is running answers "are
    // any working" with the same blank space as a header that never had one.
    const el = render(<ChatHeader {...baseProps} runningSubagents={0} />);

    const counter = el.querySelector('[data-slot="running-subagents"]')!;
    expect(counter).not.toBeNull();
    expect(counter.textContent).toContain('0');
    // The TASK counter is still conditional: a thread whose agent keeps no
    // list has no list to report on.
    expect(el.querySelector('[data-slot="open-tasks"]')).toBeNull();
  });

  it('holds the delegates themselves behind the count', async () => {
    const el = render(
      <ChatHeader
        {...baseProps}
        runningSubagents={1}
        subagents={[
          {
            id: 't1',
            kind: 'subagent',
            label: 'explore',
            status: 'running',
            sessionId: null,
          },
          {
            id: 't2',
            kind: 'subagent',
            label: 'review the diff',
            status: 'completed',
            sessionId: null,
          },
        ]}
      />,
    );

    const trigger = el
      .querySelector('[data-slot="running-subagents"]')!
      .querySelector('button')!;
    // Closed, the panel is not in the DOM at all — the count is all there is.
    expect(el.textContent).not.toContain('review the diff');

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('explore');
    expect(el.textContent).toContain('review the diff');
    // Each row states its own status, so a finished delegate is not counted as
    // one of the working ones the number names.
    expect(el.textContent).toContain('completed');
  });

  it('says so in words when there are no delegates to list', async () => {
    // The counter is drawn at zero now, so an EMPTY panel behind it would read
    // as a readout that failed to load.
    const el = render(<ChatHeader {...baseProps} runningSubagents={0} />);

    await act(async () => {
      el.querySelector('[data-slot="running-subagents"]')!
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('No sub-agents yet');
  });

  it('holds the task LIST behind the done/total pair', async () => {
    // REPORTED: "при наведении на to-do поп-овер с тудушками" — and the count
    // alone could not say which task was running.
    const el = render(
      <ChatHeader
        {...baseProps}
        tasks={{ done: 1, total: 2 }}
        taskRows={[
          {
            id: '1',
            title: 'read the spec',
            status: 'completed',
            activeForm: null,
          },
          {
            id: '2',
            title: 'write the adapter',
            status: 'in_progress',
            activeForm: 'writing the adapter',
          },
        ]}
      />,
    );

    await act(async () => {
      el.querySelector('[data-slot="open-tasks"]')!
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('read the spec');
    // The running row reads in its present-continuous form, as it does
    // everywhere else the same list is drawn.
    expect(el.textContent).toContain('writing the adapter');
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

describe('ChatHeader — what this thread SPENT', () => {
  it('states the thread total beside what it worked', () => {
    // The reported ask. The per-turn price was already on each `turn_complete`
    // row; what the header had no answer for is what the whole thread cost.
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={252_000}
        turnCount={6}
        costUsd={12.3456}
      />,
    );

    expect(el.textContent).toContain('$12.35');
    // An addition, not a swap: the worked figure is still there.
    expect(el.textContent).toContain('worked 4m 12s');
  });

  it('renders NOTHING when nothing measured a cost, rather than $0.00', () => {
    // cursor-agent reports no cost unless its currency is USD. `$0.00` would
    // state that the thread was free, which is a different claim from "we were
    // not told" — and the one the user would act on.
    const el = render(
      <ChatHeader {...baseProps} status="completed" costUsd={null} />,
    );

    expect(el.querySelector('[data-slot="thread-spend"]')).toBeNull();
    expect(el.textContent).not.toContain('$');
  });

  it('keeps a sub-cent thread out of the $0.00 trap', () => {
    // A cheap thread has still been measured, and rounding it to `$0.00` makes
    // it indistinguishable from the case above that means the opposite.
    const el = render(
      <ChatHeader {...baseProps} status="completed" costUsd={0.0003} />,
    );

    expect(el.textContent).toContain('$0.0003');
  });
  it('counts the running shells beside the delegates, and holds them behind it', async () => {
    // The ask: how many commands this thread has open, next to how many
    // delegates are working. Both are counts of work in flight the transcript
    // alone would make a reader hunt for.
    const el = render(
      <ChatHeader
        {...baseProps}
        runningSubagents={1}
        shells={[
          {
            id: 'c1',
            command: 'pnpm build',
            description: null,
            background: false,
            handle: null,
            status: 'running',
            exitCode: null,
            startedAt: new Date(Date.now() - 5_000).toISOString(),
            agentId: null,
          },
          {
            id: 'c2',
            command: 'pnpm dev',
            description: null,
            background: true,
            handle: 'bash_1',
            status: 'running',
            exitCode: null,
            startedAt: new Date(Date.now() - 5_000).toISOString(),
            agentId: null,
          },
        ]}
      />,
    );

    const counter = el.querySelector('[data-slot="running-shells"]')!;
    expect(counter).not.toBeNull();
    expect(counter.textContent).toContain('2');
    // Closed, the commands themselves are not in the DOM — the count is all
    // there is, exactly as with the delegates beside it.
    expect(el.textContent).not.toContain('pnpm build');

    await act(async () => {
      counter
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('pnpm build');
    expect(el.textContent).toContain('pnpm dev');
  });

  it('keeps the shell counter on screen at ZERO, and says so in words', async () => {
    // The same rule as the sub-agent counter it sits beside: a counter that
    // appears only once something is running answers "is anything running" with
    // the same blank space as a header that never had one.
    const el = render(<ChatHeader {...baseProps} shells={[]} />);

    const counter = el.querySelector('[data-slot="running-shells"]')!;
    expect(counter).not.toBeNull();
    expect(counter.textContent).toContain('0');

    await act(async () => {
      counter
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('Nothing running');
  });
});
