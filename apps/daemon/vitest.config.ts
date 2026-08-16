import { defineConfig } from 'vitest/config';

import { SUITE_TIMEZONE } from '../../vitest.base';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Pinned, and not UTC — see `SUITE_TIMEZONE`. The stats module derives a
    // calendar day from LOCAL date parts, and under UTC a UTC-derived
    // implementation passes those assertions too. Spelled here rather than
    // inherited because this config does not extend the base one.
    env: { TZ: SUITE_TIMEZONE },
  },
});
