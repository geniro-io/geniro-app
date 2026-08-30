import { type ProfileColor } from '../../shared/contracts';

/**
 * The app's ONE colour palette, as classes — the eight `--color-group-*` tokens
 * the sidebar's groups have always used, now shared with the named agent
 * configurations in Settings.
 *
 * It lives here rather than in either feature because it belongs to NEITHER:
 * the tokens are the app's, and two features happen to pick from them. Left in
 * `chats/run-group.ts` (where it started) a second caller would have had to
 * import a chats module from Settings or write the eight class names again —
 * and a second copy is how one palette comes to have a colour the other lacks.
 *
 * A LOOKUP rather than `bg-group-${color}`: Tailwind scans source text for
 * whole class names, so an interpolated one is never emitted and every swatch
 * would render transparent.
 */
export const PALETTE_DOT_CLASS: Record<ProfileColor, string> = {
  blue: 'bg-group-blue',
  purple: 'bg-group-purple',
  green: 'bg-group-green',
  orange: 'bg-group-orange',
  pink: 'bg-group-pink',
  indigo: 'bg-group-indigo',
  teal: 'bg-group-teal',
  red: 'bg-group-red',
};

/** Human labels for a colour picker, in the order the palette lists them. */
export const PALETTE_LABEL: Record<ProfileColor, string> = {
  blue: 'Blue',
  purple: 'Purple',
  green: 'Green',
  orange: 'Orange',
  pink: 'Pink',
  indigo: 'Indigo',
  teal: 'Teal',
  red: 'Red',
};

/**
 * The same palette as a LEFT BORDER — a colour worn by a row rather than by a
 * dot beside it.
 *
 * Spelled out rather than interpolated for the reason the dots are: Tailwind
 * scans source text for whole class names, so `border-l-group-${color}` is
 * never emitted and every row would take the default border colour.
 */
export const PALETTE_BORDER_CLASS: Record<ProfileColor, string> = {
  blue: 'border-l-group-blue',
  purple: 'border-l-group-purple',
  green: 'border-l-group-green',
  orange: 'border-l-group-orange',
  pink: 'border-l-group-pink',
  indigo: 'border-l-group-indigo',
  teal: 'border-l-group-teal',
  red: 'border-l-group-red',
};
