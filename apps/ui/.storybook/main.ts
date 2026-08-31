import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * The component catalog, dev-only.
 *
 * Nothing here is ever packaged: the dependencies are devDependencies that
 * `pnpm deploy --prod` strips, and `electron-builder.yml` ships `out/**` alone
 * while `build-storybook` writes to `storybook-static/`. That build exists for
 * CI, which is the only gate that compiles these story files at all — the type
 * checker covers their types and the unit suite never renders them.
 */
const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: {} },

  // Co-located with the components, so a story is found the way its spec is
  // and a moved component takes its story with it.
  stories: ['../src/renderer/**/*.stories.@(ts|tsx)'],

  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],

  viteFinal: (viteConfig) => {
    // `@storybook/react-vite` already supplies @vitejs/plugin-react; adding a
    // second copy breaks Fast Refresh. Tailwind is the one plugin from
    // `electron.vite.config.ts`'s renderer block it does NOT supply, and
    // without it every token resolves to nothing and the catalog renders
    // unstyled. The renderer declares no path aliases, so there are none to
    // restate here.
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()];
    return viteConfig;
  },
};

export default config;
