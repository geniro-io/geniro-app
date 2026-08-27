import { nativeTheme } from 'electron';

/**
 * Tell macOS the app is light, because its CSS already is.
 *
 * `styles/global.css` declares one palette and says so ("light-only today"),
 * but nothing ever told the OS — so every surface the app does NOT paint was
 * drawn for whatever appearance the machine is set to. On a Mac in Dark mode
 * that is wrong in one place nobody can miss: the window buttons.
 *
 * macOS draws an INACTIVE traffic light as a translucent disc tinted for the
 * appearance — near-white under Dark, grey under Light — so an unfocused
 * window rendered three white discs onto the title bar's own near-white and
 * the buttons simply vanished. Measured on macOS 26: fill `#ffffff` against
 * `#fdfcfa`, a 1.02:1 ratio; with this line the same window draws them grey,
 * which is the reported "как на других приложениях мака".
 *
 * The cause is the appearance and NOT the title bar this app draws itself:
 * probed with three `hiddenInset` windows over the same near-white ground,
 * with and without `trafficLightPosition`, all three vanished under Dark and
 * all three came back under `'light'`. Which also means recolouring the band
 * would have been the wrong fix — it would have bought back the three buttons
 * and left every other unpainted native surface (the context menu, scrollbars,
 * system dialogs) still dark against a light app.
 *
 * `'light'` rather than `'system'` for exactly as long as the palette is
 * light-only. A dark theme is what changes this line, not a preference.
 */
export function applyNativeAppearance(): void {
  nativeTheme.themeSource = 'light';
}
