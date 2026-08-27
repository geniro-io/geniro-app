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

/**
 * The header's ONE figures readout — what the thread worked and what it spent.
 *
 * Read through the slot rather than off the whole header, which is what the
 * redesign made possible and what these assertions are worth more for: before,
 * every duration test matched `worked 10m 0s` anywhere in the row, so a figure
 * that had drifted into the wrong element still passed.
 */
function metrics(el: HTMLElement): string {
  return el.querySelector('[data-slot="thread-metrics"]')?.textContent ?? '';
}

/** The sentence behind that readout — the turn count lives there now. */
function metricsTitle(el: HTMLElement): string {
  return (
    el.querySelector('[data-slot="thread-metrics"]')?.getAttribute('title') ??
    ''
  );
}

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

  it('sizes the counters on the BUTTON, where an inherited size cannot reach', async () => {
    // REPORTED as "давай сделаем меньше вот эти циферки… значки оставь одного
    // размера": the digits were drawn larger and heavier than the icons beside
    // them and than every other word on the header line. The row asks for
    // `text-xs`, but `global.css`'s base rule sets `button { font-size:
    // var(--text-base) }` — which DEFEATS inheritance, since the size is then
    // set on the button itself — so the row's size reached the glyphs and not
    // the numbers. The fix has to be ON each trigger, and that is what this
    // pins: put the classes back on the wrapper alone and the counters go
    // 15px medium again.
    //
    // Classes, not `getComputedStyle` — jsdom loads no stylesheet, so every
    // computed size here is the default and the assertion would pass with the
    // fix deleted. Same reasoning as the wrap test above.
    const el = render(
      <ChatHeader
        {...baseProps}
        runningSubagents={2}
        tasks={{ done: 3, total: 8 }}
        shells={[]}
        agentKind="claude"
      />,
    );
    const triggers = [
      ...el.querySelectorAll<HTMLElement>(
        '[data-slot="side-panel-counts"] button',
      ),
    ];
    // All three of them — the constant exists so one cannot be missed.
    expect(triggers).toHaveLength(3);
    for (const trigger of triggers) {
      expect(trigger.className).toContain('text-xs');
      expect(trigger.className).toContain('font-normal');
    }
    // And the ICONS are untouched: the ask was to shrink the numbers, not the
    // glyphs, so a later "make it all smaller" cannot pass this by shrinking
    // both.
    for (const icon of el.querySelectorAll(
      '[data-slot="side-panel-counts"] svg',
    )) {
      expect(icon.getAttribute('class')).toContain('size-3.5');
    }
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

  it('shows ONE clock while a turn is running, and it is the worked total', () => {
    // REPORTED against `running · 21s · worked 21s`: "у нас сейчас два раза
    // показывается таймер… нам нужен только таймер, сколько он в целом
    // работал". This turn's raw wall clock used to sit here, and on a thread's
    // first turn the two are the same number printed twice.
    //
    // The relative time is NOT what takes its place while running — it reads
    // "just now" for a whole turn and answers nothing, which is why the wall
    // clock was here at all. `worked` answers it instead, because it ticks.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:21Z'));
    const el = render(
      <ChatHeader
        {...baseProps}
        status="running"
        workedMs={0}
        turnCount={0}
        lastActivityAt="2026-08-04T00:00:00.000Z"
        openTurn={{
          startedAt: Date.parse('2026-08-04T00:00:00.000Z'),
          parkedMs: 0,
          openSince: [],
        }}
      />,
    );

    expect(metrics(el)).toContain('21s');
    // Exactly one duration on the line — the pair is what was reported.
    expect(el.textContent?.match(/21s/g)).toHaveLength(1);
    expect(el.querySelector('[data-slot="thread-metrics"]')).not.toBeNull();
  });

  it('still says when a SETTLED thread last spoke, beside what it worked', () => {
    // Only the running half went. `completed · 4m · worked 1h 41m 5s` is two
    // different answers — "when did this last speak" and "how much work is in
    // here" — not one of them twice, and the second had no answer anywhere in
    // the app before it was added.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:04:00Z'));
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={600_000}
        turnCount={5}
        lastActivityAt="2026-08-04T00:00:00.000Z"
      />,
    );

    // Two different figures on the header: when it last spoke, and what it
    // worked. They are now on opposite sides of the row, which is what lets
    // this assert they are not one value read twice — the relative time is in
    // the identity half and `10m 0s` is in the figures half.
    expect(el.textContent).toContain('· 4m');
    expect(metrics(el)).toContain('10m 0s');
    expect(metrics(el)).not.toContain('4m·');
  });

  it('names the config directory this run belongs to — on the chip’s label, in full behind it', async () => {
    // A run on a second profile is a different ACCOUNT with different tools —
    // the one fact about a conversation that is invisible everywhere else.
    //
    // It used to be a chip of its own, and the reported "we have soo much
    // information here" is what folded it in: the LEAF is now on one identity
    // chip's accessible name and the whole path is behind it, which the chip
    // could never show at all.
    const el = render(
      <ChatHeader
        {...baseProps}
        agentKind="claude"
        cwd="/Users/me/Desktop/Projects/Lab"
        configDir="/Users/me/Desktop/Projects/Lab/.claude-lab"
      />,
    );

    const trigger = el
      .querySelector('[data-slot="thread-identity"]')!
      .querySelector('button')!;
    expect(trigger.getAttribute('aria-label')).toContain(
      '/Users/me/Desktop/Projects/Lab/.claude-lab',
    );
    // Closed, the paths are not in the DOM — the line shows the folder leaf.
    expect(el.textContent).toContain('Lab');
    expect(el.textContent).not.toContain('.claude-lab');

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // All three, each under its own name and each in full.
    expect(el.textContent).toContain('claude');
    expect(el.textContent).toContain('/Users/me/Desktop/Projects/Lab');
    expect(el.textContent).toContain(
      '/Users/me/Desktop/Projects/Lab/.claude-lab',
    );
  });

  it('keeps a run on the CLI’s own profile off the LINE, and names the default behind it', async () => {
    // The default is not news, so it earns no room on a row the title
    // truncates for. Inside the panel — which is opened deliberately — the
    // opposite holds: a missing Profile row would leave the commonest case as
    // the one the header says nothing about at all.
    const el = render(
      <ChatHeader
        {...baseProps}
        cwd="/Users/me/Desktop/Projects/Lab"
        configDir={null}
      />,
    );

    const trigger = el
      .querySelector('[data-slot="thread-identity"]')!
      .querySelector('button')!;
    expect(trigger.textContent).toBe('Lab');
    expect(trigger.getAttribute('aria-label')).not.toContain('Profile');

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('The CLI’s default');
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

    expect(metrics(el)).toContain('4m 12s');
    // The turn count moved onto the readout's own sentence — it is what the
    // figure is a sum OVER, which is a thing you ask about rather than scan.
    expect(metricsTitle(el)).toContain('6 turns');
    expect(metrics(el)).not.toContain('turns');
    // The relative time is still there — this is an addition, not a swap.
    expect(el.textContent).toContain('1m');
  });

  it('renders nothing for a thread that has not worked yet', () => {
    // `worked 0s` on a brand-new chat would be a claim about work that has not
    // been asked for. Absent is the honest state.
    const el = render(
      <ChatHeader {...baseProps} status="completed" workedMs={0} />,
    );

    expect(el.querySelector('[data-slot="thread-metrics"]')).toBeNull();
    expect(el.textContent).not.toContain('0s');
  });

  it('says "1 turn" rather than "1 turns" for a single-turn thread', () => {
    // The figure IS that turn, and `1 turns` is the kind of small wrongness a
    // reader trusts a number less for.
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={7618}
        turnCount={1}
      />,
    );

    expect(metrics(el)).toContain('7.6s');
    expect(metricsTitle(el)).toContain('across 1 turn ');
    expect(metricsTitle(el)).not.toContain('turns');
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
        openTurn={{
          startedAt: Date.parse('2026-08-04T00:00:00.000Z'),
          parkedMs: 0,
          openSince: [],
        }}
      />,
    );

    // 10m settled + 1m of the turn in flight.
    expect(metrics(el)).toContain('11m 0s');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(metrics(el)).toContain('11m 30s');
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

    expect(metricsTitle(el)).toContain('across 6 turns');
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
    expect(metrics(el)).toContain('10m 20s');

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(metrics(el)).toContain('10m 20s');
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

    expect(metrics(el)).toContain('10m 0s');
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(metrics(el)).toContain('10m 0s');
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

    expect(metrics(el)).toContain('45s');
    // One turn, so no tally — the figure IS that turn.
    expect(metricsTitle(el)).not.toContain('turns');
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

    expect(metrics(el)).toContain('$12.35');
    // An addition, not a swap: the worked figure is still there, and the two
    // are one readout now rather than two spans with their own middots.
    expect(metrics(el)).toContain('4m 12s');
  });

  it('renders NOTHING when nothing measured a cost, rather than $0.00', () => {
    // cursor-agent reports no cost unless its currency is USD. `$0.00` would
    // state that the thread was free, which is a different claim from "we were
    // not told" — and the one the user would act on.
    const el = render(
      <ChatHeader {...baseProps} status="completed" costUsd={null} />,
    );

    expect(el.querySelector('[data-slot="thread-metrics"]')).toBeNull();
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
