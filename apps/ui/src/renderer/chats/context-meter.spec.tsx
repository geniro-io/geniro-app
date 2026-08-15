// @vitest-environment jsdom
import { act } from 'react';
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

  it('renders nothing when there is nothing to say AND no reason for it', () => {
    // A turn that has yet to report anything: a moment, not a fact, so there is
    // nothing to explain and no spot to hold.
    render(<ContextMeter contextTokens={null} contextWindowTokens={null} />);
    expect(container.textContent).toBe('');
  });

  it('holds the spot and SAYS WHY when the CLI never reports usage', () => {
    // This is the reported defect. cursor-agent sends no `usage_update` and its
    // prompt reply carries no usage (measured 2026-08-12 on 2026.08.11-e8db854
    // from a raw frame capture), so its meter is permanently empty — and it
    // rendered as a blank gap beside a claude card with a ring, which is exactly
    // the question the user asked: "why don't I see context here?"
    const reason = 'cursor-agent reports no token or cost usage over ACP';
    render(
      <ContextMeter
        contextTokens={null}
        contextWindowTokens={null}
        unavailableReason={reason}
      />,
    );

    // Present, and the reason IS the control's accessible name — so it is
    // reachable by keyboard and by screen reader, not by hover alone.
    expect(meterLabel()).toBe(reason);
    expect(ring()).not.toBeNull();
    // An EMPTY ring: a fraction here would be a reading nobody reported.
    expect(ring()?.getAttribute('aria-hidden')).toBe('true');

    openMeter();
    expect(container.textContent).toContain(reason);
  });

  it('shows the FIGURES, not the reason, once a CLI has reported any', () => {
    // The reason is about a permanent absence. A CLI that reports usage can
    // still be between turns, and printing "never reports usage" over a real
    // reading would be false — so the figures win whenever they exist.
    render(
      <ContextMeter
        contextTokens={50_000}
        contextWindowTokens={200_000}
        unavailableReason="this should not be reachable"
      />,
    );
    expect(meterLabel()).toBe('Context 25% full — 50k of 200k');
    expect(container.textContent).not.toContain('should not be reachable');
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

describe('the expanded readout the meter opens onto', () => {
  const TOTALS = {
    turns: 3,
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
    totals: TOTALS,
  };

  /** A never-settling loader, for the states BEFORE a reply lands. */
  function pending(): ChatMetricsLoader {
    return () => new Promise(() => {});
  }

  function renderWithLoader(
    load: ChatMetricsLoader,
    runId: string | null = 'run-1',
  ): void {
    render(
      <ChatMetricsLoaderContext.Provider value={load}>
        <ContextMeter
          contextTokens={62_444}
          contextWindowTokens={1_000_000}
          runId={runId}
        />
      </ChatMetricsLoaderContext.Provider>,
    );
  }

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

  it('names the instructions and the MCP servers that are filling the window', async () => {
    renderWithLoader(() => Promise.resolve(METRICS));
    openMeter();
    await act(async () => {});

    const text = container.textContent ?? '';
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

  it('surfaces a failed fetch instead of an empty panel', async () => {
    renderWithLoader(() =>
      Promise.reject(new Error('daemon GET failed (500)')),
    );
    openMeter();
    await act(async () => {});

    expect(container.textContent).toContain('daemon GET failed (500)');
  });

  it('says it is reading while the agent has not answered yet', () => {
    renderWithLoader(pending());
    openMeter();

    expect(container.textContent).toContain('Reading the agent');
  });

  it('offers no readout at all for a meter with no run', async () => {
    const load = vi.fn().mockResolvedValue(METRICS);
    renderWithLoader(load, null);
    openMeter();
    await act(async () => {});

    expect(load).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('This thread');
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
