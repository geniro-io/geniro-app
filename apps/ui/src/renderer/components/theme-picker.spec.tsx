// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ThemePreference, THEMES } from '../../shared/themes';
import { ThemePicker } from './theme-picker';

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

function render(
  value: ThemePreference,
  onSelect: (next: ThemePreference) => void = () => undefined,
): void {
  act(() => {
    root.render(<ThemePicker value={value} onSelect={onSelect} />);
  });
}

function swatches(): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[data-slot="theme-picker"] button',
    ),
  ];
}

describe('ThemePicker', () => {
  it('offers System and every theme the app ships', () => {
    render('system');

    // Expected from the MANIFEST so a third theme needs no edit here — the
    // same shape the Settings screen's own spec uses for the same reason.
    expect(swatches().map((button) => button.textContent?.trim())).toEqual([
      'System',
      ...THEMES.map((theme) => theme.label),
    ]);
  });

  it('reports the preference that was pressed', () => {
    const onSelect = vi.fn();
    render('system', onSelect);

    act(() => {
      swatches()[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The third swatch is the second THEME, System leading the row.
    expect(onSelect).toHaveBeenCalledWith(THEMES[1]?.id);
  });

  it('marks the current choice in words as well as in colour', () => {
    render(THEMES[0]?.id ?? 'system');

    const chosen = swatches()[1];
    expect(chosen?.getAttribute('aria-pressed')).toBe('true');
    expect(swatches()[0]?.getAttribute('aria-pressed')).toBe('false');
    // The check mark, and it is not decoration: these swatches ARE colour, so a
    // border tint is the one thing that cannot be the only signal of which is
    // selected. Asserted as an svg inside the pressed button alone.
    expect(chosen?.querySelector('svg')).not.toBeNull();
    expect(swatches()[0]?.querySelector('svg')).toBeNull();
  });

  it('paints each swatch in the theme it names, not in the page theme', () => {
    render('system');

    // The load-bearing fact of the whole component: a face stamps `data-theme`
    // on itself, so its colours come from that theme's own token file through
    // the ordinary utilities. Drop the attribute and every swatch silently
    // paints in whatever theme the document is on — three identical pictures,
    // which is the failure this pins. jsdom computes no cascade, so the
    // attribute is the observable; it is the mechanism, not a proxy for one.
    const faces = [
      ...container.querySelectorAll<HTMLElement>('[data-slot="theme-face"]'),
    ].map((face) => face.dataset.theme);

    // System draws every ground it can, then one face per theme.
    expect(faces.slice(-THEMES.length)).toEqual(
      THEMES.map((theme) => theme.id),
    );
    expect(new Set(faces.slice(0, -THEMES.length)).size).toBeGreaterThan(0);
  });
});
