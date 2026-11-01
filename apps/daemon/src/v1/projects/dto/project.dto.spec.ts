import { describe, expect, it } from 'vitest';

import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_INSTRUCTIONS_MAX,
  PROJECT_MAX_CONCURRENT_CEILING,
} from '../projects.types';
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

describe('project input schemas — description and instructions', () => {
  it('accepts both on create, and null clears them on a patch', () => {
    expect(
      createProjectSchema.parse({
        name: 'geniro-app',
        folder: '/tmp/x',
        description: 'what it is',
        instructions: 'line one\nline two\ttabbed',
      }),
    ).toMatchObject({ description: 'what it is' });
    expect(
      updateProjectSchema.parse({ description: null, instructions: null }),
    ).toEqual({ description: null, instructions: null });
  });

  it('refuses a null on create, where the key is only ever omitted', () => {
    expect(
      createProjectSchema.safeParse({
        name: 'x',
        folder: '/tmp/x',
        description: null,
      }).success,
    ).toBe(false);
  });

  it('bounds each field at its limit', () => {
    expect(
      updateProjectSchema.safeParse({
        description: 'a'.repeat(PROJECT_DESCRIPTION_MAX),
      }).success,
    ).toBe(true);
    expect(
      updateProjectSchema.safeParse({
        description: 'a'.repeat(PROJECT_DESCRIPTION_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateProjectSchema.safeParse({
        instructions: 'a'.repeat(PROJECT_INSTRUCTIONS_MAX),
      }).success,
    ).toBe(true);
    expect(
      updateProjectSchema.safeParse({
        instructions: 'a'.repeat(PROJECT_INSTRUCTIONS_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('refuses a control character, which would brick every turn spawned with it', () => {
    const withNul = `bad${String.fromCharCode(0)}text`;
    expect(
      updateProjectSchema.safeParse({ instructions: withNul }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({
        name: 'x',
        folder: '/tmp/x',
        description: withNul,
      }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ name: withNul, folder: '/tmp/x' })
        .success,
    ).toBe(false);
    expect(updateProjectSchema.safeParse({ name: withNul }).success).toBe(
      false,
    );
  });
});
