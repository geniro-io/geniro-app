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

  it('carries no side-panel control, and no counter, at all', () => {
    const el = render(<ChatHeader {...baseProps} />);
    // The old agent chips must stay gone — the panel is the agents surface.
    expect(el.querySelector('button[aria-label^="Agent "]')).toBeNull();
    // And so must the toggle that used to open it, in both its labels.
    expect(el.querySelector('button[aria-label="Open side panel"]')).toBeNull();
    expect(
      el.querySelector('button[aria-label="Close side panel"]'),
    ).toBeNull();
    // The COUNTS the toggle left behind have since moved on themselves: the
    // running terminals, the working delegates and the task list are all chips
    // on the composer shelf now, one row above where the user types. Pinned
    // here as an absence because the move is only half done if the header goes
    // on drawing its own copy — two readouts of one number is exactly the
    // header/sidebar disagreement this app has already had to fix once.
    expect(el.querySelector('[data-slot="side-panel-counts"]')).toBeNull();
    expect(el.querySelector('[data-slot="running-subagents"]')).toBeNull();
    expect(el.querySelector('[data-slot="open-tasks"]')).toBeNull();
    expect(el.querySelector('[data-slot="running-shells"]')).toBeNull();
  });

  it('never lets the right-hand group wrap onto a line of its own', async () => {
    // REPORTED against a screenshot: "subagent icon не должен переноситься на
    // новую строку". The outer row used to wrap, and wrapping there is
    // all-or-nothing — the identity group grows with the thread until the whole
    // right-hand group drops to a second line. The delegate counter that was
    // reported has moved to the shelf; the RULE outlived it, because the group
    // still holds the identity chip and the figures.
    //
    // Asserted on the emitted classes, not on computed style: Tailwind is a
    // build step and jsdom loads no stylesheet, so `getComputedStyle` reports
    // the default for every element here and would pass with the fix deleted.
    // The class IS the mechanism, so the class is the observable.
    const el = render(
      <ChatHeader {...baseProps} agentKind="claude" costUsd={1.11} />,
    );
    const row = el.querySelector('[data-slot="chat-header"]')!;
    const aside = el.querySelector('[data-slot="chat-header-aside"]')!;

    expect(row.className).not.toContain('flex-wrap');
    // Nor inside the identity — that variant kept the counters in place while
    // orphaning "· worked 2.7s · $0.20" on a line of its own.
    expect(row.firstElementChild!.className).not.toContain('flex-wrap');
    // It gives up width on the side that can truncate, never on the numbers.
    expect(aside.className).toContain('shrink-0');
    expect(row.firstElementChild!.className).toContain('min-w-0');
    expect(row.firstElementChild!.className).toContain('flex-1');
    expect(el.querySelector('h2')!.className).toContain('truncate');
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

  it('reports the PINNED profile and names the file that decided it', async () => {
    // This test has now asserted both answers, which is the reason to state
    // the measurement rather than the conclusion. On 2.1.247, with
    // `CLAUDE_CONFIG_DIR` naming a personal `max` profile throughout and
    // `get_usage` asked every 12s: from a folder whose
    // `.claude/settings.local.json` pins the team profile the reply was `max`
    // at +4s…+25s and `team` from +37s on; from an unpinned folder it never
    // moved off `max`. The pin wins, about half a minute in — so a probe that
    // asks once at spawn measures the window before it lands, which is how
    // this row twice came to claim a profile the turn was not on.
    //
    // What the pin does NOT decide is the MCP set, loaded at startup ahead of
    // it — that is `effectiveConfigDir`, and the two are deliberately separate
    // functions.
    const el = render(
      <ChatHeader
        {...baseProps}
        agentKind="claude"
        cwd="/Users/me/Desktop/Projects/Lab"
        configDir="/profiles/personal"
        configDirPin={{
          effective: '/profiles/team',
          source: '/Users/me/Desktop/Projects/Lab/.claude/settings.local.json',
        }}
      />,
    );

    const trigger = el
      .querySelector('[data-slot="thread-identity"]')!
      .querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const profile = [...el.querySelectorAll('li')].find((row) =>
      row.textContent?.startsWith('Profile'),
    )!;
    expect(profile.textContent).toContain('/profiles/team');
    // The pin outranks the pick on THIS row, or the header goes back to
    // naming an account the turn is not billing to.
    expect(profile.textContent).not.toContain('/profiles/personal');

    // …and the pick is not simply dropped: the row below names the file doing
    // the overriding, which is the only thing a reader can act on, and states
    // what it overrode.
    const pinned = [...el.querySelectorAll('li')].find((row) =>
      row.textContent?.startsWith('Pinned by'),
    )!;
    expect(pinned.textContent).toContain(
      '/Users/me/Desktop/Projects/Lab/.claude/settings.local.json',
    );
    expect(pinned.textContent).toContain('/profiles/personal');
  });

  it('bounds a long value at three rows and keeps the whole of it on hover', async () => {
    // REPORTED as "titles should look as one line, and the value max 3 rows,
    // then on hover i can see full value" — so the clamp may not be allowed to
    // LOSE anything, which is what the `title` carries. jsdom computes no
    // layout, so the clamp itself is unobservable here; what a test can pin is
    // that nothing is dropped by it. Driven off the PROFILE row now that the
    // pin row is gone — a config directory is the same kind of long absolute
    // path, and the clamp is a property of the row rather than of any one fact.
    const configDir =
      '/Users/me/Desktop/Projects/Lab/profiles/.claude-work-personal';
    const el = render(
      <ChatHeader
        {...baseProps}
        agentKind="claude"
        cwd="/Users/me/Desktop/Projects/Lab"
        configDir={configDir}
        configDirPin={null}
      />,
    );

    const trigger = el
      .querySelector('[data-slot="thread-identity"]')!
      .querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const profileRow = [...el.querySelectorAll('li')].find((row) =>
      row.textContent?.startsWith('Profile'),
    )!;
    const spans = [...profileRow.querySelectorAll('span')];
    const label = spans[0]!;
    const value = spans[1]!;
    // The label is one line whatever the panel's width — two words wrapped, and
    // the wrap pushed its own value up against the row above.
    expect(label.className).toContain('whitespace-nowrap');
    // Three rows, and the rest reachable rather than gone.
    expect(value.className).toContain('line-clamp-3');
    expect(value.getAttribute('title')).toBe(value.textContent);
    expect(value.getAttribute('title')).toContain(configDir);
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

  it('marks an UNPRICED thread with a dash, and says why behind it', () => {
    // REPORTED as "I dont see how much i spend for thread - i should see it",
    // on a cursor thread. The daemon was right to send no figure — probed on
    // cursor-agent 2026.08.11-e8db854, a completed turn sends no `usage_update`
    // at all, so nothing prices it — but an EMPTY slot reads as a header with
    // no spend readout rather than as a thread nothing measured.
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={252_000}
        turnCount={6}
        costUsd={null}
        costedTurns={0}
      />,
    );

    expect(metrics(el)).toContain('—');
    // Never a fabricated zero: that is the rule the dash exists to keep.
    expect(metrics(el)).not.toContain('$');
    expect(metricsTitle(el)).toContain('No cost reported');
    expect(metricsTitle(el)).toContain('6 turns');
  });

  it('draws NO dash while the totals have simply not been read yet', () => {
    // A thread whose read failed, or has not landed, knows nothing about its
    // turns — claiming none of them was priced would be an answer invented out
    // of a missing one. `costedTurns` null, not zero, is what separates them.
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={252_000}
        turnCount={6}
        costUsd={null}
        costedTurns={null}
      />,
    );

    expect(metrics(el)).not.toContain('—');
    expect(metricsTitle(el)).not.toContain('No cost reported');
  });

  it('shows the PRICE, not the dash, on a thread that reported one', () => {
    const el = render(
      <ChatHeader
        {...baseProps}
        status="completed"
        workedMs={252_000}
        turnCount={6}
        costUsd={1.25}
        costedTurns={6}
      />,
    );

    expect(metrics(el)).toContain('$1.25');
    expect(metrics(el)).not.toContain('—');
    expect(metricsTitle(el)).not.toContain('No cost reported');
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
});
