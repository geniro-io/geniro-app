import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import { Run } from '../../runs/entity/run.entity';
import { persistItemAndEmit, runToWire } from './persist-item';

/**
 * The PRODUCER hop of the run row's wire projection.
 *
 * `archivedAt` crosses the daemon→renderer seam, where the rule is a test at
 * every hop; the reader's own is `Chats.spec.tsx`'s "an archived thread's
 * composer is disabled", which drives the field off the row. Two tests rather
 * than one so reverting either is not masked by the other passing.
 */
describe('runToWire', () => {
  it("projects an archived run's archivedAt as an ISO string", () => {
    const run = new Run();
    run.archivedAt = new Date('2026-08-30T12:34:56.000Z');

    expect(runToWire(run).archivedAt).toBe('2026-08-30T12:34:56.000Z');
  });

  it('projects a run that was never archived as null', () => {
    expect(runToWire(new Run()).archivedAt).toBeNull();
  });
});

/**
 * The one insert seam every shipping `Item` write goes through.
 *
 * The backfill that fills this column for existing rows is marker-retired, so
 * it never comes back: a row created after it ran is searchable only because
 * the write itself flattens. That makes this the pin the whole feature rests
 * on — drop the field here and search goes on working against old history
 * while silently missing everything said from then on.
 */
describe('persistItemAndEmit', () => {
  function fakeDeps(): {
    deps: Parameters<typeof persistItemAndEmit>[0];
    created: Record<string, unknown>[];
  } {
    const created: Record<string, unknown>[] = [];
    const deps = {
      itemDao: {
        create: (row: Record<string, unknown>) => {
          created.push(row);
          return Promise.resolve({ id: 'item-1', createdAt: new Date(0) });
        },
      },
      bus: { publish: () => undefined },
    } as unknown as Parameters<typeof persistItemAndEmit>[0];
    return { deps, created };
  }

  const em = { clear: () => undefined } as unknown as EntityManager;

  it("flattens a tool call's name and command into searchText", async () => {
    const { deps, created } = fakeDeps();

    await persistItemAndEmit(deps, em, {
      runId: 'run-1',
      nodeId: null,
      seq: 1,
      kind: 'tool_call',
      role: 'assistant',
      payload: { name: 'Bash', input: { command: 'pnpm full-check' } },
    });

    // Lowercased: the column is an INDEX value, so SQLite's `LIKE` — which
    // folds case for ASCII only — can match a Cyrillic term too.
    expect(created[0]?.searchText).toBe('bash pnpm full-check');
  });

  it('writes an empty string — not null — for a payload with nothing to match', async () => {
    // Null is the backfill's "never flattened" predicate. A row this seam DID
    // write must never read as null, or the sweep would keep coming back for
    // rows that are already done.
    const { deps, created } = fakeDeps();

    await persistItemAndEmit(deps, em, {
      runId: 'run-1',
      nodeId: null,
      seq: 2,
      kind: 'turn_complete',
      role: null,
      payload: { usage: { inputTokens: 12 } },
    });

    expect(created[0]?.searchText).toBe('');
  });
});
