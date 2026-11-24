// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Slider } from './slider';

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

function sliderOf(el: ParentNode): HTMLInputElement {
  const input = el.querySelector('input[type="range"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('the slider did not render a range input');
  }
  return input;
}

/** Moves the thumb as a user does: the native value setter, then the input event React reads. */
function moveThumb(input: HTMLInputElement, next: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setValue.call(input, next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Slider', () => {
  it('shows the current value to the right of the track', () => {
    const el = render(
      <Slider value={40} min={0} max={100} onValueChange={() => {}} />,
    );

    const output = el.querySelector('output');
    expect(output?.textContent).toBe('40');
    expect(
      sliderOf(el).compareDocumentPosition(output!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('reports the number the thumb moved to', () => {
    const onValueChange = vi.fn();
    const el = render(
      <Slider value={40} min={0} max={100} onValueChange={onValueChange} />,
    );

    moveThumb(sliderOf(el), '75');

    expect(onValueChange).toHaveBeenLastCalledWith(75);
  });

  it('keeps its range and step on the input', () => {
    const input = sliderOf(
      render(
        <Slider
          value={12}
          min={10}
          max={20}
          step={2}
          onValueChange={() => {}}
        />,
      ),
    );

    expect(input.min).toBe('10');
    expect(input.max).toBe('20');
    expect(input.step).toBe('2');
    expect(input.value).toBe('12');
  });

  it('fills the track up to the value, measured from the minimum', () => {
    // A range that starts above zero must fill from its own minimum: 15 on 10–20
    // is halfway, not 15%.
    const input = sliderOf(
      render(<Slider value={15} min={10} max={20} onValueChange={() => {}} />),
    );

    expect(input.style.backgroundImage).toContain('var(--primary) 50%');
    expect(input.style.backgroundImage).toContain(
      'var(--switch-background) 50%',
    );
  });

  it('names the input by its label', () => {
    const input = sliderOf(
      render(
        <Slider
          value={5}
          min={0}
          max={10}
          label="Volume"
          onValueChange={() => {}}
        />,
      ),
    );

    expect(input.getAttribute('aria-label')).toBe('Volume');
  });

  it('is disabled as a native range input when asked', () => {
    const input = sliderOf(
      render(
        <Slider value={5} min={0} max={10} disabled onValueChange={() => {}} />,
      ),
    );

    expect(input.disabled).toBe(true);
  });
});
