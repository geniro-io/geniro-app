import { describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { EffortsService } from './efforts.service';

function service(): EffortsService {
  return new EffortsService(
    new AgentAdapterRegistry(new ClaudeAdapter(), new CursorAcpAdapter()),
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
    // cursor's own five, which are NOT claude's: it has no `ultracode`. The two
    // vocabularies overlapping in four values is exactly why the answer has to be
    // per-CLI — this list was `[]` until the ACP handshake declared
    // `parameterizedModelPicker` and its `effort` config option became reachable.
    expect(efforts.list('cursor-agent').map((e) => e.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('accepts only what the asked-of CLI lists', () => {
    const efforts = service();
    expect(efforts.accepts('claude', 'ultracode')).toBe(true);
    // Probe-verified as REJECTED by the CLI — the service must not pass it on.
    expect(efforts.accepts('claude', 'ultrathink')).toBe(false);
    // The per-CLI rule, asserted on a value the two genuinely DISAGREE about:
    // `ultracode` is claude's alone, and cursor's own agent rejects a level it
    // did not enumerate. A value both list must of course pass for both.
    expect(efforts.accepts('cursor-agent', 'ultracode')).toBe(false);
    expect(efforts.accepts('cursor-agent', 'xhigh')).toBe(true);
  });
});
