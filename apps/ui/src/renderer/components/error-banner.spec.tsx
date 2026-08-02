// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBanner } from './error-banner';

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

type Props = React.ComponentProps<typeof ErrorBanner>;

function render(props: Partial<Props> = {}): void {
  act(() => {
    root.render(
      <ErrorBanner message="daemon down" onDismiss={vi.fn()} {...props} />,
    );
  });
}

describe('ErrorBanner', () => {
  it('announces the failure to assistive tech', () => {
    // The strip appears without any focus change, so the alert role is the
    // only thing that reports it to a screen reader at all.
    render();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('daemon down');
  });

  it('closes on the dismiss control', () => {
    const onDismiss = vi.fn();
    render({ onDismiss });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')
        ?.click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders a recovery action before the dismiss control', () => {
    // Order is the point: the way out reads first, the close last.
    render({ action: <button type="button">Delete this run</button> });

    const labels = [...container.querySelectorAll('button')].map(
      (button) => button.textContent || button.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Delete this run', 'Dismiss error']);
  });

  it('omits the action slot entirely when there is no way out to offer', () => {
    render();

    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
});
