// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type OptionArity, OptionList } from './option-list';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLDivElement }[] = [];

function render(node: React.ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  mounted.push({ root, host });
  return host;
}

afterEach(() => {
  act(() => {
    for (const { root } of mounted) {
      root.unmount();
    }
  });
  for (const { host } of mounted) {
    host.remove();
  }
  mounted.length = 0;
});

function optionsOf(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll('button')];
}

function indicatorOf(button: HTMLButtonElement): HTMLElement | null {
  return button.querySelector('[data-slot="option-indicator"]');
}

function list(arity: OptionArity, selected: string[] = []): HTMLElement {
  return render(
    <OptionList
      options={['Red', 'Blue']}
      selected={selected}
      arity={arity}
      onPick={vi.fn()}
    />,
  );
}

describe('OptionList', () => {
  it('draws a SQUARE box for many and a ROUND one for one', () => {
    // The whole point of the control: the shape is what tells a reader, before
    // they click, whether a second pick adds to the first or replaces it. If
    // the two arities ever render the same indicator the user is back to
    // reading the hint sentence, which is the defect this replaced.
    const many = indicatorOf(optionsOf(list('many'))[0]!)!;
    const one = indicatorOf(optionsOf(list('one'))[0]!)!;

    expect(many.className).toContain('rounded-[4px]');
    expect(one.className).toContain('rounded-full');
    expect(many.className).not.toBe(one.className);
  });

  it('gives `none` no indicator and no pressed state at all', () => {
    // `none` is the answer-on-click card: the press IS the submission, so
    // nothing is ever left sitting in a box. An empty checkbox there would
    // promise a staging step that does not exist, and the user would go looking
    // for the button that confirms it.
    const button = optionsOf(list('none', ['Red']))[0]!;

    expect(indicatorOf(button)).toBeNull();
    expect(button.hasAttribute('aria-pressed')).toBe(false);
  });

  it('stacks a checklist and lets the other arities flow', () => {
    // A checklist is read DOWN its boxes. In a wrapping flow every box sits at
    // a different x, and the one thing the eye uses to count what it has ticked
    // is gone — which is why `many` is the arity that gives up the flow, and
    // the other two, having nothing to align, keep it.
    const groupOf = (arity: OptionArity): string =>
      list(arity).querySelector('[role="group"]')!.className;

    expect(groupOf('many')).toContain('flex-col');
    expect(groupOf('one')).toContain('flex-wrap');
    expect(groupOf('none')).toContain('flex-wrap');
  });

  it('reports the arity in the group name, not only in the drawing', () => {
    // A screen reader gets no shape. Without this the two arities are
    // indistinguishable to it — which is the same failure, one sense over.
    const name = (arity: OptionArity): string =>
      list(arity).querySelector('[role="group"]')!.getAttribute('aria-label')!;

    expect(name('many')).toContain('pick as many as apply');
    expect(name('one')).toContain('pick one');
    expect(name('none')).toContain('answers straight away');
  });

  it('marks exactly the picked options as pressed', () => {
    const [red, blue] = optionsOf(list('many', ['Blue']));

    expect(red!.getAttribute('aria-pressed')).toBe('false');
    expect(blue!.getAttribute('aria-pressed')).toBe('true');
    // …and the tick is drawn on the pressed one only.
    expect(indicatorOf(red!)!.querySelector('svg')).toBeNull();
    expect(indicatorOf(blue!)!.querySelector('svg')).not.toBeNull();
  });

  it('reports the label that was clicked', () => {
    const onPick = vi.fn();
    const el = render(
      <OptionList
        options={['Red', 'Blue']}
        selected={[]}
        arity="one"
        onPick={onPick}
      />,
    );
    act(() => {
      optionsOf(el)[1]!.click();
    });
    expect(onPick).toHaveBeenCalledWith('Blue');
  });

  it('keeps a long label readable instead of forcing it onto one line', () => {
    // Options arrive as anything from three words to a full sentence. A row of
    // `whitespace-nowrap` pills — the composer-chip look this deliberately does
    // NOT reuse — turns the long ones into a horizontally ragged brick wall.
    const button = optionsOf(list('one'))[0]!;

    expect(button.className).toContain('max-w-full');
    expect(button.className).not.toContain('whitespace-nowrap');
    expect(button.querySelector('span:last-child')!.className).toContain(
      'break-words',
    );
  });
});
