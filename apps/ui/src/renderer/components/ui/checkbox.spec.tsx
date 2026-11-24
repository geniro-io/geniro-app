// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Checkbox, CheckIndicator } from './checkbox';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function render(node: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

function indicatorOf(el: ParentNode): HTMLElement {
  const indicator = el.querySelector('[data-slot="check-indicator"]');
  if (!(indicator instanceof HTMLElement)) {
    throw new Error('no check indicator rendered');
  }
  return indicator;
}

function checkboxOf(el: ParentNode): HTMLButtonElement {
  const button = el.querySelector('[role="checkbox"]');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('the checkbox did not render as a button');
  }
  return button;
}

describe('CheckIndicator', () => {
  it('draws a tick inside a square box when checked', () => {
    const indicator = indicatorOf(
      render(<CheckIndicator checked shape="square" />),
    );

    expect(indicator.className).toContain('rounded-[4px]');
    expect(indicator.className).toContain('bg-primary');
    expect(indicator.querySelector('svg')).not.toBeNull();
  });

  it('draws a dot inside a round box when checked', () => {
    const indicator = indicatorOf(
      render(<CheckIndicator checked shape="round" />),
    );

    expect(indicator.className).toContain('rounded-full');
    expect(indicator.className).toContain('bg-primary');
    expect(indicator.querySelector('svg')).toBeNull();
    expect(indicator.querySelector('span.rounded-full')).not.toBeNull();
  });

  it('draws neither a tick nor a dot, and no fill, when unchecked', () => {
    for (const shape of ['square', 'round'] as const) {
      const indicator = indicatorOf(
        render(<CheckIndicator checked={false} shape={shape} />),
      );

      expect(indicator.className).not.toContain('bg-primary');
      expect(indicator.querySelector('svg')).toBeNull();
      expect(indicator.children).toHaveLength(0);
    }
  });

  it('is hidden from assistive technology', () => {
    const indicator = indicatorOf(
      render(<CheckIndicator checked shape="square" />),
    );

    expect(indicator.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Checkbox', () => {
  it('exposes its checked state to assistive technology', () => {
    const unchecked = checkboxOf(
      render(
        <Checkbox checked={false} onCheckedChange={() => {}} label="Digest" />,
      ),
    );
    expect(unchecked.getAttribute('aria-checked')).toBe('false');
    expect(unchecked.dataset.state).toBe('unchecked');

    const checked = checkboxOf(
      render(<Checkbox checked onCheckedChange={() => {}} label="Digest" />),
    );
    expect(checked.getAttribute('aria-checked')).toBe('true');
    expect(checked.dataset.state).toBe('checked');
  });

  it('reports the opposite of its current state when clicked', () => {
    const onCheckedChange = vi.fn();
    const el = render(
      <Checkbox
        checked={false}
        onCheckedChange={onCheckedChange}
        label="Digest"
      />,
    );

    act(() => {
      checkboxOf(el).click();
    });
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);

    const onUncheck = vi.fn();
    const checkedEl = render(
      <Checkbox checked onCheckedChange={onUncheck} label="Digest" />,
    );
    act(() => {
      checkboxOf(checkedEl).click();
    });
    expect(onUncheck).toHaveBeenLastCalledWith(false);
  });

  it('draws its label beside the indicator', () => {
    const button = checkboxOf(
      render(
        <Checkbox
          checked={false}
          onCheckedChange={() => {}}
          label="Send digest"
        />,
      ),
    );

    expect(button.textContent).toBe('Send digest');
    expect(button.contains(indicatorOf(button))).toBe(true);
  });

  it('ignores clicks while disabled', () => {
    const onCheckedChange = vi.fn();
    const el = render(
      <Checkbox
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
        label="Digest"
      />,
    );

    expect(checkboxOf(el).disabled).toBe(true);
    act(() => {
      checkboxOf(el).click();
    });
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('forwards its id to the button so an external label can point at it', () => {
    const el = render(
      <Checkbox
        id="digest-toggle"
        checked={false}
        onCheckedChange={() => {}}
        label="Digest"
      />,
    );

    expect(checkboxOf(el).id).toBe('digest-toggle');
  });

  it('is a native button, so Space and Enter need no handler of their own', () => {
    const button = checkboxOf(
      render(
        <Checkbox checked={false} onCheckedChange={() => {}} label="Digest" />,
      ),
    );

    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
  });
});
