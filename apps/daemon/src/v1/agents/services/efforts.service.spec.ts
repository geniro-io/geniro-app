import { describe, expect, it, vi } from 'vitest';

import type { AgentEffortListing } from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import { EffortsService, type EffortsServiceOptions } from './efforts.service';
import { ProcessRegistry } from './process-registry';

function service(options: EffortsServiceOptions = {}): {
  efforts: EffortsService;
  claude: ClaudeAdapter;
  cursor: CursorAcpAdapter;
} {
  const claude = new ClaudeAdapter();
  const cursor = new CursorAcpAdapter();
  return {
    claude,
    cursor,
    efforts: new EffortsService(
      new AgentAdapterRegistry(claude, cursor),
      new ProcessRegistry(),
      // Real: `--version` on a binary that is absent in CI resolves to null,
      // which is a legitimate cache key and never throws.
      new AgentVersionService(),
      options,
    ),
  };
}

describe('EffortsService', () => {
  it('routes each kind to its own adapter and never invents a level', async () => {
    const { efforts } = service();
    // The six ids as LITERALS, not re-derived from the adapter: comparing the
    // service's answer against `new ClaudeAdapter().listEfforts()` restates the
    // production source on both sides of the assertion, so the vocabulary
    // itself — including `ultracode`, which the CLI accepts but does not
    // document — would survive being silently rewritten.
    const claudeLevels = await efforts.list('claude');
    expect(claudeLevels.efforts.map((effort) => effort.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
    // claude's are a property of the BINARY, so naming a model changes nothing —
    // its `--effort` takes the same words whichever model runs, and asking the
    // CLI per model would spend a probe to learn that.
    const perModel = await efforts.list('claude', 'opus');
    expect(perModel.efforts).toEqual(claudeLevels.efforts);
  });

  it('answers the CLI-wide union when no model has been chosen', async () => {
    // cursor's own five, which are NOT claude's: it has no `ultracode`. With no
    // model named this is a UNION and says so by being what every model's list
    // is a subset of — the picker exists before a model does, and answering
    // with nothing would render as a broken control.
    const { efforts, cursor } = service();
    const ask = vi.spyOn(cursor, 'listModelEfforts');

    expect(
      (await efforts.list('cursor-agent')).efforts.map((e) => e.id),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // …and the adapter was asked with a null model, which is what tells it to
    // answer from config rather than open a handshake.
    expect(ask).toHaveBeenCalledWith(null, expect.anything());
  });

  it('narrows to ONE model, which is the whole point of the model key', async () => {
    // Measured on cursor-agent 2026.08.11-e8db854: `grok-4.6` enumerates
    // `low|medium|high|xhigh` and no `max`, while `claude-opus-5` has all five.
    // The service must serve each its own answer rather than one list for the
    // CLI — offering `max` on Grok is what got reported.
    const { efforts, cursor } = service();
    vi.spyOn(cursor, 'listModelEfforts').mockImplementation(
      async (model): Promise<AgentEffortListing> => ({
        efforts:
          model === 'grok-4.6'
            ? [
                { id: 'low', label: 'Low' },
                { id: 'xhigh', label: 'Extra High' },
              ]
            : [{ id: 'max', label: 'Max' }],
        unavailableReason: null,
      }),
    );

    expect(
      (await efforts.list('cursor-agent', 'grok-4.6')).efforts.map((e) => e.id),
    ).toEqual(['low', 'xhigh']);
    expect(
      (await efforts.list('cursor-agent', 'claude-opus-5')).efforts.map(
        (e) => e.id,
      ),
    ).toEqual(['max']);
  });

  it('asks once per model and serves the rest from cache', async () => {
    // A cursor listing spawns a real handshake, so two chips mounting at once
    // must not launch two of them — and a second glance at the same model must
    // not launch any.
    const { efforts, cursor } = service();
    const ask = vi
      .spyOn(cursor, 'listModelEfforts')
      .mockResolvedValue({ efforts: [], unavailableReason: 'none here' });

    const [first, second] = await Promise.all([
      efforts.list('cursor-agent', 'grok-4.6'),
      efforts.list('cursor-agent', 'grok-4.6'),
    ]);
    await efforts.list('cursor-agent', 'grok-4.6');

    expect(first).toEqual(second);
    expect(ask).toHaveBeenCalledTimes(1);
    // A DIFFERENT model is a different question, and the key has to say so.
    await efforts.list('cursor-agent', 'claude-opus-5');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good answer when the probe fails', async () => {
    // A picker with no rows is a dead control. Hiding a level geniro merely
    // failed to confirm takes away something that works, so a failure degrades
    // to what was known — never to an empty list presented as an answer.
    const { efforts, cursor } = service({ ttlMs: 0 });
    const ask = vi
      .spyOn(cursor, 'listModelEfforts')
      .mockResolvedValueOnce({
        efforts: [{ id: 'xhigh', label: 'Extra High' }],
        unavailableReason: null,
      })
      .mockRejectedValueOnce(new Error('handshake died'));

    await efforts.list('cursor-agent', 'grok-4.6');
    const afterFailure = await efforts.list('cursor-agent', 'grok-4.6');

    expect(ask).toHaveBeenCalledTimes(2);
    expect(afterFailure.efforts.map((e) => e.id)).toEqual(['xhigh']);
  });

  it('falls back to the CLI union when a probe fails with nothing cached', async () => {
    const { efforts, cursor } = service();
    vi.spyOn(cursor, 'listModelEfforts').mockRejectedValue(new Error('nope'));

    expect(
      (await efforts.list('cursor-agent', 'grok-4.6')).efforts.map((e) => e.id),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('refuses a level a CLI with an EXHAUSTIVE list does not have', () => {
    const { efforts } = service();
    expect(efforts.accepts('claude', 'ultracode')).toBe(true);
    // Probe-verified as REJECTED by the CLI — the service must not pass it on.
    // claude's list is the whole vocabulary, so an unknown word is a mistake
    // the CLI would swallow and only this refusal can surface.
    expect(efforts.accepts('claude', 'ultrathink')).toBe(false);
  });

  it('lets a CLI whose list is only a UNION through, whatever the word', () => {
    // The defect this rule exists for. cursor's levels belong to the MODEL, so
    // `AdapterConfig.efforts` can only ever be a union of the ones seen — and
    // `gpt-5.2` offers `extra-high` on its own `reasoning` axis, which no other
    // model has. Checked exhaustively, the daemon refused that level at run
    // creation with `cursor-agent does not accept the reasoning effort
    // 'extra-high'`, so a chat on a level the picker had just offered could not
    // be started at all.
    const { efforts } = service();

    expect(efforts.accepts('cursor-agent', 'extra-high')).toBe(true);
    expect(efforts.accepts('cursor-agent', 'xhigh')).toBe(true);
    // …and that is not a hole: the value goes to the driver, which checks it
    // against the model that will run the turn and says so when it does not
    // apply. Revert `effortsAreExhaustive` and the first assertion fails.
  });

  it('still refuses every level for a CLI with no effort control', () => {
    // An empty list is not an incomplete one — it is the absence of the axis,
    // and the leniency above must not turn that into "anything goes".
    const { efforts, cursor } = service();
    vi.spyOn(cursor, 'listEfforts').mockReturnValue([]);

    expect(efforts.accepts('cursor-agent', 'xhigh')).toBe(false);
  });
});
