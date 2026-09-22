import { describe, expect, it } from 'vitest';

import { formatRoute, parseRoute, type Route } from './routing';

/** One example per arm, plus an id needing percent-encoding on both sides. */
const EXAMPLES: readonly { label: string; hash: string; route: Route }[] = [
  {
    label: 'an open chat',
    hash: '#/chats/run-123',
    route: { view: 'chats', runId: 'run-123' },
  },
  {
    label: 'the chat list with nothing open',
    hash: '#/chats',
    route: { view: 'chats', runId: null },
  },
  {
    label: 'an open workflow',
    hash: '#/workflows/dev-team',
    route: { view: 'workflows', slug: 'dev-team' },
  },
  {
    label: 'the workflow library with nothing open',
    hash: '#/workflows',
    route: { view: 'workflows', slug: null },
  },
  {
    label: 'an open task project',
    hash: '#/tasks/proj-9',
    route: { view: 'tasks', projectId: 'proj-9' },
  },
  {
    label: 'the task board with nothing open',
    hash: '#/tasks',
    route: { view: 'tasks', projectId: null },
  },
  {
    label: 'settings',
    hash: '#/settings',
    route: { view: 'settings' },
  },
  {
    label: 'stats',
    hash: '#/stats',
    route: { view: 'stats' },
  },
  {
    label: 'a run id with characters that need encoding',
    hash: '#/chats/a%2Fb%20c%3F%23d',
    route: { view: 'chats', runId: 'a/b c?#d' },
  },
];

describe('parseRoute', () => {
  for (const { label, hash, route } of EXAMPLES) {
    it(`parses ${label}`, () => {
      expect(parseRoute(hash)).toEqual(route);
    });
  }

  it('answers null for an empty hash', () => {
    expect(parseRoute('')).toBeNull();
    expect(parseRoute('#')).toBeNull();
  });

  it('answers null for an unrecognised view', () => {
    expect(parseRoute('#/nowhere')).toBeNull();
    expect(parseRoute('#/nowhere/123')).toBeNull();
  });

  it('answers null for a settings/stats hash carrying a stray id', () => {
    expect(parseRoute('#/settings/general')).toBeNull();
    expect(parseRoute('#/stats/today')).toBeNull();
  });

  it('answers null for malformed percent-encoding in the id segment', () => {
    // A lone `%` is not a valid escape — `decodeURIComponent` throws on it,
    // and a hash this build cannot decode names no route at all.
    expect(parseRoute('#/chats/%')).toBeNull();
    expect(parseRoute('#/workflows/100%')).toBeNull();
  });
});

describe('formatRoute', () => {
  for (const { label, hash, route } of EXAMPLES) {
    it(`formats ${label}`, () => {
      expect(formatRoute(route)).toBe(hash);
    });
  }
});

describe('round-trip', () => {
  for (const { label, route } of EXAMPLES) {
    it(`parseRoute(formatRoute(route)) recovers ${label}`, () => {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    });
  }
});
