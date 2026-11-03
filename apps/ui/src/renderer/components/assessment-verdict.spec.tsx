// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AssessmentVerdict,
  type AssessmentVerdictValue,
} from './assessment-verdict';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(
  value: AssessmentVerdictValue | null,
  onChange?: (next: AssessmentVerdictValue | null) => Promise<void>,
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(<AssessmentVerdict value={value} onChange={onChange} />),
  );
  return container;
}

function button(el: HTMLElement, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(name),
  );
  if (!found) {
    throw new Error(`no button "${name}"`);
  }
  return found;
}

describe('AssessmentVerdict', () => {
  it('saves an agreement at once, and clears it on a second press', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const el = render(null, onChange);

    await act(async () => button(el, 'Agree').click());
    expect(onChange).toHaveBeenLastCalledWith({ verdict: 'agree', note: null });

    act(() =>
      root!.render(
        <AssessmentVerdict
          value={{ verdict: 'agree', note: null }}
          onChange={onChange}
        />,
      ),
    );
    expect(button(el, 'Agree').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button(el, 'Agree').click());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('asks why before it saves a disagreement, and sends the trimmed note', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const el = render(null, onChange);

    await act(async () => button(el, 'Disagree').click());
    expect(onChange).not.toHaveBeenCalled();
    const field = el.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(field, '  it missed the race  ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(el, 'Save').click());

    expect(onChange).toHaveBeenCalledWith({
      verdict: 'disagree',
      note: 'it missed the race',
    });
    expect(el.querySelector('textarea')).toBeNull();
  });

  it('shows a failed save, and only the verdict without a setter', async () => {
    const el = render(
      null,
      vi.fn().mockRejectedValue(new Error('no such card')),
    );
    await act(async () => button(el, 'Agree').click());
    expect(el.textContent).toContain('no such card');

    act(() => root!.unmount());
    container!.remove();
    const shown = render({ verdict: 'disagree', note: 'too lenient' });
    expect(shown.querySelectorAll('button')).toHaveLength(0);
    expect(shown.textContent).toBe('You disagreed“too lenient”');
  });
});
