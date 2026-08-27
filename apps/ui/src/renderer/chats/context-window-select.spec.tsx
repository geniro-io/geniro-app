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
const REASON_PROBE_FAILED =
  'cursor-agent could not be asked which context windows this model offers';
const REASON_NO_AXIS =
  'claude runs each model at its own context window — pick a different model to change it';

describe('ContextWindowSelect', () => {
  it('renders NOTHING whenever there is no size to choose', () => {
    // Every empty case is the same on screen now, whichever of the four it is
    // — no report yet, no model named, a model with one fixed window, a probe
    // that failed. They stopped being distinguishable HERE at all: the reason
    // and its kind are no longer props, so this component sees only "empty".
    // It has been all three shapes: an inert `one window`, then a live picker
    // offering `model default` alone, then this. The middle one was REPORTED on
    // `auto-smart` ("если авто, то мы по идее не должны выбирать Contact Size,
    // а у нас я все еще вижу активно кнопку Default"), which is what a one-row
    // picker is: a control with nothing to choose.
    const el = render(
      <ContextWindowSelect windows={[]} value={null} onChange={() => {}} />,
    );

    expect(trigger(el)).toBeNull();
    expect(el.textContent).toBe('');
    // Nothing to hover either — the daemon's sentence lived on a `title` and
    // is gone with the element that carried it.
    expect(el.querySelector('[title]')).toBeNull();
  });

  it('drops a stored size with the picker when the model reports none', () => {
    // The stored word used to be kept on screen so nothing vanished silently.
    // With no picker there is nowhere to keep it, and no lie either — the run
    // still carries the value and the daemon still refuses it on the turn if
    // the model will not take it, which is where a wrong size is reported.
    const el = render(
      <ContextWindowSelect windows={[]} value="1m" onChange={() => {}} />,
    );

    expect(el.textContent).toBe('');
  });

  it('shows the MEASURED window on the chip in place of the word', () => {
    // REPORTED as "вместо Default Window, потому что это слишком длинно, может
    // быть, сразу значение дефолтное туда поставим". The chip's job is to say
    // what this turn runs at, and the agent has already said so — `1M` in two
    // characters where `default window` took fourteen, on a composer row that
    // must never wrap.
    // Over a REAL list, which is now the only case that renders at all: with a
    // model offering sizes and none picked, the chip reports the window the
    // agent measured rather than the word `default`.
    const el = render(
      <ContextWindowSelect
        windows={CURSOR_WINDOWS}
        value={null}
        windowTokens={1_000_000}
        onChange={() => {}}
      />,
    );

    expect(trigger(el)!.textContent).toContain('1M');
    expect(trigger(el)!.textContent).not.toContain('default');
    // The MENU still states the CHOICE, which is a different sentence: with
    // nothing picked the chip reports the window and the row reports what you
    // would be selecting. One label cannot be both.
    expect(optionValues(el).at(-1)).toBe('model default');
  });

  it('keeps the word when the size is PICKED, not merely measured', () => {
    // The measured window labels the DEFAULT and nothing else: with `300k`
    // chosen, the chip must say what was chosen. Otherwise a user who picked
    // 300k on a model whose reading happens to be 300k could not tell their own
    // pick from the fallback.
    const el = render(
      <ContextWindowSelect
        windows={CURSOR_WINDOWS}
        value="300k"
        windowTokens={1_000_000}
        onChange={() => {}}
      />,
    );

    expect(trigger(el)!.textContent).toContain('300k');
    expect(trigger(el)!.textContent).not.toContain('1M');
  });

  it('falls back to the bare word when nothing has measured a window', () => {
    // Every surface but an open chat: the builder's node inspector, a saved
    // configuration, a thread with no turn yet. A fabricated number there would
    // state a window nobody reported — the standing rule in this file.
    const el = render(
      <ContextWindowSelect
        windows={CURSOR_WINDOWS}
        value={null}
        windowTokens={null}
        onChange={() => {}}
      />,
    );

    expect(trigger(el)!.textContent).toContain('default');
  });

  it('offers exactly the sizes the daemon reported, plus a default row', () => {
    const el = render(
      <ContextWindowSelect
        windows={CURSOR_WINDOWS}
        value="1m"
        onChange={() => {}}
      />,
    );
    expect(optionValues(el)).toEqual(['300k', '1m', 'model default']);
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
      reopened[reopened.length - 1]!.click(); // 'model default'
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps a stored size the current model refuses on screen, disabled rather than dropped', () => {
    // The reported shape this control exists for: a chat carried onto another
    // model still carries the old size, and the chip's silent fallback to
    // the chip's own default fallback must not be the only trace of that.
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
    expect(trigger(el)!.textContent).toContain('default');
    expect(trigger(el)!.textContent).not.toContain('200k');
  });
});
