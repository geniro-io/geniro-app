// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentsPanel } from './agents-panel';
import { ChatHeader } from './chat-header';
import { ContextMeter } from './context-meter';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
      .querySelector('button[aria-expanded]')
      ?.getAttribute('aria-label') ?? null
  );
}

/** The ring itself — decorative now, so it is found by tag, not by role. */
function ring(): SVGElement | null {
  return container.querySelector('svg');
}

function openMeter(): void {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-expanded]',
  );
  act(() => trigger?.click());
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

  it('shows the count bare when the CLI named no window', () => {
    // No assumed denominator. Substituting a flat 200k made a 1M-window model
    // read as a fifth full before its first turn had finished — the count is
    // true, the fraction would not have been.
    //
    // And it stays ON SCREEN here, unlike the ring case: with no ring there is
    // nothing to hover, so hiding it would leave the user with nothing at all.
    render(<ContextMeter contextTokens={100_000} contextWindowTokens={null} />);
    expect(meterLabel()).toBeNull();
    expect(ring()).toBeNull();
    expect(container.textContent).toContain('ctx 100k');
    expect(container.textContent).not.toContain('/');
  });

  it('treats a zero window as no window at all', () => {
    // A window of 0 is not a window — it reaches here as a plain number
    // (`readClaudeUsage` passes `contextWindow` through, and the panel keeps
    // any number it is given), and dividing by it puts "Infinity" in the one
    // place the figure is legible.
    render(<ContextMeter contextTokens={100_000} contextWindowTokens={0} />);
    expect(ring()).toBeNull();
    expect(container.textContent).toContain('ctx 100k');
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

  it('renders nothing when there is nothing to say', () => {
    render(<ContextMeter contextTokens={null} contextWindowTokens={null} />);
    expect(container.textContent).toBe('');
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
        sidePanelOpen={false}
        onToggleSidePanel={vi.fn()}
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

    const panel = container.querySelector('[role="dialog"]');
    expect(panel?.className).toContain('bottom-full');
    expect(panel?.className).not.toContain('top-full');
  });

  it('still opens downward where there IS room, so the panel call site is untouched', () => {
    render(<ContextMeter {...CONTEXT} />);
    openMeter();

    const panel = container.querySelector('[role="dialog"]');
    expect(panel?.className).toContain('top-full');
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
        onClose={vi.fn()}
      />,
    );

    expect(meterLabel()).toBe('Context 25% full — 250k of 1M');
  });
});
