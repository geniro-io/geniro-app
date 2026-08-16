import swc from 'unplugin-swc';

/**
 * The timezone every suite runs in.
 *
 * Pinned, and deliberately NOT UTC. Several tests assert that a calendar day is
 * derived from LOCAL date parts rather than UTC ones — which day a turn's spend
 * is filed under is what the whole per-day chart is keyed on — and under UTC
 * those assertions hold for a UTC implementation too, so they certified a
 * behaviour nothing verified in the environment CI actually runs. This zone is
 * behind UTC and observes daylight saving, so a UTC-derived key produces the
 * wrong day and a fixed-86,400,000ms day-walk drifts an hour across a
 * transition — both of which the existing assertions then catch.
 */
export const SUITE_TIMEZONE = 'America/Los_Angeles';

export const defineBaseConfig = () => ({
  test: {
    env: { TZ: SUITE_TIMEZONE },
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: {
          syntax: 'typescript',
          tsx: true,
          decorators: true,
        },
        transform: {
          react: {
            runtime: 'automatic',
          },
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  oxc: false as const,
});
