import { defineConfig, mergeConfig } from 'vitest/config';

import { defineBaseConfig } from '../../vitest.base';
import pkg from './package.json';

// Default environment is node; component tests opt into jsdom per-file via the
// `// @vitest-environment jsdom` pragma on line 1.
export default mergeConfig(
  defineBaseConfig(),
  defineConfig({
    test: {
      name: pkg.name,
      environment: 'node',
      include: ['src/**/*.spec.{ts,tsx}'],
    },
  }),
);
