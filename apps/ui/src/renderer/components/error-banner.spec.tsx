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

  it('speaks quietly when the strip is a warning, not a failure', () => {
    // Same strip, same place, same dismiss — a guard that refused to switch
    // branch over uncommitted work is the app working, and red said the
    // opposite. The dismiss control follows the tone, since "Dismiss error" on
    // a strip reporting no error is a lie a screen-reader user cannot check.
    render({ tone: 'warning', message: 'Uncommitted changes in this folder' });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.className).toContain('text-warning');
    expect(alert?.className).not.toContain('text-destructive');
    expect(
      container.querySelector('button[aria-label="Dismiss warning"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Dismiss error"]'),
    ).toBeNull();
  });

  it('stays a red error by default — every existing caller is untouched', () => {
    render();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.className).toContain('text-destructive');
    expect(
      container.querySelector('button[aria-label="Dismiss error"]'),
    ).not.toBeNull();
  });

  it('renders a recovery action before the dismiss control', () => {
    // Order is the point: the way out reads first, the close last.
    render({ action: <button type="button">Delete this run</button> });

    const labels = [...container.querySelectorAll('button')].map(
      (button) => button.textContent || button.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Delete this run', 'Dismiss error']);
  });

  it('carries its own surface, in the tone it is speaking in', () => {
    // Reported as "a lot of margin between text and icon", and the margin was
    // never the defect: with no fill the strip was bare text and a ✕ on the
    // page's own ground, measured 224px apart in a 420px strip and a whole
    // content column apart on Stats. The fill is what ties the two ends into
    // one object, so the far-edge close reads as this strip's.
    //
    // Pinned on the CLASS because jsdom computes neither layout nor cascade —
    // and the class IS the whole of the change, not a proxy for it.
    render();
    expect(container.querySelector('[data-tone="error"]')?.className).toContain(
      'bg-destructive/10',
    );

    render({ tone: 'warning' });
    const strip = container.querySelector('[data-tone="warning"]')?.className;
    expect(strip).toContain('bg-warning/10');
    expect(strip).not.toContain('bg-destructive/10');
  });

  it('lets a caller inset it without eating the padding it now owns', () => {
    // The padding is the component's, so a caller positions with MARGIN. This
    // pins the merge order rather than the callers: a `className` arriving
    // last must not be able to strip the strip's own inset.
    render({ className: 'mx-3 mb-1' });

    const strip = container.querySelector('[data-tone="error"]')?.className;
    expect(strip).toContain('px-3');
    expect(strip).toContain('py-2');
    expect(strip).toContain('mx-3');
  });

  it('omits the action slot entirely when there is no way out to offer', () => {
    render();

    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
});
