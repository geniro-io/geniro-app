// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { usePersistedFlag } from './use-persisted-flag';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** A switch reading the flag, so its value is observable in the DOM. */
function Flag({
  storageKey,
  fallback,
}: {
  storageKey: string;
  fallback: boolean;
}): React.JSX.Element {
  const [on, setOn] = usePersistedFlag(storageKey, fallback);
  return (
    <button type="button" aria-pressed={on} onClick={() => setOn((v) => !v)}>
      {on ? 'on' : 'off'}
    </button>
  );
}

function mount(node: React.ReactElement): HTMLButtonElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container.querySelector('button')!;
}

function unmount(): void {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
}

afterEach(() => {
  unmount();
  localStorage.clear();
});

describe('usePersistedFlag', () => {
  it('remembers a flipped flag across a remount', () => {
    // The whole reason it exists: the panels that use it are remounted by
    // their owners (the builder on every nav change, the agents panel per
    // run), so `useState` would forget the fold immediately.
    const button = mount(<Flag storageKey="k" fallback={false} />);
    act(() => {
      button.click();
    });
    expect(localStorage.getItem('k')).toBe('1');

    unmount();
    expect(mount(<Flag storageKey="k" fallback={false} />).textContent).toBe(
      'on',
    );
  });

  it('honours a stored OFF against an on-by-default flag', () => {
    // The one reading that is easy to get wrong, and the only one a
    // default-open panel can be broken by: `'0'` is a CHOICE, and treating a
    // falsy stored value as "nothing stored" would silently make the fold the
    // one state this hook could not remember.
    localStorage.setItem('k', '0');

    expect(mount(<Flag storageKey="k" fallback />).textContent).toBe('off');
  });

  it('falls back only when the key has never been written', () => {
    expect(mount(<Flag storageKey="unset" fallback />).textContent).toBe('on');
  });
});
