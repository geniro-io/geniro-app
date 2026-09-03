// @vitest-environment jsdom
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentsPanel } from './agents-panel';
import { ChatHeader } from './chat-header';
import {
  type ChatMetricsLoader,
  ChatMetricsLoaderContext,
} from './chat-metrics';
import { ContextMeter } from './context-meter';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The panel's folds are REMEMBERED (`usePersistedFlag` → localStorage), which
  // jsdom keeps for the whole file: a case that opens the MCP block would
  // otherwise leave every case after it running against an expanded panel, and
  // the fold assertions would pass or fail by test order.
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(el: React.ReactNode): void {
  act(() => root.render(el));
}

/**
 * The meter's reading, which lives on the BUTTON around the ring.
 *
 * On the button rather than on the `<svg>`: the figures are hover-only for a
 * sighted user, so the accessible name is the one place a screen-reader user
 * gets them without opening anything. A ring labelled separately would make
 * the same figure announce twice.
 */
function meterLabel(): string | null {
  return (
    container
      // Scoped to the METER's own slot, not "any expandable button on screen":
      // the header grew readouts of its own (the sub-agent and task counts,
      // each holding its list behind the same `HoverPopover`), and an unscoped
      // query read one of those as the meter.
      .querySelector('[data-slot="context-meter"] button[aria-expanded]')
      ?.getAttribute('aria-label') ?? null
  );
}

/** The ring itself — decorative now, so it is found by tag, not by role. */
function ring(): SVGElement | null {
  return container.querySelector('svg');
}

function openMeter(): void {
  act(() => meterTrigger()?.click());
}

function meterTrigger(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-expanded]');
}

/** The opened readout, or null while it is closed. */
function panel(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

/**
 * A pointer arriving at / leaving an element.
 *
 * `mouseover` / `mouseout` rather than `mouseenter` / `mouseleave`: React
 * derives the enter/leave pair from the bubbling ones, so these are what a
 * real pointer actually dispatches — and dispatching the non-bubbling pair
 * directly reaches no React handler at all.
 */
function hoverIn(el: Element | null): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

function hoverOut(el: Element | null): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });
}

describe('ContextMeter', () => {
  it('scales against the model’s OWN window, not an assumed one', () => {
    // A 1M-window model at 250k is a quarter full. Measuring it against the
    // 200k default would report it as over capacity.
    render(
      <ContextMeter contextTokens={250_000} contextWindowTokens={1_000_000} />,
    );
    expect(meterLabel()).toBe('Context 25% full — 250k of 1M');
  });

  it('keeps the figures off the header until asked for them', () => {
    // The reported complaint: `ctx 250k / 1M` beside a ring showing 25% says
    // the same thing twice and crowds the row. The ring answers the glance;
    // the numbers are one interaction away.
    render(
      <ContextMeter
        contextTokens={250_000}
        contextWindowTokens={1_000_000}
        spentUsd={1.5}
      />,
    );
    expect(container.textContent).toBe('');

    openMeter();
    expect(container.textContent).toContain('250k / 1M');
    expect(container.textContent).toContain('25%');
    expect(container.textContent).toContain('$1.50');
  });

  it('closes again on a second press, so the panel is not sticky', () => {
    render(
      <ContextMeter contextTokens={250_000} contextWindowTokens={1_000_000} />,
    );
    openMeter();
    expect(container.textContent).toContain('250k / 1M');

    openMeter();
    expect(container.textContent).toBe('');
  });

  it('opens on keyboard focus too, not on hover alone', () => {
    // A hover-only readout is unreachable without a pointer. Focus is the
    // keyboard's equivalent of a hover, so it must open the same panel.
    render(
      <ContextMeter contextTokens={250_000} contextWindowTokens={1_000_000} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    act(() => trigger?.focus());
    expect(container.textContent).toContain('250k / 1M');

    act(() => trigger?.blur());
    expect(container.textContent).toBe('');
  });

  it('keeps a MUTED ring when the CLI named no window, and invents no denominator', () => {
    // No assumed denominator. Substituting a flat 200k made a 1M-window model
    // read as a fifth full before its first turn had finished — the count is
    // true, the fraction would not have been.
    //
    // The ring STAYS, muted and at nought. REPORTED as "sometimes context
    // circle is disappearing and instead i just see something like ctx. 167k":
    // the old shape swapped the control for a line of text mid-turn, which is
    // what reads as the meter breaking. Reproduced by clearing this machine's
    // remembered windows — `ctx 63.6k` for the whole of a first turn, because
    // claude reports the window only on its `result` line.
    render(<ContextMeter contextTokens={100_000} contextWindowTokens={null} />);

    expect(ring()).not.toBeNull();
    // Muted, not green: a filled arc would be a claim about how full a window
    // nobody has measured is.
    expect(ring()?.getAttribute('class') ?? '').toContain('muted-foreground');
    // The reading is reachable rather than printed beside the ring, like every
    // other state's — and it still names no fraction.
    expect(meterLabel()).toContain('100k');
    expect(meterLabel()).not.toContain('%');
    expect(container.textContent).not.toContain('/');

    openMeter();
    expect(panel()?.textContent).toContain('ctx 100k');
  });

  it('treats a zero window as no window at all', () => {
    // A window of 0 is not a window — it reaches here as a plain number
    // (`readClaudeUsage` passes `contextWindow` through, and the panel keeps
    // any number it is given), and dividing by it puts "Infinity" in the one
    // place the figure is legible.
    render(<ContextMeter contextTokens={100_000} contextWindowTokens={0} />);

    expect(meterLabel()).toContain('100k');
    expect(meterLabel()).not.toContain('%');
    expect(container.textContent).not.toContain('/');
  });

  it('runs green, then yellow, then red — AT the 60% and 90% marks', () => {
    // A traffic light, so the boundaries themselves are the promise: green
    // below 60, yellow from 60 to under 90, red from 90. Sampling only 50/75/95
    // would pass with either threshold shifted by several points — and 70 is
    // sampled explicitly because it was the previous warn mark, so a revert
    // fails here rather than passing on a lucky sample.
    const tone = (percent: number): string => {
      render(
        <ContextMeter
          contextTokens={percent * 2_000}
          contextWindowTokens={200_000}
        />,
      );
      return ring()?.getAttribute('class') ?? '';
    };
    expect(tone(59)).toContain('text-success');
    expect(tone(60)).toContain('text-warning');
    expect(tone(70)).toContain('text-warning');
    expect(tone(89)).toContain('text-warning');
    expect(tone(90)).toContain('text-destructive');
  });

  it('renders nothing until a turn has reported something', () => {
    // A turn that has yet to report anything: a moment, not a fact, so there is
    // nothing to explain and no spot to hold.
    //
    // This used to have a sibling that held the spot with a sentence for "a CLI
    // that never reports usage", fed from the daemon's usage capability. Both
    // shipped CLIs do report a context reading — claude over its control
    // channel, cursor-agent out of its own session store — so the sentence only
    // ever appeared on a chat whose first turn had not landed yet, where it
    // said "no cost can be shown" about a reading that was on its way. See
    // `context-meter.tsx` for the full note.
    render(<ContextMeter contextTokens={null} contextWindowTokens={null} />);
    expect(container.textContent).toBe('');
  });

  it('shows the reading once it lands, for a CLI that reports no cost', () => {
    // The cursor case end to end: no spend to show, and a real context reading
    // all the same. Pinned because the removed branch would have replaced this
    // with a sentence about cost.
    render(
      <ContextMeter
        contextTokens={47_900}
        contextWindowTokens={272_000}
        spentUsd={null}
      />,
    );
    expect(meterLabel()).toBe('Context 18% full — 47.9k of 272k');
    expect(container.textContent).not.toContain('cost');
  });

  it('leaves the ring itself unlabelled, so the figure announces once', () => {
    render(
      <ContextMeter contextTokens={50_000} contextWindowTokens={200_000} />,
    );
    expect(ring()?.getAttribute('role')).toBeNull();
    expect(ring()?.getAttribute('aria-hidden')).toBe('true');
    expect(meterLabel()).toBe('Context 25% full — 50k of 200k');
  });
});

describe('where the meter lives', () => {
  const CONTEXT = { contextTokens: 250_000, contextWindowTokens: 1_000_000 };

  it('is NOT in the transcript header any more — it moved beside Send', () => {
    // The question it answers ("how much room is left") is asked while
    // composing the next message, not while reading the header, and the eye
    // leaves that row as soon as the conversation starts. The header no longer
    // even takes the figures, so this cannot regress by someone passing them.
    render(
      <ChatHeader
        label="My chat"
        isWorkflow={false}
        status="running"
        lastActivityAt={new Date().toISOString()}
      />,
    );

    expect(meterLabel()).toBeNull();
  });

  it('opens its readout UPWARD, because the composer row has no room below it', () => {
    // `Popover` does no collision detection — its placement is two static
    // ternaries — and this row sits at the bottom of the composer inside the
    // shell's `overflow-hidden` main, leaving ~20px under a 50-68px panel.
    // Opening downward clips the panel away, and the ring deliberately shows
    // no figures, so there is nothing left for a sighted user to read.
    render(<ContextMeter {...CONTEXT} side="top" />);
    openMeter();

    // Read off the INLINE box, not a `bottom-full` utility: the readout is
    // anchored to the viewport now (both call sites sit in a clipping ancestor,
    // which an absolutely-positioned panel cannot escape), so the direction is
    // expressed as which edge the panel is pinned by.
    const panel = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.style.position).toBe('fixed');
    expect(panel?.style.bottom).not.toBe('');
    expect(panel?.style.top).toBe('');
  });

  it('still opens downward where there IS room, so the panel call site is untouched', () => {
    render(<ContextMeter {...CONTEXT} />);
    openMeter();

    const panel = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.style.top).not.toBe('');
    expect(panel?.style.bottom).toBe('');
  });

  it('still reads the same figures in the agents panel', () => {
    // The panel keeps its own copy for a workflow's PER-NODE windows, which
    // the one composer meter could never show — and it renders the same
    // component, so the two cannot state a window differently.
    render(
      <AgentsPanel
        agents={[
          {
            id: 'agent',
            name: 'claude',
            agent: 'claude',
            model: null,
            inputTokens: null,
            outputTokens: null,
            cacheTokens: null,
            configDir: null,
            status: 'running',
            activeTurns: 1,
            ...CONTEXT,
            spentUsd: null,
            threads: [
              {
                id: 'main',
                kind: 'main',
                label: 'Conversation',
                status: 'running',
                sessionId: null,
              },
            ],
          },
        ]}
        onOpenThread={vi.fn()}
      />,
    );

    expect(meterLabel()).toBe('Context 25% full — 250k of 1M');
  });
});

describe('the expanded readout the meter opens onto', () => {
  const TOTALS = {
    turns: 3,
    costedTurns: 3,
    costUsd: 0.42,
    inputTokens: 24,
    outputTokens: 1_200,
    cacheReadTokens: 1_300_000,
    cacheCreationTokens: 210_000,
    thinkingTokens: 300,
    workedMs: 252_000,
  };
  const METRICS = {
    context: {
      categories: [
        { name: 'System prompt', tokens: 3386, deferred: false },
        { name: 'Memory files', tokens: 59_058, deferred: false },
        { name: 'MCP tools (deferred)', tokens: 273_876, deferred: true },
      ],
      totalTokens: 62_444,
      maxTokens: 1_000_000,
      model: 'claude-opus-5[1m]',
      autoCompactAtTokens: 967_000,
      autoCompactEnabled: true,
      memoryFiles: [
        { path: '/proj/CLAUDE.md', kind: 'Project', tokens: 45_947 },
      ],
      servers: [
        {
          name: 'amplitude',
          tokens: 109_284,
          toolCount: 33,
          loadedToolCount: 0,
        },
      ],
    },
    breakdownReason: null,
    // The account's own limits are a SEPARATE reading on the same route (see
    // `ContextPanel`'s `Plan`); these fixtures are about the window, so they
    // carry the shape a claude chat with no plan reading answers with.
    plan: null,
    planReason: 'plan limits are read from the running agent',
    takenAt: null,
    totals: TOTALS,
  };

  /** A never-settling loader, for the states BEFORE a reply lands. */
  function pending(): ChatMetricsLoader {
    return () => new Promise(() => {});
  }

  function tree(
    load: ChatMetricsLoader,
    runId: string | null,
    live = false,
  ): React.ReactNode {
    return (
      <ChatMetricsLoaderContext.Provider value={load}>
        <ContextMeter
          contextTokens={62_444}
          contextWindowTokens={1_000_000}
          runId={runId}
          live={live}
        />
      </ChatMetricsLoaderContext.Provider>
    );
  }

  function renderWithLoader(
    load: ChatMetricsLoader,
    runId: string | null = 'run-1',
    live = false,
  ): void {
    render(tree(load, runId, live));
  }

  it('asks nothing for a pointer that merely CROSSED the ring', async () => {
    // Opening fetches, and for claude that fetch is a control write onto the
    // live agent's stdin measured at 1.2–3.3s. The ring is 14px in the composer
    // row, so a pointer on its way to Send crosses it constantly — without the
    // rest delay every crossing put that question to the user's agent, and the
    // CLI serialises them, so five sweeps cost five compounding round trips.
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue(METRICS);
      renderWithLoader(load);

      // Across and away again, faster than the delay.
      hoverIn(meterTrigger());
      act(() => vi.advanceTimersByTime(120));
      hoverOut(meterTrigger());
      act(() => vi.advanceTimersByTime(5_000));
      expect(load).not.toHaveBeenCalled();

      // Resting on it IS the ask — the delay defers the fetch, never cancels it.
      hoverIn(meterTrigger());
      act(() => vi.advanceTimersByTime(300));
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays open while the pointer travels from the ring onto the panel', () => {
    // The reported defect. `Popover` anchors the panel 6px clear of the trigger,
    // so the journey from the ring to the thing the ring opened leaves BOTH of
    // them for a moment — and the panel it opens onto is a `max-h-[26rem]`
    // scrolling surface with a dozen rows in it. Closing on that moment left the
    // breakdown readable only by clicking, which nothing on screen advertises.
    vi.useFakeTimers();
    try {
      renderWithLoader(() => Promise.resolve(METRICS));
      hoverIn(meterTrigger());
      act(() => vi.advanceTimersByTime(300));
      expect(panel()).not.toBeNull();

      // Off the ring, across the gap, onto the panel. The panel is a DOM child
      // of the meter's own span, so the span sees this arrival — the button the
      // handlers used to hang off never could, the two being siblings.
      hoverOut(meterTrigger());
      hoverIn(panel());
      act(() => vi.advanceTimersByTime(5_000));

      expect(panel()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still closes once the pointer leaves for good', () => {
    // The counterweight to the grace above: without this, a panel that never
    // closed at all would satisfy it.
    vi.useFakeTimers();
    try {
      renderWithLoader(() => Promise.resolve(METRICS));
      hoverIn(meterTrigger());
      act(() => vi.advanceTimersByTime(300));
      expect(panel()).not.toBeNull();

      hoverOut(meterTrigger());
      act(() => vi.advanceTimersByTime(5_000));

      expect(panel()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reopen a panel dismissed while a hover was still pending', () => {
    // The branch the press-path cancel exists for. A press that BEATS the rest
    // delay leaves the open timer armed, so without the cancel it fires after
    // the second press and puts back the panel the user had just dismissed.
    vi.useFakeTimers();
    try {
      renderWithLoader(() => Promise.resolve(METRICS));
      hoverIn(meterTrigger());
      // Quicker than the rest delay: the open timer is still pending.
      act(() => vi.advanceTimersByTime(100));

      act(() => meterTrigger()?.click());
      expect(panel()).not.toBeNull();
      act(() => meterTrigger()?.click());
      expect(panel()).toBeNull();

      act(() => vi.advanceTimersByTime(5_000));
      expect(panel()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind when the meter unmounts mid-hover', () => {
    // The unmount cleanup, which nothing else can observe: React no longer warns
    // about a state write on an unmounted tree, and the fetch is gated on the
    // effect that just tore down — so a leaked timer is invisible in the DOM and
    // in the loader alike. The pending-timer count is what it actually changes.
    vi.useFakeTimers();
    try {
      renderWithLoader(() => Promise.resolve(METRICS));
      hoverIn(meterTrigger());
      const armed = vi.getTimerCount();
      expect(armed).toBeGreaterThan(0);

      act(() => root.render(null));

      expect(vi.getTimerCount()).toBeLessThan(armed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shows one chat’s breakdown under another chat’s name', async () => {
    // The meter is NOT unmounted across a chat switch — the composer keeps one
    // and `activateRun` only swaps the run beneath it — so a reading survives
    // into a conversation it does not describe unless it is discarded on
    // purpose.
    //
    // What replaces it is the LOADING line, not the last-request summary: the
    // new chat's reading is on its way, and printing a different measurement
    // of the same window in the meantime is the jump this panel now avoids.
    const load = vi
      .fn()
      .mockResolvedValueOnce(METRICS)
      // The second chat's reading never lands, which is the whole window the
      // defect was visible in — and indefinitely so on a failed fetch.
      .mockReturnValueOnce(new Promise(() => {}));
    renderWithLoader(load, 'run-1');
    openMeter();
    await act(async () => {});
    expect(container.textContent).toContain('System prompt');

    // Same meter, still open, different chat.
    renderWithLoader(load, 'run-2');
    await act(async () => {});

    expect(container.textContent).not.toContain('System prompt');
    expect(container.textContent).not.toContain('claude-opus-5[1m]');
    expect(container.textContent).toContain('Reading the agent');
  });

  it('does not paint the old chat’s breakdown for even ONE frame', async () => {
    // The other half of the runId fix, and the half the sibling test above
    // cannot reach. The effect-side clear runs AFTER the commit, so the first
    // frame of the new chat is painted from whatever state survived the switch;
    // only the render-time guard covers it.
    //
    // `act()` is what hid this: it flushes passive effects with the render, so
    // every assertion inside it reads a state the effect has already corrected.
    // `flushSync` commits without flushing them, which is the frame a user
    // actually sees. (I had recorded this branch as unobservable in jsdom. It
    // is not — that was a limit of the harness I reached for, not of jsdom.)
    const load = vi
      .fn()
      .mockResolvedValueOnce(METRICS)
      .mockReturnValueOnce(new Promise(() => {}));
    renderWithLoader(load, 'run-1');
    openMeter();
    await act(async () => {});
    expect(container.textContent).toContain('System prompt');

    flushSync(() => {
      root.render(tree(load, 'run-2'));
    });

    expect(container.textContent).not.toContain('System prompt');
    expect(container.textContent).not.toContain('claude-opus-5[1m]');

    // Let the deferred effect land, so the shared afterEach unmounts a settled
    // tree rather than one mid-commit.
    await act(async () => {});
  });

  it('keeps the reading on screen while the SAME chat is re-read', async () => {
    // The counterweight: discarding on every fetch would blank the panel the
    // user is mid-sentence about, which is why the re-fetch was written to cost
    // no blank panel in the first place.
    const load = vi
      .fn()
      .mockResolvedValueOnce(METRICS)
      .mockReturnValueOnce(new Promise(() => {}));
    renderWithLoader(load, 'run-1');
    openMeter();
    await act(async () => {});
    expect(container.textContent).toContain('System prompt');

    // Closed and reopened on the same chat — a second fetch, same run.
    openMeter();
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain('System prompt');
    expect(container.textContent).toContain('Reading the agent');
  });

  it('asks for the breakdown only once the readout is OPENED', async () => {
    // It is a multi-second round trip to the user's own running agent. Fetching
    // it on mount would put that question to every chat in the list.
    const load = vi.fn().mockResolvedValue(METRICS);
    renderWithLoader(load);

    expect(load).not.toHaveBeenCalled();
    openMeter();
    await act(async () => {});

    expect(load).toHaveBeenCalledWith('run-1');
  });

  it('shows what the window holds, by category and with its own figures', async () => {
    renderWithLoader(() => Promise.resolve(METRICS));
    openMeter();
    await act(async () => {});

    const text = container.textContent ?? '';
    expect(text).toContain('System prompt');
    expect(text).toContain('Memory files');
    expect(text).toContain('59.1k');
    expect(text).toContain('claude-opus-5[1m]');
    expect(text).toContain('Auto-compacts at 967k');
  });

  it('keeps a deferred category OUT of the used total and its bar', async () => {
    // The pin: the deferred MCP surface is four times the whole window's
    // contents. Counted in, the readout reports a window that is full.
    renderWithLoader(() => Promise.resolve(METRICS));
    openMeter();
    await act(async () => {});

    const text = container.textContent ?? '';
    // The used figure is the CLI's own total, not total + deferred (336k).
    expect(text).toContain('62.4k');
    expect(text).not.toContain('336');
    // It is still SHOWN, under its own heading — dropping it would hide the
    // biggest thing the user could act on.
    expect(text).toContain('Available, not loaded');
    expect(text).toContain('273.9k');
  });

  it('FOLDS the drill-downs, keeping each block’s total on its header', async () => {
    // Reported as "у нас слишком много информации… по дефолту оно должно быть
    // свернуто": these three blocks are open-ended — one row per deferred
    // category, per instruction file, per MCP server — and on a real machine
    // they ran for screens above the readings the panel is opened for. The
    // total stays visible, because that is what a reader takes from a list of
    // nine servers anyway.
    renderWithLoader(() => Promise.resolve(METRICS));
    openMeter();
    await act(async () => {});

    const text = container.textContent ?? '';
    expect(text).toContain('MCP servers');
    expect(text).toContain('1 server · 109.3k');
    // The plural comes from the caller, not from an appended `s` — the first
    // block counts CATEGORIES, and deriving it printed "2 categorys" in the
    // running app.
    expect(text).toContain('1 category · 273.9k');
    expect(text).toContain('1 file · 45.9k');
    // ...and the rows themselves are not on screen until they are asked for.
    expect(text).not.toContain('amplitude');
    expect(text).not.toContain('proj/CLAUDE.md');
  });

  it('names the instructions and the MCP servers once the block is opened', async () => {
    renderWithLoader(() => Promise.resolve(METRICS));
    openMeter();
    await act(async () => {});

    const headers = [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ];
    const servers = headers.find((b) =>
      b.textContent?.includes('MCP servers'),
    )!;
    const instructions = headers.find((b) =>
      b.textContent?.includes('Instructions'),
    )!;
    expect(servers.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      servers.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      instructions.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const text = container.textContent ?? '';
    expect(servers.getAttribute('aria-expanded')).toBe('true');
    expect(text).toContain('proj/CLAUDE.md');
    expect(text).toContain('45.9k');
    expect(text).toContain('amplitude');
    expect(text).toContain('109.3k');
  });

  it('reports what the whole thread has cost, not just the last turn', async () => {
    renderWithLoader(() => Promise.resolve(METRICS));
    openMeter();
    await act(async () => {});

    const text = container.textContent ?? '';
    expect(text).toContain('$0.42');
    expect(text).toContain('3 turns');
    expect(text).toContain('cache read 1.3M');
  });

  it('shows the daemon’s own sentence when there is no breakdown to take', async () => {
    renderWithLoader(() =>
      Promise.resolve({
        context: null,
        breakdownReason: 'cursor-agent has no channel for one',
        plan: null,
        planReason: 'cursor-agent does not report its plan limits',
        takenAt: null,
        totals: TOTALS,
      }),
    );
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain(
      'cursor-agent has no channel for one',
    );
    // The spend is history and is always there — losing it with the live
    // reading would blank the readout on every idle chat.
    expect(container.textContent).toContain('$0.42');
  });

  it('surfaces a failed fetch instead of an empty panel, and ANNOUNCES it', async () => {
    renderWithLoader(() =>
      Promise.reject(new Error('daemon GET failed (500)')),
    );
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain('daemon GET failed (500)');
    // The failure lands on a panel that is already open, so it reaches a screen
    // reader only through a live region — and the sole role above it is the
    // popover's `dialog`, which is not one. A red line the sighted user can see
    // and nobody else is told about is the defect this pins.
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('daemon GET failed (500)');
  });

  it('says it is reading while the agent has not answered yet', () => {
    renderWithLoader(pending());
    openMeter();

    expect(container.textContent).toContain('Reading the agent');
  });

  /**
   * A meter whose SUMMARY figure differs from the breakdown's.
   *
   * The shared `tree` uses 62,444 for both, which is exactly the collision
   * these two tests have to avoid: the whole question is which of the two
   * measurements is on screen, and one number cannot answer it. 340.3k against
   * a 62.4k breakdown is the reported pair's shape.
   */
  function renderDivergent(load: ChatMetricsLoader): void {
    render(
      <ChatMetricsLoaderContext.Provider value={load}>
        <ContextMeter
          contextTokens={340_300}
          contextWindowTokens={1_000_000}
          runId="run-1"
        />
      </ChatMetricsLoaderContext.Provider>,
    );
  }

  it('never shows the last-request figure and then swaps it for the /context one', async () => {
    // The reported jump: the summary is the prompt side of the LAST REQUEST,
    // the panel header is the agent's own `/context` reply, and putting the
    // first in the spot the second is about to take reads as one figure
    // correcting itself a beat later. One reading is shown, or none.
    //
    // Asserted across BOTH frames of one open — while the reading is in
    // flight, and once it has landed — because the defect is only visible as
    // the transition between them.
    let settle: (metrics: typeof METRICS) => void = () => undefined;
    renderDivergent(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    openMeter();

    // Frame one: reading in flight. The summary's own figure is absent.
    expect(container.textContent).toContain('Reading the agent');
    expect(container.textContent).not.toContain('340.3k');

    await act(async () => {
      settle(METRICS);
    });

    // Frame two: the breakdown's figure, and still not the summary's.
    expect(container.textContent).toContain('62.4k');
    expect(container.textContent).not.toContain('340.3k');
  });

  it('keeps the summary when no breakdown is coming — a failed fetch', async () => {
    // The counterweight to the suppression above: with the reading settled and
    // no breakdown to show, the summary is not a placeholder for a different
    // figure, it is the only figure there is. Withholding it there would leave
    // the panel with an error and nothing else.
    renderDivergent(() => Promise.reject(new Error('daemon GET failed (500)')));
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain('340.3k / 1M');
    expect(container.textContent).toContain('daemon GET failed (500)');
  });

  it('offers no readout at all for a meter with no run', async () => {
    const load = vi.fn().mockResolvedValue(METRICS);
    renderWithLoader(load, null);
    openMeter();
    await act(async () => {});

    expect(load).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('This thread');
  });

  it('keeps re-reading while the agent works, and stops once it settles', async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue(METRICS);
      // OPEN and LIVE: the panel is being watched while a turn runs.
      renderWithLoader(load, 'run-1', true);
      openMeter();
      await act(async () => {});
      expect(load).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(load).toHaveBeenCalledTimes(2);
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(load).toHaveBeenCalledTimes(3);

      // The turn settles: one final reading (the last turn's cost lands with
      // it), and then the timer is gone — a finished chat's figures cannot
      // change on their own, so re-reading it would ask a question whose answer
      // is already on screen.
      render(tree(load, 'run-1', false));
      await act(async () => {});
      const afterSettle = load.mock.calls.length;
      expect(afterSettle).toBe(4);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(load).toHaveBeenCalledTimes(afterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never re-reads a chat nobody is looking at, however live it is', async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue(METRICS);
      // LIVE but CLOSED — the readout is not open, so there is no reader to
      // keep current, and the read is a multi-second question to the agent.
      renderWithLoader(load, 'run-1', true);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });

      expect(load).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a turn is in progress instead of counting the thread as empty', async () => {
    // The reported reading: a live context window above, `0 turns` below, on a
    // thread whose agent was visibly working. The count is the daemon's sum
    // over FINISHED turns, so the first turn contributes nothing to it.
    const load = vi.fn().mockResolvedValue({
      ...METRICS,
      totals: { ...TOTALS, turns: 0, costUsd: null },
    });
    renderWithLoader(load, 'run-1', true);
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain('turn in progress');
    expect(container.textContent).not.toContain('0 turns');
  });

  it('keeps the finished count and names the running turn beside it', async () => {
    const load = vi.fn().mockResolvedValue(METRICS);
    renderWithLoader(load, 'run-1', true);
    openMeter();
    await act(async () => {});

    // Both, because both are true — and a count replaced by the phrase would
    // lose three turns' worth of spend from the line.
    expect(container.textContent).toContain('3 turns · 1 in progress');
  });

  it('leaves a settled thread reading exactly as it did', async () => {
    const load = vi.fn().mockResolvedValue(METRICS);
    renderWithLoader(load, 'run-1', false);
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain('3 turns');
    expect(container.textContent).not.toContain('in progress');
  });

  it('shows every plan window with its percentage and time to reset', async () => {
    // The deferred half of the context-readout report: "show claude
    // subscription limits per thread — the 5-hour window usage and the time
    // remaining". ALL the windows, not just the shortest: a five-hour window
    // refills over lunch while a seven-day one does not, so a readout showing
    // only the first tells a user they have room on the day they are cut off.
    // Offsets from NOW rather than a frozen clock: the panel reads the real
    // `Date.now()` on render, and fake timers here would have to survive the
    // loader's own promise. The extra 30s keeps the minute floor off the
    // boundary for the life of the test.
    const inMinutes = (minutes: number): string =>
      new Date(Date.now() + minutes * 60_000 + 30_000).toISOString();
    renderWithLoader(() =>
      Promise.resolve({
        ...METRICS,
        plan: {
          plan: 'max',
          windows: [
            {
              key: 'session',
              label: 'Current session',
              percent: 43,
              resetsAt: inMinutes(3 * 60 + 50),
            },
            {
              key: 'weekly_all',
              label: 'Current week',
              percent: 30,
              resetsAt: inMinutes(5 * 24 * 60 + 3 * 60),
            },
          ],
        },
        planReason: null,
        takenAt: null,
      }),
    );
    openMeter();
    await act(async () => {});

    const text = container.textContent ?? '';
    expect(text).toContain('Plan limits');
    expect(text).toContain('max');
    expect(text).toContain('Current session');
    expect(text).toContain('43% · resets in 3h 50m');
    // The second window, and the DAY tier — a seven-day reset is routinely
    // days out, and `115h 50m` is a number nobody converts.
    expect(text).toContain('Current week');
    expect(text).toContain('30% · resets in 5d 3h');
    expect(container.querySelectorAll('[data-plan-window]')).toHaveLength(2);
  });

  it('DATES a reading whose agent has since been closed, and drops the re-read claim', async () => {
    // The figures are real and the moment is not now: they were taken on the
    // way out of a process that has since been closed, and the standing caption
    // ("as of the last thing said in this chat") describes a live reading
    // only. Saying it
    // over a stored one is the same lie as the sentence this whole fix started
    // from — a panel promising a reading nobody was going to take.
    renderWithLoader(() =>
      Promise.resolve({
        ...METRICS,
        takenAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      }),
    );
    openMeter();
    await act(async () => {});

    const text = container.textContent ?? '';
    expect(text).toContain('before its process was closed');
    expect(text).toContain('(3h)');
    expect(text).toContain('Send a message to take a fresh one');
    expect(text).not.toContain('as of the last thing said');
    // ...and the figures themselves are still drawn, which is the whole point.
    // A category from the BREAKDOWN, which stays open — the drill-downs below
    // it are folded by default.
    expect(text).toContain('System prompt');
  });

  it('puts the plan limits ABOVE the per-server drill-down', async () => {
    // "the weekly-limits feature — I open it on claude and see nothing": the
    // section was last in a 26rem scroll box, under one row per instruction
    // file and one per MCP SERVER. With a dozen servers that is a screen and a
    // half below the fold, and the popover's own bottom edge reads as the end
    // of the content.
    renderWithLoader(() =>
      Promise.resolve({
        ...METRICS,
        plan: {
          plan: 'max',
          windows: [
            {
              key: 'weekly_all',
              label: 'Current week',
              percent: 60,
              resetsAt: new Date(
                Date.now() + 4 * 24 * 60 * 60_000,
              ).toISOString(),
            },
          ],
        },
        planReason: null,
        takenAt: null,
      }),
    );
    openMeter();
    await act(async () => {});

    const headings = [...container.querySelectorAll('span')]
      .map((el) => el.textContent ?? '')
      .filter((text) =>
        ['Plan limits', 'MCP servers', 'Instructions'].includes(text),
      );
    expect(headings[0]).toBe('Plan limits');
    // …and the drill-down is still there, below it — moved, not dropped.
    expect(headings).toContain('MCP servers');
    expect(headings).toContain('Instructions');
  });

  it('says WHY there are no plan limits instead of leaving the section out', async () => {
    // The same rule the breakdown follows: an absent reading with no sentence
    // is the blank space a stated reason exists to
    // replace — and here it would read as "this account has no limits".
    renderWithLoader(() =>
      Promise.resolve({
        ...METRICS,
        plan: null,
        planReason: 'cursor-agent does not report its plan limits',
        takenAt: null,
      }),
    );
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain('Plan limits');
    expect(container.textContent).toContain(
      'cursor-agent does not report its plan limits',
    );
    // And no bar under it — a 0% track beside that sentence is exactly the
    // "no limits" reading it exists to prevent.
    expect(container.querySelectorAll('[data-plan-window]')).toHaveLength(0);
  });

  it('keeps the summary alone when nothing provided a loader', async () => {
    // The meter predates this panel and must still work outside its provider.
    render(
      <ContextMeter
        contextTokens={62_444}
        contextWindowTokens={1_000_000}
        runId="run-1"
      />,
    );
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain('62.4k / 1M');
    expect(container.textContent).not.toContain('This thread');
  });
});
