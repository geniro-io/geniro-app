// Installs the `window.geniro` stub. MUST stay the first import in this file:
// module imports evaluate in source order, and a component module that reads
// the preload bridge while it is being imported would otherwise throw before
// any decorator has run.
import './mocks/install-preload';
// `global.css` plus the story files' own utilities — see catalog.css.
import './catalog.css';

import type { Decorator, Preview } from '@storybook/react-vite';
import { useLayoutEffect } from 'react';

import {
  initTheme,
  setThemePreference,
} from '../src/renderer/theme/apply-theme';
import {
  isThemePreference,
  type ThemePreference,
  THEMES,
} from '../src/shared/themes';

/** Where an unreadable global lands — the same value `initialGlobals` sets. */
const FALLBACK_THEME: ThemePreference = 'light';

// Seeds `<html data-theme>` before the first story renders, exactly as
// `main.tsx` seeds it before `createRoot`.
initTheme();

/**
 * Drives the app's OWN theme writer rather than setting `data-theme` here.
 *
 * `apply-theme.ts` keeps the resolved theme in module state that
 * `useThemeAppearance()` reads, so a decorator that wrote the attribute
 * directly would paint the right palette while leaving that hook — and the
 * md-editor surface built on it — reporting the previous theme.
 */
// `story` rather than the conventional `Story`: the repo's naming-convention
// rule requires camelCase parameters, and calling the function is equivalent to
// rendering `<Story />` here.
const withTheme: Decorator = (story, context) => {
  // Guarded rather than cast: Storybook persists globals in the URL, so a
  // bookmarked `?globals=theme:<id>` can name a theme this build no longer
  // ships. `apply-theme` writes what it is handed, and an unknown id falls
  // through to light.css's bare `:root` arm silently — the exact fallthrough
  // `theme-tokens.spec.ts` exists to prevent. `themes.ts` says the guard
  // belongs at each boundary that takes an outside value; this is one.
  const raw: unknown = context.globals.theme;
  const theme = isThemePreference(raw) ? raw : FALLBACK_THEME;

  // Layout, not passive: an effect that ran after paint would show one frame
  // of the outgoing palette on every theme switch.
  useLayoutEffect(() => {
    setThemePreference(theme);
  }, [theme]);

  return (
    <div
      // Tailwind scans `src/renderer/**` only (`@source` in global.css), so a
      // utility class written in this directory would never be generated.
      // Tokens are read directly instead, which the design system allows.
      style={{
        background: 'var(--background)',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-family-sans)',
        // A story VIEW is a canvas the component should fill; a DOCS page is a
        // column of small previews, and `100vh` each turned every one of them
        // into a viewport of mostly empty ground — four stories deep on the
        // McpDialogButton page, which is the plain the dialog was reported
        // floating at the bottom of.
        minHeight: context.viewMode === 'docs' ? undefined : '100vh',
        padding: '1.5rem',
      }}>
      {story()}
    </div>
  );
};

const preview: Preview = {
  decorators: [withTheme],

  globalTypes: {
    theme: {
      description: 'Which theme the catalog paints in',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        // Built from the shipped manifest, so a theme added under
        // `styles/themes/` with its row in `shared/themes.ts` appears here
        // with no edit to this file.
        items: THEMES.map((t) => ({ value: t.id, title: t.label })),
        dynamicTitle: true,
      },
    },
  },

  initialGlobals: { theme: 'light' },

  parameters: {
    // The wrapper above paints the themed ground; Storybook's own background
    // switcher would sit under it and only ever show through as a border.
    backgrounds: { disable: true },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },

  tags: ['autodocs'],
};

export default preview;
