import { describe, expect, it } from 'vitest';

import { PROJECT_MAX_CONCURRENT_CEILING } from '../projects.types';
import { createProjectSchema, updateProjectSchema } from './project.dto';

/**
 * The autopilot policy became WRITABLE with the conductor that honours it.
 * These pin the boundary the schema draws, which is the whole of what a client
 * may set: the three policy fields yes, the breaker's own running count no.
 */
describe('project input schemas — the autopilot policy', () => {
  it('accepts the three policy fields on create', () => {
    const parsed = createProjectSchema.parse({
      name: 'geniro-app',
      folder: '/tmp/x',
      autopilotEnabled: true,
      autopilotIntakeStatus: 'todo',
      autopilotMaxConcurrent: 2,
    });

    expect(parsed.autopilotEnabled).toBe(true);
    expect(parsed.autopilotIntakeStatus).toBe('todo');
    expect(parsed.autopilotMaxConcurrent).toBe(2);
  });

  it('accepts them on a patch, one at a time', () => {
    expect(updateProjectSchema.parse({ autopilotEnabled: false })).toEqual({
      autopilotEnabled: false,
    });
    expect(
      updateProjectSchema.parse({ autopilotIntakeStatus: 'backlog' }),
    ).toEqual({ autopilotIntakeStatus: 'backlog' });
  });

  // Refused rather than clamped: each concurrent task takes its own git
  // worktree, and a client that asked for fifty and silently got five would
  // believe it had fifty.
  it('refuses a cap above the ceiling, and one below one', () => {
    expect(
      updateProjectSchema.safeParse({
        autopilotMaxConcurrent: PROJECT_MAX_CONCURRENT_CEILING + 1,
      }).success,
    ).toBe(false);
    expect(
      updateProjectSchema.safeParse({ autopilotMaxConcurrent: 0 }).success,
    ).toBe(false);
    expect(
      updateProjectSchema.safeParse({
        autopilotMaxConcurrent: PROJECT_MAX_CONCURRENT_CEILING,
      }).success,
    ).toBe(true);
  });

  // The breaker's count is the daemon's, not the client's. A client that could
  // write it could hold the breaker open, or clear it without re-arming —
  // which is the one act the breaker exists to make deliberate.
  it('does not let a client write the failure streak', () => {
    const patched = updateProjectSchema.parse({
      autopilotEnabled: true,
      autopilotFailureStreak: 0,
    });

    expect(patched).not.toHaveProperty('autopilotFailureStreak');

    const created = createProjectSchema.parse({
      name: 'p',
      folder: '/tmp/x',
      autopilotFailureStreak: 0,
    });

    expect(created).not.toHaveProperty('autopilotFailureStreak');
  });

  // The three break the nullable pattern every field beside them follows, and
  // it is the column that decides: NOT NULL with a default, so there is no
  // "unset" state a null could name.
  it('refuses an explicit null on a policy field', () => {
    expect(
      updateProjectSchema.safeParse({ autopilotEnabled: null }).success,
    ).toBe(false);
    expect(
      updateProjectSchema.safeParse({ autopilotIntakeStatus: null }).success,
    ).toBe(false);
  });
});
