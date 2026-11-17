import type { GraphThread } from './graph-view';
import type { ThreadCardStatus } from './thread-card';

export const FIXTURE_NOW = Date.parse('2026-11-17T12:00:00Z');

const STATUSES: ThreadCardStatus[] = [
  'working',
  'waiting',
  'idle',
  'failed',
  'done',
];

const TITLES = [
  'Fix the login redirect',
  'Rebase billing on main',
  'Cache warmup',
  'Release notes',
  'Rename the settings page',
  'Wire the start conductor',
];

/** Synthetic threads for the graph's stories and specs; every second one works a board card. */
export function graphThreadsOf(count: number): GraphThread[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      id: `thread-${n}`,
      createdAt: new Date(FIXTURE_NOW - (count - index) * 60_000).toISOString(),
      view: {
        title: TITLES[index % TITLES.length]!,
        status: STATUSES[index % STATUSES.length]!,
        handle: `t${n}`,
        project: index % 2 === 0 ? 'QA Billing' : 'QA Cache',
        agentLabel: 'Claude',
        pullRequest:
          index % 3 === 0 ? { number: 400 + n, state: 'open' } : null,
        note: index === 1 ? 'waits for billing API v2' : null,
        activity: index % 2 === 0 ? 'running the **test suite**' : null,
        strip: {
          start: new Date(FIXTURE_NOW - 8 * 3_600_000).toISOString(),
          end: new Date(FIXTURE_NOW).toISOString(),
          spans: [
            {
              kind: 'work',
              start: new Date(FIXTURE_NOW - 2 * 3_600_000).toISOString(),
              end: null,
            },
          ],
          markers: [],
        },
        task:
          index % 2 === 0
            ? {
                id: `task-${n}`,
                identifier: `QA-${n}`,
                title: `${TITLES[index % TITLES.length]!} card`,
                status: 'in_progress',
              }
            : null,
      },
    };
  });
}
