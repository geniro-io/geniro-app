import { describe, expect, it, vi } from 'vitest';

import type { AgentContextWindowListing } from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import {
  ContextWindowsService,
  type ContextWindowsServiceOptions,
} from './context-windows.service';
import { ProcessRegistry } from './process-registry';

function service(options: ContextWindowsServiceOptions = {}): {
  windows: ContextWindowsService;
  claude: ClaudeAdapter;
  cursor: CursorAcpAdapter;
} {
  const claude = new ClaudeAdapter();
  const cursor = new CursorAcpAdapter();
  return {
    claude,
    cursor,
    windows: new ContextWindowsService(
      new AgentAdapterRegistry(claude, cursor),
      new ProcessRegistry(),
      // Real: `--version` on a binary that is absent in CI resolves to null,
      // which is a legitimate cache key and never throws.
      new AgentVersionService(),
      options,
    ),
  };
}

const LISTING: AgentContextWindowListing = {
  windows: [
    { id: '300k', label: '300k' },
    { id: '1m', label: '1m' },
  ],
  unavailableReason: null,
  exact: true,
};

describe('ContextWindowsService', () => {
  it('answers a CLI with no such control with its own sentence, asking nothing', async () => {
    // claude runs each model at the window that model has — there is no flag,
    // and the sentence names what DOES change it. Asking the binary would spend
    // a probe to learn a static fact.
    const { windows, claude } = service();
    const spy = vi.spyOn(claude, 'listModelContextWindows');

    const listing = await windows.list('claude', 'opus');

    expect(listing.windows).toEqual([]);
    expect(listing.unavailableReason).toBe(
      claude.getConfig().contextWindowsUnavailableReason,
    );
    // The adapter IS consulted — the reason is its answer, not a branch here.
    expect(spy).toHaveBeenCalledOnce();
  });

  it('says a model has to be picked before there is anything to list', async () => {
    // Unlike the effort chip there is no CLI-wide union to fall back on: swept
    // across a cursor account's 34 models, twelve carry the axis and their
    // vocabularies differ, so "what does this CLI offer at all" has no answer.
    const { windows } = service();

    const listing = await windows.list('cursor-agent');

    expect(listing.windows).toEqual([]);
    expect(listing.unavailableReason).toContain('pick a model');
  });

  it('asks the CLI once per (kind, model) and serves the rest from cache', async () => {
    const { windows, cursor } = service();
    const spy = vi
      .spyOn(cursor, 'listModelContextWindows')
      .mockResolvedValue(LISTING);

    expect(
      (await windows.list('cursor-agent', 'claude-opus-5')).windows,
    ).toEqual(LISTING.windows);
    await windows.list('cursor-agent', 'claude-opus-5');
    expect(spy).toHaveBeenCalledTimes(1);

    // A DIFFERENT model is a different question — serving the first model's
    // sizes for it is the whole defect this per-model shape prevents.
    await windows.list('cursor-agent', 'gpt-5.5');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('asks ONCE when two screens ask at the same instant', async () => {
    // The listing spawns a CLI handshake; the composer and the graph inspector
    // both mount their chip the moment a model is picked.
    const { windows, cursor } = service();
    let resolve!: (listing: AgentContextWindowListing) => void;
    const spy = vi.spyOn(cursor, 'listModelContextWindows').mockReturnValue(
      new Promise<AgentContextWindowListing>((r) => {
        resolve = r;
      }),
    );

    const both = Promise.all([
      windows.list('cursor-agent', 'claude-opus-5'),
      windows.list('cursor-agent', 'claude-opus-5'),
    ]);
    resolve(LISTING);

    expect((await both).map((listing) => listing.windows)).toEqual([
      LISTING.windows,
      LISTING.windows,
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-asks once the answer has gone stale', async () => {
    let clock = 0;
    const { windows, cursor } = service({ ttlMs: 1000, now: () => clock });
    const spy = vi
      .spyOn(cursor, 'listModelContextWindows')
      .mockResolvedValue(LISTING);

    await windows.list('cursor-agent', 'claude-opus-5');
    clock = 999;
    await windows.list('cursor-agent', 'claude-opus-5');
    expect(spy).toHaveBeenCalledTimes(1);
    clock = 1001;
    await windows.list('cursor-agent', 'claude-opus-5');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good answer when the adapter throws', async () => {
    // A picker with no rows is a dead control, and an adapter that throws here
    // is already a contract violation — degrade rather than propagate.
    let clock = 0;
    const { windows, cursor } = service({ ttlMs: 1000, now: () => clock });
    const spy = vi
      .spyOn(cursor, 'listModelContextWindows')
      .mockResolvedValueOnce(LISTING)
      .mockRejectedValueOnce(new Error('the handshake died'));

    await windows.list('cursor-agent', 'claude-opus-5');
    // Past the TTL, so this really re-asks — and the ask fails.
    clock = 2000;
    const after = await windows.list('cursor-agent', 'claude-opus-5');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(after.windows).toEqual(LISTING.windows);
  });

  it('falls back to the adapter’s own sentence when there is no last answer', async () => {
    const { windows, cursor } = service();
    vi.spyOn(cursor, 'listModelContextWindows').mockRejectedValue(
      new Error('the handshake died'),
    );

    const listing = await windows.list('cursor-agent', 'claude-opus-5');

    expect(listing.windows).toEqual([]);
    expect(listing.unavailableReason).toContain('could not be asked');
    // Never `exact`: a listing nobody could take must not ground a refusal.
    expect(listing.exact).toBe(false);
  });

  it('projects to the wire without the exactness flag', async () => {
    // `exact` decides whether a listing may ground a REFUSAL, which is a daemon
    // question — nothing on the wire acts on it, and shipping it would invite
    // a client to.
    const { windows, cursor } = service();
    vi.spyOn(cursor, 'listModelContextWindows').mockResolvedValue(LISTING);

    expect(await windows.listWire('cursor-agent', 'claude-opus-5')).toEqual({
      windows: LISTING.windows,
      unavailableReason: null,
    });
  });
});
