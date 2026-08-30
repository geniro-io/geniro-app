import { BrowserWindow, nativeTheme } from 'electron';

import {
  resolveThemePreference,
  themeAppearance,
  type ThemeId,
  type ThemePreference,
  themeWindowBackground,
} from '../shared/themes';

/**
 * Declare the app's appearance to macOS.
 *
 * Private on purpose. It is HALF of applying a theme — the OS write with no
 * repaint — and an exported half is what let a caller reach one without the
 * other. {@link applyTheme} is the only exported way to apply one, and
 * {@link resolvedTheme} the only way to ask what is being painted.
 *
 * The write reaches two very different sets of surfaces. It decides what the OS
 * draws for the parts of the window this app does not paint — the traffic
 * lights, the context menu, scrollbars, system dialogs — and Electron ALSO
 * drives the renderer's `prefers-color-scheme` from it, which is what
 * `renderer/theme/apply-theme.ts` resolves the document's `data-theme` from. So
 * main is the only place the choice is applied, and the OS chrome and the page
 * cannot disagree about it.
 *
 * The traffic lights are why this file exists at all, and the reasoning still
 * holds under a dark theme — it just points the other way now. macOS draws an
 * INACTIVE traffic light as a translucent disc tinted for the appearance:
 * near-white under Dark, grey under Light. While the palette was light-only and
 * the machine was in Dark mode, an unfocused window rendered three white discs
 * onto the title bar's own near-white and the buttons simply vanished (measured
 * on macOS 26: fill `#ffffff` against `#fdfcfa`, a 1.02:1 ratio). Declaring the
 * appearance is what fixes that in BOTH directions — the failure recurs,
 * mirrored, on a light-mode machine running the dark theme.
 *
 * That the cause is the appearance and not the title bar this app draws itself
 * was probed rather than assumed: three `hiddenInset` windows over the same
 * near-white ground, with and without `trafficLightPosition`, all three
 * vanished under Dark and all three came back under `'light'`. Which is also
 * why recolouring the band was never the fix — it would have bought back three
 * buttons and left every other unpainted native surface still wrong.
 */
function declareAppearance(preference: ThemePreference): ThemeId {
  // `themeSource` takes an APPEARANCE, never a theme id: the union Electron
  // accepts is `'system' | 'light' | 'dark'`, so a theme named anything else
  // has to be reduced to the ground it paints on.
  nativeTheme.themeSource =
    preference === 'system' ? 'system' : themeAppearance(preference);

  return resolvedTheme(preference);
}

/**
 * What is actually being painted, without touching anything.
 *
 * `createWindow` needs the answer before its window exists — `backgroundColor`
 * is a construction option — and needs no write to get it: `themeSource` is
 * already current by then, set at launch and re-set by every {@link applyTheme}.
 */
export function resolvedTheme(preference: ThemePreference): ThemeId {
  // Read back rather than assumed. Under `'system'` this is the OS's answer.
  return resolveThemePreference(preference, nativeTheme.shouldUseDarkColors);
}

/**
 * Repaint every open window's own ground.
 *
 * `backgroundColor` is a CONSTRUCTION option — Electron reads it once, and
 * `setBackgroundColor` is the only way to move it afterwards. Without this, a
 * window created under one theme keeps the other theme's ground for the life of
 * the process, and the strip macOS exposes during a resize (or at the clipped
 * bottom corners) flashes the wrong palette. That is the defect
 * `ThemeDescriptor.windowBackground` in `shared/themes.ts` documents — a dark
 * window flashing cream being a far louder version of the white band it was
 * reported as.
 */
function paintWindows(theme: ThemeId): void {
  const background = themeWindowBackground(theme);
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(background);
  }
}

/** Apply a chosen preference: the OS declaration, then the windows' own ground. */
export function applyTheme(preference: ThemePreference): ThemeId {
  const resolved = declareAppearance(preference);
  paintWindows(resolved);
  return resolved;
}

/**
 * Follow the OS appearance while the preference is `'system'`.
 *
 * The one theme change that arrives through NO settings write, and therefore
 * the one path {@link applyTheme} can never be called for: the user flips
 * macOS to Dark with the app open. The renderer repaints itself — its
 * `prefers-color-scheme` moves on its own — but the window's ground is main's
 * to update.
 *
 * The early return is not an optimisation. Electron emits `updated` on every
 * `themeSource` ASSIGNMENT as well as on a real OS flip, so without it this
 * handler re-enters on each of the app's own writes and pays a synchronous
 * `readSettings()` — `readFileSync` + `JSON.parse` + a per-key zod salvage — on
 * the launch path. Under an explicit preference the resolve ignores the OS
 * entirely, so returning early there discards only a provable no-op. Our own
 * write of `'system'` still re-enters, which costs one redundant paint and no
 * wrong result.
 *
 * It deliberately does NOT call {@link applyTheme}: writing `themeSource` from
 * inside a `nativeTheme` handler is how a listener feeds itself. The preference
 * is re-read at fire time rather than captured, so a listener registered once at
 * launch cannot go stale against a later settings write.
 */
export function watchSystemAppearance(
  readPreference: () => ThemePreference,
): void {
  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource !== 'system') {
      return;
    }
    paintWindows(resolvedTheme(readPreference()));
  });
}
