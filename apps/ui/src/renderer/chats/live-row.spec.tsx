// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ComposingRow,
  formatElapsed,
  liveRowKind,
  RunActivityContext,
  ThinkingRow,
  WorkingRow,
} from './live-row';

// `ThinkingRow`'s text shape renders a bounded, tail-following box
// (`ThinkingScroller`), and jsdom implements no element scrolling at all — the
// same stub `Chats.spec.tsx` installs for the transcript's own auto-scroll.
Element.prototype.scrollTo = vi.fn();

const roots: Root[] = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(node);
  });
  return container;
}

/** Unmount everything this test rendered, inside `act`. */
function unmountAll(): void {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
}

/** Advance both the wall clock and the interval that reads it. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  unmountAll();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('formatElapsed', () => {
  it('counts seconds, then minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(9_400)).toBe('9s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
  });

  it('rolls into HOURS rather than counting minutes forever', () => {
    // The reported header, verbatim: `worked 128m 57s / 14 turns`. Minutes were
    // unbounded, so a long thread reported a figure nobody reads as a duration
    // without dividing by 60 themselves.
    expect(formatElapsed(7_737_000)).toBe('2h 8m 57s');
    // The boundary in both directions — 59m is still minutes, 60m is an hour.
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe('59m 59s');
    expect(formatElapsed(60 * 60_000)).toBe('1h 0m 0s');
  });

  it('keeps hours unbounded rather than inventing a day tier', () => {
    // Stated because it is a CHOICE, not an oversight: one more unit is one
    // more case, and nothing in the app has produced a day of working time.
    expect(formatElapsed(25 * 60 * 60_000 + 3 * 60_000 + 40_000)).toBe(
      '25h 3m 40s',
    );
  });

  it('never reports a negative age', () => {
    // A clock skew between the daemon's `thinkingSince` and this machine can
    // put the anchor in the future; "-3s" would be the one reading that is
    // certainly wrong.
    expect(formatElapsed(-4_000)).toBe('0s');
  });
});

describe('liveRowKind', () => {
  it('recognises only the three live markers', () => {
    expect(liveRowKind({ live: 'thinking' })).toBe('thinking');
    expect(liveRowKind({ live: 'working' })).toBe('working');
    expect(liveRowKind({ live: 'composing' })).toBe('composing');
    expect(liveRowKind({ live: 'something-else' })).toBeNull();
    // A DURABLE reasoning item carries text and no marker — it must never be
    // mistaken for a live row, or persisted history would render as a spinner.
    expect(liveRowKind({ text: 'I considered…' })).toBeNull();
    expect(liveRowKind(null)).toBeNull();
    expect(liveRowKind('nope')).toBeNull();
  });
});

describe('ThinkingRow', () => {
  it('counts real seconds while nothing new arrives', () => {
    // The defect: elapsed was computed inside the transcript fold, so it only
    // advanced when a delta happened to re-render — the counter jumped (30s →
    // 34s) instead of ticking. Nothing below changes a prop; the row must move
    // on its own or this assertion fails.
    vi.setSystemTime(new Date('2026-08-04T00:00:10Z'));
    const container = render(
      <ThinkingRow since={Date.parse('2026-08-04T00:00:00Z')} tokens={300} />,
    );
    expect(container.textContent).toContain('10s');

    advance(3_000);
    expect(container.textContent).toContain('13s');

    advance(1_000);
    expect(container.textContent).toContain('14s');
  });

  it('shows the stretch’s own token count', () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(<ThinkingRow since={Date.now()} tokens={1_400} />);
    expect(container.textContent).toContain('1.4k tokens');
  });

  it('stops ticking once it leaves the transcript', () => {
    // A turn lands many stretches; a row that kept its intervals after unmount
    // would leak them per stretch for the life of the chat. TWO now — the
    // clock and the rotating word — and the point of the assertion is that
    // BOTH are released, so the count is read rather than the fact of any
    // timer remaining.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    render(<ThinkingRow since={Date.now()} tokens={1} />);
    expect(vi.getTimerCount()).toBe(2);

    unmountAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens on the plain word and only then wanders', () => {
    // The rule `live-words.ts` states: a row renders its canonical word, so a
    // short stretch and a screenshot of one read exactly as they always have,
    // and the vocabulary only starts moving once the wait is long enough to be
    // worth watching. It is also what keeps this row's first word the same one
    // the sidebar badge beside it says.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(<ThinkingRow since={Date.now()} tokens={250} />);
    expect(container.textContent).toContain('Thinking…');

    advance(3_000);
    expect(container.textContent).not.toContain('Thinking…');
    // Still a word and still the same row — the tokens and the clock are
    // untouched by the rotation.
    expect(container.textContent).toContain('250 tokens');
  });
});

describe('WorkingRow', () => {
  it('counts from the anchor it was GIVEN, not from the moment it appears', () => {
    // The reported defect: the clock started at mount, so switching to another
    // chat and back remounted the row and reported a four-minute wait as one
    // second. The anchor is the last row the agent put on screen, which the
    // caller reads out of the transcript — durable, so it survives a tab switch,
    // a reload and a reconnect alike.
    vi.setSystemTime(new Date('2026-08-04T00:04:00Z'));
    const since = Date.parse('2026-08-04T00:00:00Z');
    const container = render(<WorkingRow since={since} />);

    expect(container.textContent).toContain('4m 0s');

    advance(7_000);
    expect(container.textContent).toContain('4m 7s');
  });

  it('re-reports the same elapsed when it is remounted', () => {
    // The tab switch, stated as a test: a fresh mount of the same row must not
    // reset the number. Two independent renders of one anchor — which is what a
    // remount is — have to agree.
    vi.setSystemTime(new Date('2026-08-04T00:04:00Z'));
    const since = Date.parse('2026-08-04T00:00:00Z');

    expect(render(<WorkingRow since={since} />).textContent).toContain('4m 0s');
    unmountAll();
    expect(render(<WorkingRow since={since} />).textContent).toContain('4m 0s');
  });

  it('counts up from its own mount when there is no anchor to read', () => {
    // An agent with no durable row yet — its very first stretch — has no
    // transcript to be anchored to, and mount is then the only honest answer.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(<WorkingRow />);
    expect(container.textContent).toContain('Working…');
    expect(container.textContent).toContain('0s');

    advance(7_000);
    expect(container.textContent).toContain('7s');
  });

  it('names what the agent is doing when the daemon has said', () => {
    // "Working…" describes a state without describing the work, which is the
    // complaint: it cannot tell a long compaction from a hung tool.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(
      <RunActivityContext.Provider value="running Bash">
        <WorkingRow />
      </RunActivityContext.Provider>,
    );

    expect(container.textContent).toContain('running Bash');
    // The clock is the half the daemon cannot supply, so it stays.
    expect(container.textContent).toContain('0s');
    // …and the abstract label it replaces is gone, not merely appended to.
    expect(container.textContent).not.toContain('Working…');
  });

  it('says WHOSE answer it is blocked on, over the run activity', () => {
    // The line exists for a caller parked in `await_agent`, which sits silent
    // for minutes: a bare "Working…" there reads as a hang, with the callee's
    // own rows streaming one card below and nothing connecting the two. It
    // OUTRANKS the run's activity phrase on purpose — the announce describes
    // the RUN, and the truest thing about this agent is whose answer it awaits.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(
      <RunActivityContext.Provider value="running Bash">
        <WorkingRow waitingOn={{ callId: 'call-1', callee: 'Poet' }} />
      </RunActivityContext.Provider>,
    );

    expect(container.textContent).toContain('waiting on Poet · call-1');
    expect(container.textContent).not.toContain('running Bash');
    expect(container.textContent).not.toContain('Working…');
  });

  it('names the call a callee is working in, over the run activity', () => {
    // The row that stands at the END of the transcript for a callee whose call
    // card the conversation has moved past: the card is out of view, so the row
    // has to say which call is still running.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(
      <RunActivityContext.Provider value="running Bash">
        <WorkingRow workingIn={{ callId: 'call-3', callee: 'Poet' }} />
      </RunActivityContext.Provider>,
    );

    expect(container.textContent).toContain('Poet is working · call-3');
    expect(container.textContent).not.toContain('running Bash');
  });

  it('names a callee it has no name for rather than dropping the line', () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(
      <WorkingRow waitingOn={{ callId: 'call-9', callee: null }} />,
    );

    expect(container.textContent).toContain(
      'waiting on a called agent · call-9',
    );
  });

  it('caps a long phrase to one truncated half-row, clock intact', () => {
    // The reported defect, twice over: a shell tool's "name" is the WHOLE
    // command, so `running <command>` filled eight wrapped lines of the
    // transcript — and even on one line it ran the full width of the column.
    // The phrase is capped and ellipsized; the clock beside it is not, which is
    // what a single truncated label could not express.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const command =
      'running `cd /Users/me/Desktop/Projects/workspace/example-app && git checkout --ours packages/document-pdf/src/limits/render-limits.ts packages/document-pdf/src/images/pdf-safe-image-format.ts`';
    const container = render(
      <RunActivityContext.Provider value={command}>
        <WorkingRow since={Date.parse('2026-08-04T00:00:00Z') - 11_000} />
      </RunActivityContext.Provider>,
    );

    const phrase = [...container.querySelectorAll('span')].find(
      (span) => span.textContent === command,
    );
    expect(phrase).toBeDefined();
    // One line, ellipsized, and never more than most of the row.
    expect(phrase?.className).toContain('truncate');
    expect(phrase?.className).toContain('max-w-[70%]');
    // …and that fraction is a fraction of something: a percentage max-width
    // resolves to nothing against a shrink-to-fit bubble, so the row itself
    // must be full width for the cap above to mean anything at all.
    expect(container.querySelector('[data-role="live"]')?.className).toContain(
      'w-full',
    );
    // Cut on screen, but not LOST — the whole command is still readable.
    expect(phrase?.getAttribute('title')).toBe(command);
    // The clock is a SIBLING, so the cap can never eat it: it is the half
    // nothing can make long, and the half that says the turn is still moving.
    expect(phrase?.textContent).not.toContain('11s');
    expect(container.textContent).toContain('11s');
  });

  it('falls back to the bare state when the daemon has said nothing', () => {
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(
      <RunActivityContext.Provider value={null}>
        <WorkingRow />
      </RunActivityContext.Provider>,
    );

    expect(container.textContent).toContain('Working…');
  });
});

describe('both live rows wear the LIVE row chrome, with a loader', () => {
  it.each([
    ['thinking', <ThinkingRow key="t" since={Date.now()} tokens={250} />],
    ['working', <WorkingRow key="w" />],
  ])('%s', (_word, node) => {
    // Neither row is the agent speaking — both are geniro narrating the state of
    // a turn — so neither wears the filled `reasoning` bubble: at the
    // assistant's weight that read as a message with content. But they ARE the
    // agent's column still filling, and they are followed by the very bubble
    // they turn into, which is why they sit at its left edge rather than
    // centred like a `note`. REPORTED as the progress of a turn being the one
    // thing on screen not aligned with the turn.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(node);

    const row = container.querySelector('[data-role="live"]');
    expect(row).not.toBeNull();
    // Left-aligned and quiet: in the agent's column, not a bubble in it, and
    // never centred chrome.
    expect(row?.className).toContain('self-start');
    expect(row?.className).not.toContain('self-center');
    expect(row?.className).not.toContain('text-center');
    expect(row?.className).not.toContain('bg-muted/50');
    // …and no italic either: the row it has to look like is the plain
    // "✓ done · $1.3306" note beside it.
    expect(container.innerHTML).not.toContain('italic');
    // The one thing a `note` alone cannot say: this line is about work still
    // running, so it will change.
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('the live rows say their state exactly once', () => {
  it.each([
    ['thinking', <ThinkingRow key="t" since={Date.now()} tokens={250} />],
    ['working', <WorkingRow key="w" />],
  ])('%s', (word, node) => {
    // Both rows rode MessageBubble's `role` caption, which prints its value in
    // uppercase above the body — so a row read "THINKING" over "Thinking… 250
    // tokens · 12s". Every other bubble needs that caption because its body is
    // the agent's own words; these two already name their state.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const container = render(node);

    const occurrences =
      (container.textContent ?? '').toLowerCase().split(word).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('ThinkingRow — a CLI that discloses what it is thinking', () => {
  it('shows the reasoning text as it arrives, with a clock beside it', () => {
    // REPORTED against a cursor chat reading "Working… · 3m 8s" with nothing
    // happening, while the agent streamed thought chunks the whole time. The
    // words are the point: a clock alone cannot tell a long think from a hang.
    const container = render(
      <ThinkingRow
        since={Date.now() - 62_000}
        tokens={0}
        text="listing out the first 40 primes"
      />,
    );

    expect(container.textContent).toContain('listing out the first 40 primes');
    expect(container.textContent).toContain('1m 2s');
    // NEVER the token count: this CLI reports none, and "0 tokens" is a figure
    // nobody measured.
    expect(container.textContent).not.toContain('tokens');
  });

  it('keeps the token-count row for a CLI that REDACTS its thinking', () => {
    // Headless claude ships the block empty, so the running total is the whole
    // signal — this row must not become the text one for it.
    const container = render(
      <ThinkingRow since={Date.now() - 4_000} tokens={250} />,
    );

    expect(container.textContent).toContain('250 tokens');
    expect(container.textContent).toContain('4s');
  });

  it('ticks the clock while the text is still being written', () => {
    const container = render(
      <ThinkingRow since={Date.now()} tokens={0} text="working it out" />,
    );
    expect(container.textContent).toContain('0s');

    advance(3_000);

    expect(container.textContent).toContain('3s');
  });
});

describe('ComposingRow', () => {
  it('sits in the agent’s column, drawing the card that is coming', () => {
    const container = render(<ComposingRow kind="chart" bytes={2048} />);

    const row = container.querySelector('[data-role="live"]');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('self-start');
    expect(
      container
        .querySelector('[data-slot="composing-card"]')
        ?.getAttribute('data-kind'),
    ).toBe('chart');
    expect(container.textContent).toContain('2.0 KB');
  });

  it('carries NO clock, unlike its two siblings', () => {
    // Those rows count a silence nobody can otherwise see. This one has a
    // better reading — the bytes written, which climb, are specific to the work
    // and are the only thing that can tell a model still producing from one
    // that has stopped. A clock beside them would be a second, vaguer answer.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    render(<ComposingRow kind="artifact" />);
    // The seconds tick is what every clocked row owns; this one starts none.
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('live rows do not change their word in unison', () => {
  it('gives each row its own PHASE inside the cycle', () => {
    // MEASURED in the running renderer with eleven live rows up: they mount in
    // one commit, so a shared period had every word on the page change — and
    // play its 260ms fade — at the same instant, which reads as the app
    // glitching rather than as agents working. `Math.random` is stubbed so the
    // two rows below take a near and a far phase; with the stagger removed,
    // neither changes until the full cycle and the first assertion fails.
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    const randoms = [0, 0.1, 0, 0.9];
    const random = vi
      .spyOn(Math, 'random')
      .mockImplementation(() => randoms.shift() ?? 0);
    try {
      const first = render(<ThinkingRow since={Date.now()} tokens={1} />);
      const second = render(<ThinkingRow since={Date.now()} tokens={1} />);
      expect(first.textContent).toContain('Thinking…');
      expect(second.textContent).toContain('Thinking…');

      // Past the NEAR row's phase (0.1 × 2800 ≈ 280ms) and well short of the
      // far one's (0.9 × 2800 ≈ 2520ms).
      advance(400);
      expect(first.textContent).not.toContain('Thinking…');
      expect(second.textContent).toContain('Thinking…');

      advance(2_400);
      expect(second.textContent).not.toContain('Thinking…');
    } finally {
      random.mockRestore();
    }
  });
});
