// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AlertRow } from './alert-row';

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

const MESSAGE = 'spawn cursor-agent ENOENT\nfull stderr line 2\nline 3';

describe('AlertRow', () => {
  it('wears the destructive tone and collapses to the first line by default', () => {
    act(() =>
      root.render(<AlertRow caption="flaky · error" message={MESSAGE} />),
    );

    const row = container.querySelector('[data-role="error"]');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('destructive');
    expect(container.textContent).toContain('spawn cursor-agent ENOENT');
    expect(container.textContent).not.toContain('full stderr line 2');
  });

  it('a click expands the FULL message; a second click collapses it again', () => {
    act(() =>
      root.render(<AlertRow caption="flaky · error" message={MESSAGE} />),
    );
    const toggle = container.querySelector('button[aria-expanded]')!;

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('full stderr line 2');
    expect(container.textContent).toContain('line 3');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).not.toContain('full stderr line 2');
  });

  describe('the recovery action', () => {
    const TITLE =
      'Open this agent’s CLI sign-in in your terminal, then send the message again';
    const signInButton = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>(`button[title="${TITLE}"]`)!;
    const expanded = (): string | null =>
      container
        .querySelector('button[aria-expanded]')!
        .getAttribute('aria-expanded');

    it('is absent unless the failure has a known cure', () => {
      act(() => root.render(<AlertRow caption="error" message={MESSAGE} />));

      expect(container.querySelector(`button[title="${TITLE}"]`)).toBeNull();
    });

    it('is offered COLLAPSED, not hidden behind the disclosure', () => {
      // The cure is the point of the row. Behind a disclosure it sits roughly
      // where it already was — invisible to a user who does not know it exists.
      act(() =>
        root.render(
          <AlertRow caption="error" message={MESSAGE} onSignIn={() => {}} />,
        ),
      );

      expect(expanded()).toBe('false');
      expect(signInButton().textContent).toContain('Sign in');
    });

    it('fires its own handler without also toggling the row', () => {
      // A button nested INSIDE the expand button would do both — and is invalid
      // DOM besides. This is what pins it as a sibling.
      let fired = 0;
      act(() =>
        root.render(
          <AlertRow
            caption="error"
            message={MESSAGE}
            onSignIn={() => void (fired += 1)}
          />,
        ),
      );

      act(() => {
        signInButton().dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });

      expect(fired).toBe(1);
      expect(expanded()).toBe('false');
    });
  });
});
