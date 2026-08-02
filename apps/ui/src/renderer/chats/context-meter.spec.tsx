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

/** The ring's accessible name, which is where its percentage is legible. */
function ringLabel(): string | null {
  return (
    container.querySelector('svg[role="img"]')?.getAttribute('aria-label') ??
    null
  );
}

describe('ContextMeter', () => {
  it('scales against the model’s OWN window, not an assumed one', () => {
    // A 1M-window model at 250k is a quarter full. Measuring it against the
    // 200k default would report it as over capacity.
    render(
      <ContextMeter contextTokens={250_000} contextWindowTokens={1_000_000} />,
    );
    expect(ringLabel()).toBe('Context 25% full');
    expect(container.textContent).toContain('ctx 250k / 1M');
  });

  it('falls back to the assumed window only when the CLI named none', () => {
    render(<ContextMeter contextTokens={100_000} contextWindowTokens={null} />);
    expect(ringLabel()).toBe('Context 50% full');
  });

  it('treats a zero window as no window at all', () => {
    // A window of 0 is not a window — it reaches here as a plain number
    // (`readClaudeUsage` passes `contextWindow` through, and the panel keeps
    // any number it is given), and dividing by it puts "Infinity" in the one
    // place the figure is legible.
    render(<ContextMeter contextTokens={100_000} contextWindowTokens={0} />);
    expect(ringLabel()).toBe('Context 50% full');
    expect(container.textContent).toContain('ctx 100k / 200k');
  });

  it('runs green, then yellow, then red — AT the 70% and 90% marks', () => {
    // A traffic light, so the boundaries themselves are the promise: green
    // below 70, yellow from 70 to under 90, red from 90. Sampling only 50/75/95
    // would pass with either threshold shifted by several points.
    const tone = (percent: number): string => {
      render(
        <ContextMeter
          contextTokens={percent * 2_000}
          contextWindowTokens={200_000}
        />,
      );
      return (
        container.querySelector('svg[role="img"]')?.getAttribute('class') ?? ''
      );
    };
    expect(tone(69)).toContain('text-success');
    expect(tone(70)).toContain('text-warning');
    expect(tone(89)).toContain('text-warning');
    expect(tone(90)).toContain('text-destructive');
  });

  it('renders nothing when there is nothing to say', () => {
    render(<ContextMeter contextTokens={null} contextWindowTokens={null} />);
    expect(container.textContent).toBe('');
  });

  it('draws the percentage INSIDE the ring, units and all', () => {
    // Everywhere the meter appears, not just the header: a ring whose figure
    // is only in its accessible name is a decoration to a sighted user, and
    // the bare number read as an unlabelled count of something.
    render(
      <ContextMeter contextTokens={50_000} contextWindowTokens={200_000} />,
    );
    expect(container.querySelector('svg text')?.textContent).toBe('25%');
  });

  it('shrinks the label’s type so it stays inside the ring', () => {
    // "9%" and "100%" go through the same 22px well. A fixed ratio seats the
    // short one and spills the long one over the arc, which is what makes this
    // worth pinning rather than eyeballing once.
    const fontSize = (): number =>
      Number(container.querySelector('svg text')?.getAttribute('font-size'));
    render(
      <ContextMeter contextTokens={2_000} contextWindowTokens={200_000} />,
    );
    const short = fontSize();
    render(
      <ContextMeter contextTokens={200_000} contextWindowTokens={200_000} />,
    );
    expect(container.querySelector('svg text')?.textContent).toBe('100%');
    expect(fontSize()).toBeLessThan(short);
  });
});

describe('the header and the panel read the SAME meter', () => {
  const CONTEXT = { contextTokens: 250_000, contextWindowTokens: 1_000_000 };

  it('reports identical numbers in both places', () => {
    // Structural, not a coincidence to re-assert: both render ContextMeter, so
    // they cannot drift. The panel used to own the only copy and the header
    // had no readout at all.
    render(
      <ChatHeader
        label="My chat"
        isWorkflow={false}
        status="running"
        lastActivityAt={new Date().toISOString()}
        {...CONTEXT}
        sidePanelOpen={false}
        onToggleSidePanel={vi.fn()}
      />,
    );
    const headerLabel = ringLabel();
    const headerText = container.textContent ?? '';

    render(
      <AgentsPanel
        agents={[
          {
            id: 'agent',
            name: 'claude',
            agent: 'claude',
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
    expect(ringLabel()).toBe(headerLabel);
    expect(container.textContent).toContain('ctx 250k / 1M');
    expect(headerText).toContain('ctx 250k / 1M');
  });
});
