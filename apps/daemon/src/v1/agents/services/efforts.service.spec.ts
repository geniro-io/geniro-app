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
        exact: true,
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
    const ask = vi.spyOn(cursor, 'listModelEfforts').mockResolvedValue({
      efforts: [],
      unavailableReason: 'none here',
      exact: true,
    });

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
        exact: true,
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

  it('refuses a level a CLI with an EXHAUSTIVE list does not have', async () => {
    const { efforts } = service();
    expect(efforts.accepts('claude', 'ultracode')).toBe(true);
    // Probe-verified as REJECTED by the CLI — the service must not pass it on.
    // claude's list is the whole vocabulary, so an unknown word is a mistake
    // the CLI would swallow and only this refusal can surface.
    expect(efforts.accepts('claude', 'ultrathink')).toBe(false);
  });

  it('lets a UNION-list CLI through whatever the word when NO model is named', async () => {
    // The defect this leniency exists for. cursor's levels belong to the MODEL,
    // so `AdapterConfig.efforts` can only ever be a union of the ones seen —
    // and `gpt-5.2` offers `extra-high` on its own `reasoning` axis, which no
    // other model has. Checked against the union, the daemon refused that level
    // at run creation, so a chat on a level the picker had just offered could
    // not be started at all. With no model named there is nothing better to ask.
    const { efforts } = service();

    expect(efforts.accepts('cursor-agent', 'extra-high')).toBe(true);
    expect(efforts.accepts('cursor-agent', 'xhigh')).toBe(true);
  });

  it('refuses a level the NAMED MODEL does not list', async () => {
    // What the union check had to give up, bought back by asking the model that
    // will actually run the turn: a level no model lists is a mistake only this
    // refusal can surface, since the value would otherwise be stored on the run
    // and re-warned about by the driver on every turn.
    const { efforts, cursor } = service();
    vi.spyOn(cursor, 'listModelEfforts').mockResolvedValue({
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
      ],
      unavailableReason: null,
      exact: true,
    });
    // The picker's own fetch is what holds the listing. Without one there is
    // nothing to refuse against, which the cold-cache test below pins.
    await efforts.list('cursor-agent', 'grok-4.6');

    expect(efforts.accepts('cursor-agent', 'ultracode', 'grok-4.6')).toBe(
      false,
    );
    expect(efforts.accepts('cursor-agent', 'high', 'grok-4.6')).toBe(true);
  });

  it('never refuses from a COLD cache — it must not spawn to decide', async () => {
    // The refusal is synchronous by design: asking here would put a
    // multi-second CLI handshake inside `POST /v1/chats`, so a run started from
    // a saved configuration would wait on a question the picker asks. With
    // nothing held the answer is lenient and the driver reports per turn.
    const { efforts, cursor } = service();
    const ask = vi.spyOn(cursor, 'listModelEfforts');

    expect(efforts.accepts('cursor-agent', 'ultracode', 'grok-4.6')).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('accepts a level the MODEL lists but the union does not', async () => {
    // The other direction of the same fix: asking the model is what makes
    // `extra-high` legal, and it is absent from `AdapterConfig.efforts`.
    const { efforts, cursor } = service();
    vi.spyOn(cursor, 'listModelEfforts').mockResolvedValue({
      efforts: [{ id: 'extra-high', label: 'Extra high' }],
      unavailableReason: null,
      exact: true,
    });

    await efforts.list('cursor-agent', 'gpt-5.2');

    expect(efforts.accepts('cursor-agent', 'extra-high', 'gpt-5.2')).toBe(true);
  });

  it('does not refuse on a listing that STOOD IN for the model', async () => {
    // A refusal may not be built on a guess, and the guess does not arrive as a
    // failure: every fallback in the adapter contract RESOLVES with the CLI-wide
    // superset — a probe that timed out, and equally a reply that enumerated
    // nothing — so the shape below is what a caller actually sees. Refusing on
    // it rejects `extra-high`, a real `gpt-5.2` level the picker had just
    // offered, whenever the CLI merely could not be asked.
    //
    // Mocking a REJECTION here instead would pin nothing: `listModelEfforts` is
    // documented MUST NOT throw and neither shipped adapter does, so the
    // leniency would go unverified while the real path refused.
    const { efforts, cursor } = service();
    vi.spyOn(cursor, 'listModelEfforts').mockResolvedValue({
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'Extra High' },
        { id: 'max', label: 'Max' },
      ],
      unavailableReason: null,
      exact: false,
    });

    await efforts.list('cursor-agent', 'gpt-5.2');

    expect(efforts.accepts('cursor-agent', 'extra-high', 'gpt-5.2')).toBe(true);
    // …and a level that is not in ANY list is still let through, because an
    // inexact listing is not evidence about the level either way.
    expect(efforts.accepts('cursor-agent', 'ultracode', 'gpt-5.2')).toBe(true);
  });

  it('does not refuse when the MODEL has no effort axis at all', async () => {
    // `auto-smart` enumerates no effort option. That is an answer about the
    // model, not about the level, so the stored value is left alone and the
    // driver reports it per turn — refusing here would block a chat over a
    // setting the model simply ignores.
    const { efforts, cursor } = service();
    vi.spyOn(cursor, 'listModelEfforts').mockResolvedValue({
      efforts: [],
      unavailableReason: 'auto-smart has no reasoning-effort setting',
      exact: true,
    });

    await efforts.list('cursor-agent', 'auto-smart');

    expect(efforts.accepts('cursor-agent', 'xhigh', 'auto-smart')).toBe(true);
  });

  it('still refuses every level for a CLI with no effort control', async () => {
    // An empty list is not an incomplete one — it is the absence of the axis,
    // and the leniency above must not turn that into "anything goes".
    const { efforts, cursor } = service();
    vi.spyOn(cursor, 'listEfforts').mockReturnValue([]);

    expect(efforts.accepts('cursor-agent', 'xhigh')).toBe(false);
  });
});
