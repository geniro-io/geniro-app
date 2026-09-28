import { describe, expect, it } from 'vitest';

import { codexTurnPolicy } from './codex-policy.utils';

describe('codexTurnPolicy', () => {
  it('runs `auto` unattended: never asks and leaves the sandbox off', () => {
    expect(codexTurnPolicy('auto')).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
      autoAcceptFileChanges: false,
    });
  });

  it('gates `ask` on every untrusted command and patch, inside the workspace sandbox', () => {
    expect(codexTurnPolicy('ask')).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      autoAcceptFileChanges: false,
      plan: false,
    });
  });

  it('keeps `ask`’s gate for `acceptEdits` and lets file changes through', () => {
    // The per-turn sandbox is what every turn/start carries, so it is pinned
    // with the thread's: widening it would run each turn unsandboxed.
    expect(codexTurnPolicy('acceptEdits')).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      autoAcceptFileChanges: true,
      plan: false,
    });
  });

  it('runs `plan` in codex’s plan mode under a read-only sandbox', () => {
    expect(codexTurnPolicy('plan')).toMatchObject({
      plan: true,
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });

  it('runs a turn naming no mode (an internal probe) read-only with nothing to ask', () => {
    expect(codexTurnPolicy(undefined)).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      plan: false,
    });
  });
});
