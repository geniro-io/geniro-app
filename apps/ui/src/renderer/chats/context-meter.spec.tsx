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

  it('warns and then alarms as the window fills', () => {
    const tone = (): string =>
      container.querySelector('svg[role="img"]')?.getAttribute('class') ?? '';
    render(
      <ContextMeter contextTokens={100_000} contextWindowTokens={200_000} />,
    );
    expect(tone()).toContain('text-primary');
    render(
      <ContextMeter contextTokens={150_000} contextWindowTokens={200_000} />,
    );
    expect(tone()).toContain('text-warning');
    render(
      <ContextMeter contextTokens={190_000} contextWindowTokens={200_000} />,
    );
    expect(tone()).toContain('text-destructive');
  });

  it('renders nothing when there is nothing to say', () => {
    render(<ContextMeter contextTokens={null} contextWindowTokens={null} />);
    expect(container.textContent).toBe('');
  });

  it('draws the percent inside the ring only where asked', () => {
    render(
      <ContextMeter
        contextTokens={50_000}
        contextWindowTokens={200_000}
        showPercent
      />,
    );
    expect(container.querySelector('svg text')?.textContent).toBe('25');
    render(
      <ContextMeter contextTokens={50_000} contextWindowTokens={200_000} />,
    );
    expect(container.querySelector('svg text')).toBeNull();
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
