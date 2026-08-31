/**
 * The themes the app ships, and the one place a theme's IDENTITY lives.
 *
 * A theme is two halves in two places, because no one language can hold both.
 * Its VALUES — every colour, font, radius and shadow — live in one CSS file per
 * theme under `renderer/styles/themes/`, which is the only thing the design
 * system lets carry a colour. Its identity — which themes exist, what each is
 * called, and the one value the main process needs before any stylesheet has
 * loaded — lives here, in a module main, preload and the renderer can all
 * import.
 *
 * Adding a theme is therefore exactly two edits: a file there, a row here.
 */

/**
 * The id list is the single source every other shape here derives from — the
 * types, the picker's order, and the zod enum `ipc-schemas.ts` validates a
 * stored preference against. Adding an id makes `tsc` demand its row in
 * {@link THEME_BY_ID} below, so a theme cannot be half-added.
 */
export const THEME_IDS = ['light', 'dark'] as const;

/** A concrete theme — one CSS file under `renderer/styles/themes/<id>.css`. */
export type ThemeId = (typeof THEME_IDS)[number];

/** The Settings picker's rows, in order — System first, as the default. */
export const THEME_PREFERENCES = ['system', ...THEME_IDS] as const;

/**
 * What the user chose. `'system'` is not a theme: it defers to the OS, and is
 * resolved to a real {@link ThemeId} at the moment something needs to paint.
 */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * Whether a theme paints on a light ground or a dark one.
 *
 * Distinct from the theme's own id because two consumers need this coarser
 * answer and neither can take an id: `nativeTheme.themeSource`, which is how
 * the OS chrome and the renderer's `prefers-color-scheme` are told, and
 * `@uiw/react-md-editor`'s `data-color-mode`. For the two themes shipped today
 * the two happen to coincide; the field is what keeps a third theme from
 * having to be named `light` or `dark` to work.
 */
export type ThemeAppearance = 'light' | 'dark';

export interface ThemeDescriptor {
  id: ThemeId;
  /** The row's words in the Settings picker. */
  label: string;
  appearance: ThemeAppearance;
  /**
   * What the WINDOW is painted with underneath the page.
   *
   * A `BrowserWindow` with no `backgroundColor` is WHITE, and the window is not
   * always fully covered by painted web contents: macOS clips the bottom
   * corners out of the frame, and a resize exposes the newly revealed strip
   * until the renderer repaints it — which on a busy renderer is long enough to
   * look permanent. REPORTED as a white line across the bottom of the window,
   * and measured from inside the page at the same moment: the document filled
   * `window.innerHeight` exactly and `body` was already this colour, so the
   * band was never the page. It was the window showing through.
   *
   * TWIN PARSER: each value is its theme file's own `--background`. CSS cannot
   * read a TypeScript constant and main cannot read a custom property, so the
   * value is spelled once on each side and the two MUST be changed together —
   * the failure is silent and only visible for the moment a resize is in
   * flight. Under a dark theme it is louder than it was under one: the strip
   * would flash the light cream rather than a near-white.
   */
  windowBackground: string;
}

/**
 * A `Record` keyed by {@link ThemeId} rather than a list, so the compiler is
 * what enforces one entry per theme.
 */
const THEME_BY_ID: Record<ThemeId, Omit<ThemeDescriptor, 'id'>> = {
  light: { label: 'Light', appearance: 'light', windowBackground: '#f3f2ec' },
  dark: { label: 'Dark', appearance: 'dark', windowBackground: '#141312' },
};

export const THEMES: readonly ThemeDescriptor[] = THEME_IDS.map((id) => ({
  id,
  ...THEME_BY_ID[id],
}));

/**
 * Follow the OS unless the user says otherwise. A desktop app that ignores the
 * machine's appearance is the thing users notice first, and the picker is there
 * for the ones who want to override it.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

const SYSTEM_LABEL = 'System';

export function isThemeId(value: unknown): value is ThemeId {
  return THEME_IDS.some((id) => id === value);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || isThemeId(value);
}

export function themePreferenceLabel(preference: ThemePreference): string {
  if (preference === 'system') {
    return SYSTEM_LABEL;
  }
  return THEMES.find((theme) => theme.id === preference)?.label ?? preference;
}

/*
 * Neither lookup below is defended, and that is deliberate. A `ThemeId` cannot
 * be an id this build has no row for: the only value that ever reaches these
 * comes from `settings.json` through `settingsPatchSchema`'s `z.enum`, which
 * refuses anything outside this list, and `readSettings` then falls back to the
 * default. The guard belongs at that boundary — one that is exercised by a real
 * test — rather than as an unreachable fallback here.
 */
export function themeAppearance(id: ThemeId): ThemeAppearance {
  return THEME_BY_ID[id].appearance;
}

export function themeWindowBackground(id: ThemeId): string {
  return THEME_BY_ID[id].windowBackground;
}

/**
 * The theme to actually paint.
 *
 * `systemPrefersDark` is whatever the caller's side can see — `nativeTheme
 * .shouldUseDarkColors` in main, `matchMedia('(prefers-color-scheme: dark)')`
 * in the renderer. Those two agree by construction, because main sets
 * `nativeTheme.themeSource` from the same preference and Electron drives the
 * renderer's media query from it.
 */
export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemeId {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}
