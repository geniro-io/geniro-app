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
  // `@packages/*` from SOURCE, through the root tsconfig's paths — what every
  // other workspace's suite already does via `defineBaseConfig`. Without it the
  // import resolved through each package's `exports` to its BUILT `dist/`, so
  // this suite tested whatever a package was last compiled as: after a pull,
  // until the next `pnpm build`, `run.dao.spec` failed on a `TimestampsEntity`
  // fix that was already in the source — and a regression in a package's
  // source would pass here just as quietly until somebody rebuilt it.
  resolve: { tsconfigPaths: true },
});
