// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { RunningTasks } from './running-tasks';

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

function readout(running: number | null): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<RunningTasks running={running} />);
  });
  return container;
}

/**
 * What the board has working, on the board's own header.
 *
 * ASKED FOR there: "это «running» нужно, видимо, в хедер поместить рядом со
 * «автопилотом» и там какой-нибудь лодер показывать, если он работает."
 * It used to be counted on the intake column's autopilot band — the one column
 * a running card has by definition left — so the board read `2 running` under
 * a `To do` header reading `0`.
 */
describe('RunningTasks', () => {
  it('counts what is working, with a spinner for the eye', () => {
    const el = readout(2);

    expect(el.textContent).toContain('2 running');
    expect(el.querySelector('.animate-spin')).not.toBeNull();
  });

  it('spells the singular rather than deriving it', () => {
    expect(readout(1).textContent).toBe('1 running');
  });

  it('draws nothing at all when nothing is running', () => {
    // A fixed `0 running` in a header is a readout nobody reads, and its
    // absence says the same thing.
    expect(readout(0).textContent).toBe('');
    // And an UNREAD queue is not a zero — it is no answer yet.
    expect(readout(null).textContent).toBe('');
  });

  it('is a readout, not a control', () => {
    // There is no setting behind the count: the autopilot chip beside it owns
    // every switch, and a pressable-looking chip here would promise one.
    const chip = readout(3).querySelector('[data-slot="running-tasks"]');

    expect(chip?.tagName).toBe('SPAN');
    expect(chip?.querySelector('button')).toBeNull();
  });
});
