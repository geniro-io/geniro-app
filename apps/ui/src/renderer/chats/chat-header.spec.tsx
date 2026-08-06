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
});
