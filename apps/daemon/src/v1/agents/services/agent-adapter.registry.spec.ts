import { describe, expect, it } from 'vitest';

import type { AgentKind } from '../../runs/runs.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAdapter } from '../adapters/cursor/cursor.adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';

function registry(): AgentAdapterRegistry {
  return new AgentAdapterRegistry(new ClaudeAdapter(), new CursorAdapter());
}

describe('AgentAdapterRegistry', () => {
  it('resolves each registered kind to that CLI’s own adapter', () => {
    expect(registry().for('claude').config.kind).toBe('claude');
    expect(registry().for('cursor-agent').config.kind).toBe('cursor-agent');
  });

  it('THROWS on an unregistered kind instead of falling back to one', () => {
    // The whole reason this class exists: the five private dispatches it
    // replaced were `kind === 'claude' ? claude : cursor`, which silently
    // routes any future third kind to cursor. Entering this branch on purpose,
    // because a guard nothing tests is a guard a later cleanup deletes.
    expect(() => registry().for('gemini-cli' as AgentKind)).toThrow(
      /no adapter is registered for agent kind 'gemini-cli'/,
    );
  });
});
