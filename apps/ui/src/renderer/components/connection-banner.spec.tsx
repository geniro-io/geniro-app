// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionBanner } from './connection-banner';

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

type Props = React.ComponentProps<typeof ConnectionBanner>;

function render(props: Partial<Props> = {}): void {
  act(() => {
    root.render(
      <ConnectionBanner reason={null} onRetry={vi.fn()} {...props} />,
    );
  });
}

describe('ConnectionBanner', () => {
  it('shows the daemon’s own reason rather than a generic failure', () => {
    // The whole point: "connection refused" (nothing is running) and an
    // authentication failure (a stale handle after a restart) need different
    // things from the user, and only the reported reason tells them apart.
    // Before this strip existed, neither reached the screen at all — a 6px
    // status dot changed colour and every view simply did nothing.
    render({ reason: 'xhr poll error: connect ECONNREFUSED 127.0.0.1:47615' });

    expect(container.textContent).toContain('ECONNREFUSED');
    expect(container.textContent).toContain('127.0.0.1:47615');
  });

  it('still says something when no reason has been reported yet', () => {
    // A first attempt can fail before Socket.IO has any wording for it. An
    // empty strip would be worse than none — it would look like a render bug.
    render({ reason: null });

    expect(container.textContent).toContain('Not connected');
    expect(container.textContent!.trim().length).toBeGreaterThan(20);
  });

  it('announces itself politely, not as an interruption', () => {
    // `status`, not `alert`. This is a standing condition, and it re-renders
    // on every retry — `alert` would re-interrupt a screen reader each time.
    render();

    const strip = container.querySelector('[role="status"]');
    expect(strip).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers a retry, and disables it while one is in flight', () => {
    // Without this the only recovery is restarting the app: nothing else in
    // the UI re-reads the daemon handle.
    const onRetry = vi.fn();
    render({ onRetry });

    const retry = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Retry'),
    )!;
    expect(retry.disabled).toBe(false);
    act(() => {
      retry.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);

    render({ onRetry, retrying: true });
    const busy = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Retry'),
    )!;
    expect(busy.disabled).toBe(true);
  });

  it('carries NO dismiss control', () => {
    // Deliberately unlike ErrorBanner. The strip IS the connection state, so
    // dismissing it would hide a fact that is still true; it clears itself
    // when the socket opens and not before.
    render({ reason: 'connect ECONNREFUSED' });

    expect(container.querySelector('[aria-label="Dismiss error"]')).toBeNull();
  });
});
