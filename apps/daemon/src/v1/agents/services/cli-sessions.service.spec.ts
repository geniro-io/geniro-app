import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import type {
  AdapterConfig,
  AgentSessionHistory,
  AgentSessionListing,
  AgentSessionsInput,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { CliSessionsService } from './cli-sessions.service';
import type { ProcessRegistry } from './process-registry';

/** The slice of an adapter this service actually reaches for. */
interface FakeAdapter {
  listSessions: (input: AgentSessionsInput) => Promise<AgentSessionListing>;
  prepareSessionImport: () => Promise<void>;
  readSessionHistory: () => Promise<AgentSessionHistory | null>;
  getConfig: () => AdapterConfig;
}

function setup(over: Partial<FakeAdapter> = {}): {
  service: CliSessionsService;
  adapter: FakeAdapter;
  listed: AgentSessionsInput[];
} {
  const listed: AgentSessionsInput[] = [];
  const adapter: FakeAdapter = {
    listSessions: (input) => {
      listed.push(input);
      return Promise.resolve({ sessions: [], unavailableReason: null });
    },
    prepareSessionImport: () => Promise.resolve(),
    readSessionHistory: () =>
      Promise.resolve({ events: [], droppedBefore: 0 } as AgentSessionHistory),
    getConfig: () =>
      ({
        kind: AgentKind.Claude,
        sessions: {
          listingUnavailableReason: null,
          listingPartialReason: null,
          historyUnavailableReason: null,
        },
      }) as AdapterConfig,
    ...over,
  };
  const service = new CliSessionsService(
    {
      for: () => adapter as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry,
    { register: () => undefined } as unknown as ProcessRegistry,
  );
  return { service, adapter, listed };
}

describe('CliSessionsService.list', () => {
  it("carries the adapter's own partial reason, which the listing cannot state", () => {
    const { service } = setup({
      getConfig: () =>
        ({
          kind: AgentKind.CursorAgent,
          sessions: {
            listingUnavailableReason: null,
            listingPartialReason: 'a second store is not reached',
            historyUnavailableReason: null,
          },
        }) as AdapterConfig,
    });
    return expect(
      service.list(AgentKind.CursorAgent, null, null),
    ).resolves.toMatchObject({
      partialReason: 'a second store is not reached',
    });
  });

  it('says so when the cap cut the list, rather than passing it off as all', async () => {
    // The picker asks ONE unfiltered question and searches what came back, so a
    // session past the cut cannot be found at all — a short list that looks
    // complete is the whole failure mode.
    const { service } = setup({
      listSessions: (input) =>
        Promise.resolve({
          sessions: Array.from({ length: input.limit }, (_unused, index) => ({
            id: `s${index}`,
            cwd: '/w',
            title: null,
            updatedAt: null,
          })),
          unavailableReason: null,
        }),
    });
    const listing = await service.list(AgentKind.Claude, null, null);
    expect(listing.partialReason).toMatch(/most recent sessions/);
  });

  it('claims nothing about a list that fitted', async () => {
    const { service } = setup();
    await expect(
      service.list(AgentKind.Claude, null, null),
    ).resolves.toMatchObject({ partialReason: null });
  });

  it('joins two callers onto ONE listing', async () => {
    // cursor's listing SPAWNS a process; a picker re-asking as its folder
    // filter changes must not launch one per keystroke.
    let calls = 0;
    const { service } = setup({
      listSessions: () => {
        calls += 1;
        return new Promise((resolve) =>
          setTimeout(
            () => resolve({ sessions: [], unavailableReason: null }),
            5,
          ),
        );
      },
    });
    await Promise.all([
      service.list(AgentKind.Claude, '/w', null),
      service.list(AgentKind.Claude, '/w', null),
    ]);
    expect(calls).toBe(1);
    // A DIFFERENT question is its own ask, not a served cache hit.
    await service.list(AgentKind.Claude, '/other', null);
    expect(calls).toBe(2);
  });
});

describe('CliSessionsService.prepare', () => {
  it("turns an adapter's refusal into a 400 carrying its own sentence", async () => {
    const { service } = setup({
      prepareSessionImport: () =>
        Promise.reject(new Error('that session is no longer in this profile')),
    });
    await expect(
      service.prepare(AgentKind.CursorAgent, 's1', '/w', null),
    ).rejects.toThrow('that session is no longer in this profile');
  });
});

describe('CliSessionsService.importHistory', () => {
  it('says NOTHING when the whole conversation came across', async () => {
    // The transcript is its own evidence; a row announcing "this went fine" is
    // a line the user reads past forever to reach what they came for.
    const { service } = setup({
      readSessionHistory: () =>
        Promise.resolve({
          events: [{ type: 'text', text: 'hi' }],
          droppedBefore: 0,
        }),
    });
    const result = await service.importHistory(
      AgentKind.Claude,
      's1',
      '/w',
      null,
    );
    expect(result.notice).toBeNull();
    expect(result.events).toHaveLength(1);
  });

  it('says so when it left earlier messages out', async () => {
    const { service } = setup({
      readSessionHistory: () =>
        Promise.resolve({ events: [], droppedBefore: 12 }),
    });
    const { notice } = await service.importHistory(
      AgentKind.Claude,
      's1',
      '/w',
      null,
    );
    expect(notice).toContain('most recent part');
  });

  it("relays the CLI's own reason when it keeps no readable record", async () => {
    const { service } = setup({
      readSessionHistory: () => Promise.resolve(null),
      getConfig: () =>
        ({
          kind: AgentKind.CursorAgent,
          sessions: {
            listingUnavailableReason: null,
            listingPartialReason: null,
            historyUnavailableReason: 'this CLI keeps no readable transcript',
          },
        }) as AdapterConfig,
    });
    const { notice, events } = await service.importHistory(
      AgentKind.CursorAgent,
      's1',
      '/w',
      null,
    );
    expect(notice).toContain('this CLI keeps no readable transcript');
    expect(events).toEqual([]);
  });

  it('does not let a failed TRANSCRIPT read cost the import', async () => {
    // The contract says implementations do not throw; this is the belt on top —
    // the session itself resumes either way.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service } = setup({
      readSessionHistory: () => Promise.reject(new Error('disk gone')),
    });
    const { notice, events } = await service.importHistory(
      AgentKind.Claude,
      's1',
      '/w',
      null,
    );
    expect(events).toEqual([]);
    expect(notice).toContain('not shown here');
    warn.mockRestore();
  });
});
