import { Check } from 'lucide-react';
import type React from 'react';

import {
  THEME_PREFERENCES,
  type ThemeId,
  type ThemePreference,
  themePreferenceLabel,
  THEMES,
} from '../../shared/themes';
import { cn } from './ui/utils';

/**
 * A theme, painted BY that theme.
 *
 * The face stamps `data-theme` on its own box, so every colour in it is read
 * from that theme's own token file through the ordinary utilities. There is no
 * second copy of the palette here to drift out of step with the real one, and a
 * theme added under `styles/themes/` previews itself with no edit to this file.
 * It works because a theme file keys on a bare `[data-theme='…']` attribute
 * selector rather than on `:root`, so the block applies to any element wearing
 * the attribute and its custom properties inherit into the subtree.
 *
 * What it draws is the app's own arrangement rather than a row of paint chips:
 * a sidebar against a page, two lines of text on it, and the accent. A user
 * picking a theme is asking what the WINDOW will look like, and four colours in
 * a row cannot answer that — the contrast between a surface and the text on it
 * is most of what separates one theme from another.
 */
function ThemeFace({ theme }: { theme: ThemeId }): React.JSX.Element {
  return (
    <span
      data-theme={theme}
      data-slot="theme-face"
      className="flex h-full w-full bg-background">
      <span className="w-1/4 shrink-0 border-r border-border bg-sidebar" />
      <span className="flex min-w-0 flex-1 flex-col gap-1 p-2">
        <span className="h-1 w-4/5 rounded-full bg-foreground/60" />
        <span className="h-1 w-3/5 rounded-full bg-muted-foreground/50" />
        <span className="mt-auto h-2 w-1/2 rounded-xs bg-primary" />
      </span>
    </span>
  );
}

/*
 * Read from the manifest rather than written as `'light'` / `'dark'`: the
 * appearance is exactly the axis `System` defers to the OS about, so the two
 * halves are "whichever theme this build paints on each ground". A manifest
 * shipping only one ground draws that one across the whole swatch rather than
 * half a picture.
 */
const LIGHT_FACE = THEMES.find((theme) => theme.appearance === 'light')?.id;
const DARK_FACE = THEMES.find((theme) => theme.appearance === 'dark')?.id;

/** The two grounds side by side — the idiom every OS uses for "follow me". */
function SystemFace(): React.JSX.Element {
  const faces = [LIGHT_FACE, DARK_FACE].filter(
    (id): id is ThemeId => id !== undefined,
  );
  return (
    <span className="flex h-full w-full">
      {faces.map((id) => (
        <span key={id} className="min-w-0 flex-1">
          <ThemeFace theme={id} />
        </span>
      ))}
    </span>
  );
}

/**
 * The Appearance setting: one swatch per theme the app ships, plus System.
 *
 * A `Select` was here before it, and a dropdown is the wrong control for this
 * particular choice — not as a matter of taste, but because the rows of that
 * menu were the WORDS `System`, `Light`, `Dark`, which is the one thing about a
 * theme a user already knows. What they cannot know is what the window will
 * look like, and a dropdown hides even the words until it is opened. Three
 * options worth showing at rest is the case `SegmentedControl` documents; this
 * goes further only because the option has a picture.
 *
 * `aria-pressed` toggles in a named `role="group"`, following
 * `SegmentedControl`: a `radiogroup` promises arrow-key roving and a single tab
 * stop, and a half-built one is worse for a keyboard user than an honest run of
 * buttons. Selection is a check beside the name as well as a border, since
 * colour is not a label — and here the swatches are already made of colour.
 */
export function ThemePicker({
  value,
  onSelect,
  className,
}: {
  value: ThemePreference;
  onSelect: (next: ThemePreference) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Theme"
      data-slot="theme-picker"
      className={cn('flex flex-wrap gap-3', className)}>
      {THEME_PREFERENCES.map((preference) => {
        const selected = preference === value;
        return (
          <button
            key={preference}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(preference)}
            className="group flex w-28 shrink-0 flex-col gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <span
              className={cn(
                'block h-16 w-full overflow-hidden rounded-md border transition-colors',
                selected
                  ? 'border-primary ring-2 ring-primary/30'
                  : 'border-border group-hover:border-muted-foreground/40',
              )}>
              {preference === 'system' ? (
                <SystemFace />
              ) : (
                <ThemeFace theme={preference} />
              )}
            </span>
            <span
              className={cn(
                'flex items-center gap-1 text-xs',
                selected
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground',
              )}>
              {selected ? <Check className="size-3 shrink-0" /> : null}
              {themePreferenceLabel(preference)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
