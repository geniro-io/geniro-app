import { useSyncExternalStore } from 'react';

import {
  DEFAULT_THEME_PREFERENCE,
  resolveThemePreference,
  type ThemeAppearance,
  themeAppearance,
  type ThemeId,
  type ThemePreference,
} from '../../shared/themes';

/**
 * Which theme the document is painting, and the one place `data-theme` is
 * written.
 *
 * There is deliberately NO IPC channel here. Main sets
 * `nativeTheme.themeSource` from the stored preference, and Electron drives
 * this renderer's `prefers-color-scheme` from that — for an explicit pick as
 * much as for System. So the media query already reports the resolved
 * APPEARANCE before the first frame, which is what lets the seed below be
 * synchronous and the first paint be correct.
 *
 * The stored preference is still read, and is not redundant: the media query
 * can only answer light-or-dark, so it identifies the theme exactly while those
 * are the only two. A third theme is named by the preference alone, which is
 * why the preference — not the query — is what resolution starts from.
 */
const DARK_QUERY = '(prefers-color-scheme: dark)';

function prefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

let preference: ThemePreference = DEFAULT_THEME_PREFERENCE;
let current: ThemeId = resolveThemePreference(preference, false);
const listeners = new Set<() => void>();

function applyToDocument(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}

function recompute(): void {
  const next = resolveThemePreference(preference, prefersDark());
  if (next === current) {
    return;
  }
  current = next;
  applyToDocument(current);
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Seed the document before React renders.
 *
 * Called from `main.tsx` ahead of `createRoot`: the attribute has to be on
 * `<html>` for the very first paint, or a dark-theme window shows one frame of
 * cream. The window's own `backgroundColor` covers the moment before this runs
 * (main paints it from the same preference), so the two together leave no gap.
 */
export function initTheme(): void {
  current = resolveThemePreference(preference, prefersDark());
  applyToDocument(current);
  window
    .matchMedia(DARK_QUERY)
    // The OS appearance changing under System, and also main answering a
    // preference change — it writes `themeSource`, which moves this query.
    .addEventListener('change', recompute);
}

/**
 * Adopt the stored preference once it has been read, and whenever the user
 * changes it.
 *
 * For the two themes shipped today the media query would have got there on its
 * own, since main's `themeSource` write moves it either way. This is what makes
 * the answer exact for a theme whose name is not `light` or `dark`, and it
 * costs one assignment.
 */
export function setThemePreference(next: ThemePreference): void {
  preference = next;
  recompute();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The theme being painted. Not exported: nothing outside this module needs the
 * theme's ID, only the coarser appearance below — a component that needs the id
 * itself can export this then.
 */
function useResolvedTheme(): ThemeId {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

/**
 * The ground the current theme paints on, for a vendor component that takes
 * light-or-dark rather than a theme name (`@uiw/react-md-editor`).
 */
export function useThemeAppearance(): ThemeAppearance {
  return themeAppearance(useResolvedTheme());
}
