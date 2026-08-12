// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisclosureRow } from './disclosure-row';

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

describe('DisclosureRow', () => {
  it('wears the destructive tone and collapses to the first line by default', () => {
    act(() =>
      root.render(<DisclosureRow caption="flaky · error" message={MESSAGE} />),
    );

    const row = container.querySelector('[data-role="error"]');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('destructive');
    expect(container.textContent).toContain('spawn cursor-agent ENOENT');
    expect(container.textContent).not.toContain('full stderr line 2');
  });

  it('a click expands the FULL message; a second click collapses it again', () => {
    act(() =>
      root.render(<DisclosureRow caption="flaky · error" message={MESSAGE} />),
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

  describe('the muted tone', () => {
    // Relayed CLI text is not an advisory: it must not be able to look like one.
    it('drops the failure chrome and the warning glyph, and says it is a system row', () => {
      act(() =>
        root.render(
          <DisclosureRow
            tone="muted"
            caption="conversation compacted"
            message={MESSAGE}
          />,
        ),
      );

      const row = container.querySelector('[data-role="system"]');
      expect(row).not.toBeNull();
      expect(row?.className).not.toContain('destructive');
      expect(container.querySelector('[data-role="error"]')).toBeNull();
      // The glyph is the failure tone's, so the quiet row must not carry it.
      expect(container.querySelector('svg.lucide-triangle-alert')).toBeNull();
      // A SYSTEM line, not a panel: centred, as wide as its own words, and
      // carrying no border or fill of its own. A full-width bordered box reads as
      // something that happened to the user rather than a note about
      // housekeeping — which is what it looked like when this shipped.
      // `classList`, not a substring: `max-w-full` contains "w-full", and the
      // first version of this assertion failed on exactly that.
      expect(row?.classList.contains('self-center')).toBe(true);
      expect(row?.classList.contains('w-full')).toBe(false);
      expect(row?.classList.contains('border')).toBe(false);
      // The `note` variant's own reading, which is the whole ask: same size, same
      // colour, and no italic or fill that would set it apart from "✓ done".
      expect(row?.classList.contains('text-xs')).toBe(true);
      expect(row?.classList.contains('text-muted-foreground')).toBe(true);
      const toggle = container.querySelector('button[aria-expanded]');
      expect(toggle?.className).not.toContain('italic');
      expect(toggle?.className).not.toContain('bg-');
      // The BUTTON must restate the size and weight, because `global.css` gives
      // every `button` the base size and medium weight and an element's own rule
      // beats inheritance — without these the row rendered 15px/500 against the
      // note's 11.25px/400, which is exactly how it shipped and was reported.
      // (jsdom loads no stylesheet, so the class is the only observable here.)
      expect(toggle?.classList.contains('text-xs')).toBe(true);
      expect(toggle?.classList.contains('font-normal')).toBe(true);
      // Opening the row must not MOVE its header. Expanded, the body takes the
      // full column and the container grows with it, so a left-aligned header
      // slid from the middle of the transcript to its left edge — out from under
      // the pointer that had just pressed it. (jsdom does no layout; the centring
      // class is the observable.)
      expect(toggle?.classList.contains('justify-center')).toBe(true);
      expect(
        container
          .querySelector('svg.lucide-chevron-right')
          ?.classList.contains('ml-auto'),
      ).toBe(false);
    });

    it('shows `detail` INSTEAD of the message preview while collapsed', () => {
      // The two compete for one line. A row that can state what happened says
      // that, not the first words of text nobody has opened yet.
      act(() =>
        root.render(
          <DisclosureRow
            tone="muted"
            caption="conversation compacted"
            detail="200.2k → 34.1k tokens"
            message={MESSAGE}
          />,
        ),
      );

      expect(container.textContent).toContain('200.2k → 34.1k tokens');
      expect(container.textContent).not.toContain('spawn cursor-agent ENOENT');

      // …and the message is still reachable, which is the whole point of
      // collapsing it rather than dropping it.
      act(() => {
        container
          .querySelector('button[aria-expanded]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(container.textContent).toContain('full stderr line 2');
    });
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
      act(() =>
        root.render(<DisclosureRow caption="error" message={MESSAGE} />),
      );

      expect(container.querySelector(`button[title="${TITLE}"]`)).toBeNull();
    });

    it('is offered COLLAPSED, not hidden behind the disclosure', () => {
      // The cure is the point of the row. Behind a disclosure it sits roughly
      // where it already was — invisible to a user who does not know it exists.
      act(() =>
        root.render(
          <DisclosureRow
            caption="error"
            message={MESSAGE}
            onSignIn={() => {}}
          />,
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
          <DisclosureRow
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
