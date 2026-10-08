import { describe, expect, it } from 'vitest';

import type { CalleeTurnOutcome, WorkflowAgentNode } from '../graphs.types';
import {
  fallsThroughPool,
  poolAttemptOrder,
  poolAttempts,
  poolHandOffPrompt,
  poolMemberLabel,
  poolMemberNode,
  poolSize,
} from './agent-pool';

function pooled(): WorkflowAgentNode {
  return {
    id: 'engineer',
    kind: 'agent',
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    configDir: '/profiles/work',
    role: 'Build things.',
    description: 'Builds.',
    approval: 'auto',
    pool: [
      { agent: 'claude', configDir: '/profiles/personal' },
      { agent: 'codex', model: 'gpt-5.5' },
    ],
  };
}

function failed(patch: Partial<CalleeTurnOutcome> = {}): CalleeTurnOutcome {
  return {
    status: 'failed',
    finalText: null,
    error: 'boom',
    failureClass: 'crashed',
    resetsAt: null,
    sessionId: null,
    ...patch,
  };
}

describe('poolMemberNode', () => {
  it('member 1 is the node’s own settings, without the pool', () => {
    const member = poolMemberNode(pooled(), 1);
    expect(member).toMatchObject({
      agent: 'claude',
      model: 'opus',
      configDir: '/profiles/work',
    });
    expect(member?.pool).toBeUndefined();
  });

  it('a later member REPLACES the CLI settings whole and keeps the node’s own text', () => {
    const member = poolMemberNode(pooled(), 2);
    expect(member).toEqual({
      id: 'engineer',
      kind: 'agent',
      agent: 'claude',
      configDir: '/profiles/personal',
      role: 'Build things.',
      description: 'Builds.',
      approval: 'auto',
    });
  });

  it('a member compacts at its own threshold, and never when it states none', () => {
    const node: WorkflowAgentNode = {
      ...pooled(),
      autoCompactPercent: 80,
      pool: [{ agent: 'codex', autoCompactPercent: 60 }, { agent: 'codex' }],
    };
    expect(poolMemberNode(node, 1)?.autoCompactPercent).toBe(80);
    expect(poolMemberNode(node, 2)?.autoCompactPercent).toBe(60);
    expect(poolMemberNode(node, 3)).not.toHaveProperty('autoCompactPercent');
  });

  it('a member runs without its OWN switched-off MCP servers, never member 1’s', () => {
    const node: WorkflowAgentNode = {
      ...pooled(),
      mcpDisabled: ['codegraph'],
      pool: [
        { agent: 'claude', mcpDisabled: ['playwright'] },
        { agent: 'codex' },
      ],
    };
    expect(poolMemberNode(node, 1)?.mcpDisabled).toEqual(['codegraph']);
    expect(poolMemberNode(node, 2)?.mcpDisabled).toEqual(['playwright']);
    // A member naming none switches nothing off — member 1's list names
    // another profile's servers.
    expect(poolMemberNode(node, 3)).not.toHaveProperty('mcpDisabled');
  });

  it('a member runs its own approval mode, else the node’s', () => {
    const node: WorkflowAgentNode = {
      ...pooled(),
      approval: 'acceptEdits',
      pool: [{ agent: 'codex', approval: 'auto' }, { agent: 'codex' }],
    };
    expect(poolMemberNode(node, 2)?.approval).toBe('auto');
    expect(poolMemberNode(node, 3)?.approval).toBe('acceptEdits');
  });

  it('answers null for a number the pool does not have', () => {
    expect(poolMemberNode(pooled(), 0)).toBeNull();
    expect(poolMemberNode(pooled(), 4)).toBeNull();
    expect(poolMemberNode(pooled(), 1.5)).toBeNull();
  });

  it('a node with no pool is a pool of one', () => {
    const { pool: _pool, ...single } = pooled();
    expect(poolSize(single)).toBe(1);
    expect(poolSize(pooled())).toBe(3);
  });
});

describe('poolAttemptOrder', () => {
  it('rotates from the start member', () => {
    expect(poolAttemptOrder(3, 2, () => false)).toEqual([2, 3, 1]);
  });

  it('moves cooling members to the back, still in rotation order', () => {
    expect(poolAttemptOrder(4, 2, (m) => m === 2 || m === 4)).toEqual([
      3, 1, 2, 4,
    ]);
  });
});

describe('poolAttempts', () => {
  it('resolves each member in the order given', () => {
    const attempts = poolAttempts(pooled(), [3, 1]);
    expect(attempts.map((a) => [a.member, a.node.agent])).toEqual([
      [3, 'codex'],
      [1, 'claude'],
    ]);
  });
});

describe('fallsThroughPool', () => {
  it('hands on a usage limit or a lapsed sign-in even after work', () => {
    expect(
      fallsThroughPool(failed({ failureClass: 'rate_limited' }), true),
    ).toBe(true);
    expect(
      fallsThroughPool(failed({ failureClass: 'auth_expired' }), true),
    ).toBe(true);
  });

  it('hands on any failure that came before a single tool call', () => {
    expect(fallsThroughPool(failed(), false)).toBe(true);
  });

  it('keeps a failure mid-work, and never hands on a success or a cancel', () => {
    expect(fallsThroughPool(failed(), true)).toBe(false);
    expect(
      fallsThroughPool(
        failed({ status: 'cancelled', failureClass: null }),
        false,
      ),
    ).toBe(false);
    expect(
      fallsThroughPool(
        failed({ status: 'completed', failureClass: null }),
        false,
      ),
    ).toBe(false);
  });
});

describe('poolMemberLabel', () => {
  it('names the CLI, then what tells the member apart', () => {
    expect(
      poolMemberLabel({
        agent: 'claude',
        model: 'opus',
        effort: 'high',
        configDir: '/profiles/work',
      }),
    ).toBe('claude · opus · effort high · separate profile');
    expect(poolMemberLabel({ agent: 'codex' })).toBe('codex');
  });
});

describe('poolHandOffPrompt', () => {
  it('passes the task on unchanged when nothing was said into the call', () => {
    expect(poolHandOffPrompt('build it', [])).toBe('build it');
  });

  it('carries what was said into the call after the task, in order', () => {
    expect(poolHandOffPrompt('build it', ['use red', 'skip tests'])).toBe(
      'build it\n\nMessages sent about this task after it was handed out, in order:\n- use red\n- skip tests',
    );
  });
});
