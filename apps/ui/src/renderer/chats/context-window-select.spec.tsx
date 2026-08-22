// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextWindowSelect } from './context-window-select';

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

const trigger = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-menu-trigger]');

/** The menu's rows — the picker is ours, so they are real DOM, not an OS menu. */
function optionValues(el: HTMLElement): string[] {
  act(() => {
    trigger(el)!.click();
  });
  return [...el.querySelectorAll('[role="option"]')].map(
    (o) => o.textContent ?? '',
  );
}

/** What a cursor probe reports for a model that offers a real choice. */
const CURSOR_WINDOWS = [
  { id: '300k', label: '300k' },
  { id: '1m', label: '1m' },
];

/**
 * The daemon's four live `unavailableReason` sentences, as
 * `cursor-acp.adapter.ts` and `claude.adapter.ts` produce them.
 *
 * The sentence is PROSE the user reads on hover; it is NOT what the chip
 * branches on. `unavailableKind` is — which is exactly what these tests pin,
 * by pairing each sentence with its kind and asserting the LABEL follows the
 * kind. Before the discriminator existed the component matched the no-model
 * sentence literally, so rewording it on the daemon side silently reverted
 * the label here.
 */
const REASON_NO_MODEL =
  'pick a model to see the context-window sizes it offers';
const REASON_FIXED_WINDOW =
  'grok-4.6 runs at one fixed context window — pick a model that offers a choice.';
const REASON_PROBE_FAILED =
  'cursor-agent could not be asked which context windows this model offers';
const REASON_NO_AXIS =
  'claude runs each model at its own context window — pick a different model to change it';

describe('ContextWindowSelect', () => {
  it('renders NO PICKER and nothing at all when the answer has not landed', () => {
    // `undefined` means "no report yet" — a chip whose only explanation is
    // still in flight would read as a control that is simply broken.
    const el = render(
      <ContextWindowSelect windows={[]} value={null} onChange={() => {}} />,
    );
    expect(trigger(el)).toBeNull();
    expect(el.textContent).toBe('');
  });

  it('labels the no-model case "pick a model", distinct from every other reason', () => {
    // This is the DEFAULT path, not an edge case: a composer sitting on the
    // default model with no pick made yet hits exactly this reason.
    const el = render(
      <ContextWindowSelect
        windows={[]}
        value={null}
        unavailableReason={REASON_NO_MODEL}
        unavailableKind="no-model"
        onChange={() => {}}
      />,
    );
    expect(trigger(el)).toBeNull();
    expect(el.textContent).toContain('pick a model');
    // The full sentence still rides the hover title, unabridged.
    expect(el.querySelector('[title]')?.getAttribute('title')).toBe(
      REASON_NO_MODEL,
    );
  });

  it.each([
    ['a model with one fixed size', REASON_FIXED_WINDOW, 'fixed-window'],
    ['a probe that could not be taken', REASON_PROBE_FAILED, 'unreadable'],
    ['a CLI with no such axis at all', REASON_NO_AXIS, 'no-axis'],
  ] as const)(
    'keeps %s on the PICKER at the model’s own default, never an inert word',
    (_, reason, kind) => {
      // The reported shape: on claude — no such axis on any model — this was a
      // dead grey chip reading "one window" on every chat. All three of these
      // describe a turn that runs at the model's default, which is a thing the
      // picker can already say, so it says it.
      const el = render(
        <ContextWindowSelect
          windows={[]}
          value={null}
          unavailableReason={reason}
          unavailableKind={kind}
          onChange={() => {}}
        />,
      );
      const control = trigger(el);
      expect(control).not.toBeNull();
      expect(control!.disabled).toBe(false);
      expect(control!.textContent).toContain('default window');
      // The daemon's sentence is what the label stopped carrying, so it has to
      // be reachable: it is the chip's own hover title, in place of the plain
      // "Context window" a chip with rows shows.
      expect(control!.getAttribute('title')).toBe(reason);
      // And the menu opens on the one row that is true — no fabricated sizes.
      expect(optionValues(el)).toEqual(['default window']);
    },
  );

  it('keeps a stored size on screen even when the model reports no sizes at all', () => {
    // A chat moved onto a model with no window axis: the stored word is still
    // what is on the run, and the chip's fallback to "default window" must not
    // be the only trace of it. The empty-list path reaches the same disabled
    // add-back row as a model that offers a choice.
    const el = render(
      <ContextWindowSelect
        windows={[]}
        value="1m"
        unavailableReason={REASON_NO_AXIS}
        unavailableKind="no-axis"
        onChange={() => {}}
      />,
    );
    const rows = optionValues(el);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('1m');
    expect(rows[0]).toContain('unavailable');
    expect(rows[1]).toBe('default window');
    expect(trigger(el)!.textContent).toContain('default window');
  });

  it('follows the KIND, not the wording of the reason', () => {
    // The one assertion that actually discriminates. The component used to
    // recognise the no-model case by matching the daemon's sentence, so a
    // reworded sentence silently reverted the label — and every other test
    // here would still have passed, because they pair each kind with the
    // sentence that currently accompanies it. This one deliberately pairs the
    // kind with prose it does NOT match.
    const el = render(
      <ContextWindowSelect
        windows={[]}
        value={null}
        unavailableReason="choose a model first to see the sizes on offer"
        unavailableKind="no-model"
        onChange={() => {}}
      />,
    );
    expect(trigger(el)).toBeNull();
    expect(el.textContent).toContain('pick a model');
    expect(el.textContent).not.toContain('default window');
  });

  it('offers exactly the sizes the daemon reported, plus a default row', () => {
    const el = render(
      <ContextWindowSelect
        windows={CURSOR_WINDOWS}
        value="1m"
        onChange={() => {}}
      />,
    );
    expect(optionValues(el)).toEqual(['300k', '1m', 'default window']);
  });

  it('reports the picked size, and null for the default row', () => {
    const onChange = vi.fn();
    const el = render(
      <ContextWindowSelect
        windows={CURSOR_WINDOWS}
        value="300k"
        onChange={onChange}
      />,
    );
    act(() => {
      trigger(el)!.click();
    });
    const options = el.querySelectorAll<HTMLElement>('[role="option"]');
    act(() => {
      options[1]!.click(); // '1m'
    });
    expect(onChange).toHaveBeenCalledWith('1m');

    act(() => {
      trigger(el)!.click();
    });
    const reopened = el.querySelectorAll<HTMLElement>('[role="option"]');
    act(() => {
      reopened[reopened.length - 1]!.click(); // 'default window'
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps a stored size the current model refuses on screen, disabled rather than dropped', () => {
    // The reported shape this control exists for: a chat carried onto another
    // model still carries the old size, and the chip's silent fallback to
    // "default window" must not be the only trace of that on screen.
    const onChange = vi.fn();
    const el = render(
      <ContextWindowSelect
        windows={CURSOR_WINDOWS}
        value="200k"
        onChange={onChange}
      />,
    );
    act(() => {
      trigger(el)!.click();
    });
    const options = [
      ...el.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ];
    const refused = options.find((o) => o.textContent?.includes('200k'));
    expect(refused).toBeDefined();
    expect(refused!.disabled).toBe(true);
    expect(refused!.textContent).toContain('unavailable');

    act(() => {
      refused!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();

    // The chip itself reads as the model's own default — the size the turn
    // will actually run at — never the refused word.
    expect(trigger(el)!.textContent).toContain('default window');
    expect(trigger(el)!.textContent).not.toContain('200k');
  });
});
