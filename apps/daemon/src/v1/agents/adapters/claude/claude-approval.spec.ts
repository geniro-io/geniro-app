import { describe, expect, it } from 'vitest';

import type { ClaudeModesCapability } from '../../chat.types';
import { claudeApprovalSupport } from './claude-approval';

function verdict(
  overrides: Partial<ClaudeModesCapability> = {},
): ClaudeModesCapability {
  return {
    acceptEdits: 'unknown',
    plan: 'unknown',
    version: null,
    probedAt: null,
    reason: null,
    ...overrides,
  };
}

describe('claudeApprovalSupport', () => {
  it('maps an unprobed mode to ABSENT, never to false', () => {
    // The distinction the whole degrade rests on: `false` means "proved
    // rejected" and degrades the turn, while absent means "nobody asked" and
    // must leave the requested mode alone. Collapsing `unknown` into `false`
    // would silently downgrade every turn on a machine that has not probed yet.
    const support = claudeApprovalSupport(verdict());
    expect(support.supported).toEqual({});
    expect('acceptEdits' in support.supported).toBe(false);
  });

  it('maps a pass to true and a fail to false, per mode', () => {
    expect(
      claudeApprovalSupport(verdict({ acceptEdits: 'fail', plan: 'pass' }))
        .supported,
    ).toEqual({ acceptEdits: false, plan: true });
  });

  it('carries only the probed modes — nothing is invented for the rest', () => {
    const support = claudeApprovalSupport(
      verdict({ acceptEdits: 'pass', plan: 'fail' }),
    );
    expect(Object.keys(support.supported).sort()).toEqual([
      'acceptEdits',
      'plan',
    ]);
  });
});
