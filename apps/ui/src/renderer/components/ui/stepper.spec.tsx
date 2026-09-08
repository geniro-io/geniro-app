// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Stepper } from './stepper';

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

function stepper(
  over: { value?: number; min?: number; max?: number; disabled?: boolean } = {},
): { el: HTMLDivElement; onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <Stepper
        value={over.value ?? 3}
        min={over.min ?? 1}
        max={over.max ?? 5}
        disabled={over.disabled ?? false}
        aria-label="Runs at once"
        onChange={onChange}
      />,
    );
  });
  return { el: container, onChange };
}

const spin = (el: HTMLElement): HTMLElement =>
  el.querySelector('[role="spinbutton"]') as HTMLElement;
const minus = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector('[aria-label="Decrease Runs at once"]') as HTMLButtonElement;
const plus = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector('[aria-label="Increase Runs at once"]') as HTMLButtonElement;

const press = (el: HTMLElement, key: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
};

describe('Stepper', () => {
  it('steps in both directions', () => {
    const { el, onChange } = stepper({ value: 3 });

    act(() => {
      plus(el).click();
    });
    expect(onChange).toHaveBeenLastCalledWith(4);

    act(() => {
      minus(el).click();
    });
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it('states the value and its bounds for a screen reader', () => {
    const { el } = stepper({ value: 3, min: 1, max: 5 });

    expect(spin(el).getAttribute('aria-valuenow')).toBe('3');
    expect(spin(el).getAttribute('aria-valuemin')).toBe('1');
    expect(spin(el).getAttribute('aria-valuemax')).toBe('5');
  });

  // An out-of-range value is unreachable BY CONSTRUCTION, which is the whole
  // reason this replaced a number field — that one had to refuse what was
  // typed, and the caller carried the validation.
  it('disables the end it has reached, and emits nothing there', () => {
    const { el, onChange } = stepper({ value: 1, min: 1 });

    expect(minus(el).disabled).toBe(true);
    expect(plus(el).disabled).toBe(false);
    act(() => {
      minus(el).click();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables the other end at the ceiling', () => {
    const { el } = stepper({ value: 5, max: 5 });

    expect(plus(el).disabled).toBe(true);
    expect(minus(el).disabled).toBe(false);
  });

  it('clamps a value from outside the range rather than offering a bad step', () => {
    // A row written by an older build, or one whose ceiling has since moved.
    const { el } = stepper({ value: 99, min: 1, max: 5 });

    expect(spin(el).getAttribute('aria-valuenow')).toBe('5');
    expect(plus(el).disabled).toBe(true);
  });

  describe('the keys the spinbutton role promises', () => {
    it('moves on the arrows', () => {
      const { el, onChange } = stepper({ value: 3 });

      press(spin(el), 'ArrowUp');
      expect(onChange).toHaveBeenLastCalledWith(4);
      press(spin(el), 'ArrowDown');
      expect(onChange).toHaveBeenLastCalledWith(2);
    });

    it('jumps to the ends on Home and End', () => {
      const { el, onChange } = stepper({ value: 3, min: 1, max: 5 });

      press(spin(el), 'Home');
      expect(onChange).toHaveBeenLastCalledWith(1);
      press(spin(el), 'End');
      expect(onChange).toHaveBeenLastCalledWith(5);
    });

    it('swallows the key, so the panel it sits in does not scroll under it', () => {
      const { el } = stepper({ value: 3 });

      expect(press(spin(el), 'ArrowDown').defaultPrevented).toBe(true);
    });

    it('leaves a key it does not own alone', () => {
      const { el, onChange } = stepper({ value: 3 });

      expect(press(spin(el), 'Enter').defaultPrevented).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it('is inert and out of the tab order when disabled', () => {
    const { el, onChange } = stepper({ disabled: true });

    expect(minus(el).disabled).toBe(true);
    expect(plus(el).disabled).toBe(true);
    expect(spin(el).getAttribute('tabindex')).toBe('-1');
    press(spin(el), 'ArrowUp');
    expect(onChange).not.toHaveBeenCalled();
  });
});
