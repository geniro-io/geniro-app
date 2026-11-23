import { resolve } from 'node:path';

import { defineConfig, mergeConfig } from 'vitest/config';

import { defineBaseConfig } from '../../vitest.base';
import pkg from './package.json';
import { changelogPlugin } from './scripts/changelog.ts';

// Default environment is node; component tests opt into jsdom per-file via the
// `// @vitest-environment jsdom` pragma on line 1.
export default mergeConfig(
  defineBaseConfig(),
  defineConfig({
    plugins: [changelogPlugin(resolve(import.meta.dirname, '..', '..'))],
    test: {
      name: pkg.name,
      environment: 'node',
      include: ['src/**/*.spec.{ts,tsx}', 'scripts/**/*.spec.ts'],
    },
  }),
);
