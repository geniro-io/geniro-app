import { describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAdapter } from '../adapters/cursor/cursor.adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { EffortsService } from './efforts.service';

function service(): EffortsService {
  return new EffortsService(
    new AgentAdapterRegistry(new ClaudeAdapter(), new CursorAdapter()),
  );
}

describe('EffortsService', () => {
  it('routes each kind to its own adapter and never invents a level', () => {
    const efforts = service();
    // The six ids as LITERALS, not re-derived from the adapter: comparing the
    // service's answer against `new ClaudeAdapter().listEfforts()` restates the
    // production source on both sides of the assertion, so the vocabulary
    // itself — including `ultracode`, which the CLI accepts but does not
    // document — would survive being silently rewritten.
    expect(efforts.list('claude').map((effort) => effort.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
    // The empty list is the ANSWER for a CLI with no effort control, not a
    // failure — it is what makes the composer omit the chip entirely.
    expect(efforts.list('cursor-agent')).toEqual([]);
  });

  it('accepts only what the asked-of CLI lists', () => {
    const efforts = service();
    expect(efforts.accepts('claude', 'ultracode')).toBe(true);
    // Probe-verified as REJECTED by the CLI — the service must not pass it on.
    expect(efforts.accepts('claude', 'ultrathink')).toBe(false);
    // A level claude accepts is still refused for cursor: the answer is
    // per-CLI, never a shared vocabulary.
    expect(efforts.accepts('cursor-agent', 'high')).toBe(false);
  });
});
