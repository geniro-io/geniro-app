import { describe, expect, it, vi } from 'vitest';

import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type { AgentModelParameterListing } from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import {
  ModelParametersService,
  type ModelParametersServiceOptions,
} from './model-parameters.service';
import { ProcessRegistry } from './process-registry';

function service(options: ModelParametersServiceOptions = {}): {
  parameters: ModelParametersService;
  cursor: CursorAcpAdapter;
} {
  const claude = new ClaudeAdapter();
  const cursor = new CursorAcpAdapter({
    vocabularyStore: freshVocabularyStore(),
  });
  return {
    cursor,
    parameters: new ModelParametersService(
      new AgentAdapterRegistry(claude, cursor),
      new ProcessRegistry(),
      // Real: `--version` on a binary that is absent in CI resolves to null,
      // which is a legitimate cache key and never throws.
      new AgentVersionService(),
      options,
    ),
  };
}

const OPTIMIZE_FOR: AgentModelParameterListing = {
  parameters: [
    {
      id: 'optimize_for',
      label: 'Optimize For',
      values: [
        { id: 'balanced', label: 'Balance' },
        { id: 'cost', label: 'Cost' },
      ],
      current: 'balanced',
    },
  ],
  unavailableReason: null,
  exact: true,
};

describe('ModelParametersService — when the adapter throws', () => {
  it('answers an empty list WITH a reason when there is no prior answer', async () => {
    // The service's whole contract on this path: an adapter must not throw out
    // of here, because losing the list costs the user every chip on the row.
    // An empty list with no reason would be indistinguishable from a model that
    // genuinely offers nothing further.
    const { parameters, cursor } = service();
    vi.spyOn(cursor, 'listModelParameters').mockRejectedValue(
      new Error('handshake never settled'),
    );

    const listing = await parameters.list('cursor-agent', 'auto-smart');

    expect(listing.parameters).toEqual([]);
    expect(listing.unavailableReason).toContain('could not be asked');
    // NOT `exact`: the caller uses that to tell "this model has nothing" from
    // "we could not find out", which is the whole point of answering at all.
    expect(listing.exact).toBe(false);
  });

  it('keeps serving the LAST GOOD answer rather than blanking the row', async () => {
    // The clock is driven so the second call genuinely RE-FETCHES: inside the
    // TTL the cache answers and the adapter is never reached, so a same-key
    // repeat would pin the cache rather than this fallback.
    let clock = 0;
    const { parameters, cursor } = service({
      ttlMs: 1_000,
      now: () => clock,
    });
    const ask = vi
      .spyOn(cursor, 'listModelParameters')
      .mockResolvedValueOnce(OPTIMIZE_FOR)
      .mockRejectedValue(new Error('handshake never settled'));

    expect(await parameters.list('cursor-agent', 'auto-smart')).toEqual(
      OPTIMIZE_FOR,
    );

    clock = 5_000;
    const afterFailure = await parameters.list('cursor-agent', 'auto-smart');

    // The adapter WAS asked again and threw; what the caller gets is the list
    // it had, not an empty row.
    expect(ask).toHaveBeenCalledTimes(2);
    expect(afterFailure).toEqual(OPTIMIZE_FOR);
  });

  it('does not CACHE the stand-in — the next call asks the CLI again', async () => {
    // The `volatile(...)` wrapper is what makes this true, and reverting it to
    // a bare return type-checks: the cache's fetch signature accepts both. The
    // stand-in would then answer every request for the rest of the ten-minute
    // TTL, so one transient handshake failure would read as a model with no
    // settings for as long as the user kept looking at it.
    const { parameters, cursor } = service({ ttlMs: 10 * 60_000 });
    const ask = vi
      .spyOn(cursor, 'listModelParameters')
      .mockRejectedValueOnce(new Error('handshake never settled'))
      .mockResolvedValue(OPTIMIZE_FOR);

    const failed = await parameters.list('cursor-agent', 'auto-smart');
    expect(failed.parameters).toEqual([]);

    // Same key, well inside the TTL. A stored fallback would answer from cache
    // and leave this at one call.
    const recovered = await parameters.list('cursor-agent', 'auto-smart');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(recovered).toEqual(OPTIMIZE_FOR);
  });

  it('remembers the answer it DID get, so a good listing is asked once', async () => {
    // The other half of the volatile rule: a real answer must still be cached,
    // or the fix above would have been "never cache anything".
    const { parameters, cursor } = service({ ttlMs: 10 * 60_000 });
    const ask = vi
      .spyOn(cursor, 'listModelParameters')
      .mockResolvedValue(OPTIMIZE_FOR);

    await parameters.list('cursor-agent', 'auto-smart');
    await parameters.list('cursor-agent', 'auto-smart');

    expect(ask).toHaveBeenCalledTimes(1);
  });
});
