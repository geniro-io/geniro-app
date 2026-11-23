import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import {
  type ItemWire,
  TEAM_NOTE_MAX_CHARS,
  TEAM_NOTES_PER_RUN,
  type TeamNotesQuery,
  type TeamNotesReadOutcome,
  type TeamNoteWriteOutcome,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { HostSinkUnavailable } from './host-sink.broker';
import {
  TeamNoteBroker,
  type TeamNoteSink,
  type TeamNoteWriter,
} from './team-note.broker';

interface Row {
  seq: number;
  payload: string;
  createdAt: Date;
}

/**
 * An in-memory `items` table for `team_note` rows, keyed by run. Payloads are
 * stored as JSON TEXT, as the column holds them, so the broker's own parse is
 * what reads them back.
 */
class FakeItems {
  readonly rows = new Map<string, Row[]>();
  private nextSeq = 1;

  /** The write a sink makes; `delayMs` widens the window two racing writes share. */
  async persist(
    runId: string,
    payload: unknown,
    delayMs = 0,
  ): Promise<ItemWire> {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const seq = this.nextSeq++;
    const list = this.rows.get(runId) ?? [];
    list.push({
      seq,
      payload: JSON.stringify(payload),
      createdAt: new Date(seq * 1000),
    });
    this.rows.set(runId, list);
    return { seq } as ItemWire;
  }

  seed(runId: string, count: number): void {
    for (let i = 0; i < count; i += 1) {
      void this.persist(runId, {
        kind: 'fact',
        text: `seeded ${i}`,
        nodeId: 'seed',
        conversationId: null,
      });
    }
  }

  dao(): ItemDao {
    return {
      teamNoteRows: (runId: string) =>
        Promise.resolve([...(this.rows.get(runId) ?? [])]),
      teamNoteCount: (runId: string) =>
        Promise.resolve((this.rows.get(runId) ?? []).length),
    } as unknown as ItemDao;
  }
}

const NAMES: Record<string, string> = {
  manager: 'Manager',
  engineer: 'Backend Engineer',
  reviewer: 'Code Reviewer',
};

/** Caller keys in this spec are `node` or `node/conversation`. */
function writerOf(caller: string): TeamNoteWriter {
  const [memberId, conversationId] = caller.split('/');
  return {
    memberId: memberId!,
    conversationId: conversationId ?? null,
    callId: conversationId === undefined ? null : `call-${conversationId}`,
  };
}

function sinkFor(items: FakeItems, runId: string, delayMs = 0): TeamNoteSink {
  return {
    persistItem: (_nodeId, _kind, _role, payload) =>
      items.persist(runId, payload, delayMs),
    writer: writerOf,
    agentName: (memberId) => NAMES[memberId] ?? memberId,
  };
}

function setUp(): { broker: TeamNoteBroker; items: FakeItems } {
  const items = new FakeItems();
  const em = { fork: () => em } as unknown as EntityManager;
  return { broker: new TeamNoteBroker(em, items.dao()), items };
}

/** Register every named member of `runId` on the broker. */
function register(
  broker: TeamNoteBroker,
  items: FakeItems,
  runId: string,
  nodes: string[],
  delayMs = 0,
): void {
  for (const memberId of nodes) {
    broker.register(runId, memberId, sinkFor(items, runId, delayMs));
  }
}

const QUERY: TeamNotesQuery = {
  kinds: [],
  author: null,
  since: null,
  before: null,
  limit: 50,
  includeSuperseded: false,
  unreadOnly: false,
};

const UNREAD: TeamNotesQuery = { ...QUERY, unreadOnly: true };

function written(outcome: TeamNoteWriteOutcome | HostSinkUnavailable): {
  seq: number;
  unread: number;
} {
  if (outcome.status !== 'written') {
    throw new Error(`expected a write, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function read(
  outcome: TeamNotesReadOutcome | HostSinkUnavailable,
): TeamNotesReadOutcome {
  if (outcome.status !== 'read') {
    throw new Error(`expected a read, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe('TeamNoteBroker', () => {
  it('a note written by one agent is read by another agent of the same run and not by another run', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    register(broker, items, 'run-b', ['manager']);

    const note = written(
      await broker.write('run-a', 'engineer', 'engineer/c1', {
        kind: 'contract',
        text: 'POST /orders returns { id, status }',
      }),
    );

    const seen = read(await broker.read('run-a', 'manager', 'manager', QUERY));
    expect(seen.notes).toHaveLength(1);
    expect(seen.notes[0]).toMatchObject({
      seq: note.seq,
      kind: 'contract',
      text: 'POST /orders returns { id, status }',
      memberId: 'engineer',
      conversationId: 'c1',
      callId: 'call-c1',
      author: 'Backend Engineer',
    });

    const other = read(await broker.read('run-b', 'manager', 'manager', QUERY));
    expect(other.notes).toEqual([]);
  });

  it('is not offered, and answers unavailable, for a member with no sink', async () => {
    const { broker } = setUp();

    expect(broker.canUse('run-a', 'manager')).toBe(false);
    const outcome = await broker.write('run-a', 'manager', 'manager', {
      kind: 'fact',
      text: 'x',
    });
    expect(outcome.status).toBe('unavailable');
  });

  it('refuses text over 16,000 characters and the 5,001st note of a run, also when two writes race at 4,999', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer'], 5);

    const long = await broker.write('run-a', 'manager', 'manager', {
      kind: 'fact',
      text: 'x'.repeat(TEAM_NOTE_MAX_CHARS + 1),
    });
    expect(long).toMatchObject({ status: 'refused' });
    expect(items.rows.get('run-a')).toBeUndefined();

    items.seed('run-a', TEAM_NOTES_PER_RUN - 1);

    const [first, second] = await Promise.all([
      broker.write('run-a', 'manager', 'manager', {
        kind: 'fact',
        text: 'one',
      }),
      broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'two',
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual([
      'refused',
      'written',
    ]);
    expect(items.rows.get('run-a')).toHaveLength(TEAM_NOTES_PER_RUN);
  });

  it('a superseding note hides the older one unless include_superseded', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);

    const old = written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'decision',
        text: 'use REST',
      }),
    );
    const newer = written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'decision',
        text: 'use gRPC — REST adds a gateway hop',
        supersedes: old.seq,
      }),
    );

    const plain = read(await broker.read('run-a', 'manager', 'manager', QUERY));
    expect(plain.notes.map((note) => note.seq)).toEqual([newer.seq]);
    expect(plain.notes[0]?.supersedes).toBe(old.seq);

    const all = read(
      await broker.read('run-a', 'manager', 'manager', {
        ...QUERY,
        includeSuperseded: true,
      }),
    );
    expect(all.notes.map((note) => [note.seq, note.supersededBy])).toEqual([
      [newer.seq, null],
      [old.seq, newer.seq],
    ]);
  });

  it('never counts a superseded note as unread, so a plain read clears the figure', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    const old = written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'decision',
        text: 'use REST',
      }),
    );
    await broker.write('run-a', 'engineer', 'engineer', {
      kind: 'decision',
      text: 'use gRPC',
      supersedes: old.seq,
    });
    const manager = { memberId: 'manager', conversationId: null };
    // Only the replacement is news.
    expect(broker.unreadCount('run-a', manager)).toBe(1);

    const plain = read(await broker.read('run-a', 'manager', 'manager', QUERY));
    expect(plain.unread).toBe(0);
    expect(broker.unreadCount('run-a', manager)).toBe(0);

    // And after a restart, rebuilt from the rows, it still does not count.
    broker.forgetRun('run-a');
    await broker.prime('run-a');
    expect(broker.unreadCount('run-a', manager)).toBe(1);
  });

  it('refuses supersedes naming another run or a later seq', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager']);
    register(broker, items, 'run-b', ['manager']);

    const elsewhere = written(
      await broker.write('run-b', 'manager', 'manager', {
        kind: 'fact',
        text: 'run b fact',
      }),
    );
    const otherRun = await broker.write('run-a', 'manager', 'manager', {
      kind: 'fact',
      text: 'tries to replace run b',
      supersedes: elsewhere.seq,
    });
    expect(otherRun).toMatchObject({ status: 'refused' });

    const later = await broker.write('run-a', 'manager', 'manager', {
      kind: 'fact',
      text: 'tries to replace the future',
      supersedes: elsewhere.seq + 100,
    });
    expect(later).toMatchObject({ status: 'refused' });
    expect(items.rows.get('run-a')).toBeUndefined();
  });

  it('pages past the 60,000-character budget with a before cursor and an older-count', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    const seqs: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      seqs.push(
        written(
          await broker.write('run-a', 'engineer', 'engineer', {
            kind: 'fact',
            text: `${i}`.repeat(15_000),
          }),
        ).seq,
      );
    }

    const first = read(await broker.read('run-a', 'manager', 'manager', QUERY));
    // Three notes of 15,000 characters fit 60,000 with their overhead; a fourth does not.
    expect(first.notes.map((note) => note.seq)).toEqual(
      seqs.slice(-3).reverse(),
    );
    expect(first.olderRemaining).toBe(7);
    expect(first.nextBefore).toBe(seqs[7]);

    const next = read(
      await broker.read('run-a', 'manager', 'manager', {
        ...QUERY,
        before: first.nextBefore,
      }),
    );
    expect(next.notes.map((note) => note.seq)).toEqual(
      seqs.slice(4, 7).reverse(),
    );
    expect(next.olderRemaining).toBe(4);
  });

  it('counts unread per conversation and a missing cursor counts every note the conversation did not write', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer', 'reviewer']);

    written(
      await broker.write('run-a', 'engineer', 'engineer/c1', {
        kind: 'pitfall',
        text: 'the seed script needs GENIRO_SEED_FORCE',
      }),
    );
    const own = written(
      await broker.write('run-a', 'reviewer', 'reviewer', {
        kind: 'fact',
        text: 'CI runs on ubuntu-22.04',
      }),
    );

    // The writer is not told about its own note, only the engineer's.
    expect(own.unread).toBe(1);
    // Never read anything: every note it did not write.
    expect(
      broker.unreadCount('run-a', {
        memberId: 'manager',
        conversationId: null,
      }),
    ).toBe(2);
    // The same member in another conversation is another reader.
    expect(
      broker.unreadCount('run-a', {
        memberId: 'engineer',
        conversationId: 'c1',
      }),
    ).toBe(1);
    expect(
      broker.unreadCount('run-a', {
        memberId: 'engineer',
        conversationId: 'c2',
      }),
    ).toBe(2);

    const seen = read(await broker.read('run-a', 'manager', 'manager', QUERY));
    expect(seen.unread).toBe(0);
    expect(
      broker.unreadCount('run-a', {
        memberId: 'manager',
        conversationId: null,
      }),
    ).toBe(0);

    written(
      await broker.write('run-a', 'engineer', 'engineer/c1', {
        kind: 'fact',
        text: 'one more',
      }),
    );
    expect(
      broker.unreadCount('run-a', {
        memberId: 'manager',
        conversationId: null,
      }),
    ).toBe(1);
  });

  it('leaves the notes a narrowed read did not show unread', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    await broker.write('run-a', 'engineer', 'engineer', {
      kind: 'decision',
      text: 'd',
    });
    await broker.write('run-a', 'engineer', 'engineer', {
      kind: 'contract',
      text: 'c',
    });
    const manager = { memberId: 'manager', conversationId: null };

    // Contracts only, as the description asks before an interface changes:
    // the older decision was not shown, so it is still unread.
    const contracts = read(
      await broker.read('run-a', 'manager', 'manager', {
        ...QUERY,
        kinds: ['contract'],
      }),
    );
    expect(contracts.notes.map((note) => note.text)).toEqual(['c']);
    expect(contracts.unread).toBe(1);
    expect(broker.unreadCount('run-a', manager)).toBe(1);

    read(await broker.read('run-a', 'manager', 'manager', QUERY));
    expect(broker.unreadCount('run-a', manager)).toBe(0);
  });

  it('rebuilds a forgotten run from its rows: the notes stay readable and all count as unread again', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'kept in the transcript',
      }),
    );
    read(await broker.read('run-a', 'manager', 'manager', QUERY));

    // A daemon restart is a broker with no memory of the run.
    broker.forgetRun('run-a');
    expect(
      broker.unreadCount('run-a', {
        memberId: 'manager',
        conversationId: null,
      }),
    ).toBe(0);
    await broker.prime('run-a');
    expect(
      broker.unreadCount('run-a', {
        memberId: 'manager',
        conversationId: null,
      }),
    ).toBe(1);
  });

  it('a no-filter read shows only the notes the conversation was not shown and did not write, and then none', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer', 'reviewer']);
    written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'first',
      }),
    );
    written(
      await broker.write('run-a', 'reviewer', 'reviewer', {
        kind: 'fact',
        text: 'second',
      }),
    );

    const first = read(
      await broker.read('run-a', 'manager', 'manager', UNREAD),
    );
    expect(first.notes.map((note) => note.text)).toEqual(['second', 'first']);
    expect(first.seenLeftOut).toBe(0);
    expect(first.unreadOnly).toBe(true);

    const again = read(
      await broker.read('run-a', 'manager', 'manager', UNREAD),
    );
    expect(again.notes).toEqual([]);
    expect(again.seenLeftOut).toBe(2);

    written(
      await broker.write('run-a', 'reviewer', 'reviewer', {
        kind: 'fact',
        text: 'third',
      }),
    );
    const later = read(
      await broker.read('run-a', 'manager', 'manager', UNREAD),
    );
    expect(later.notes.map((note) => note.text)).toEqual(['third']);
    expect(later.seenLeftOut).toBe(2);
  });

  it('since 0 reads every note, and a kind or author read still returns the notes already shown', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'shown',
      }),
    );
    read(await broker.read('run-a', 'manager', 'manager', UNREAD));

    const all = read(
      await broker.read('run-a', 'manager', 'manager', { ...QUERY, since: 0 }),
    );
    expect(all.notes.map((note) => note.text)).toEqual(['shown']);
    expect(all.unreadOnly).toBe(false);
    expect(all.seenLeftOut).toBe(0);

    const byAuthor = read(
      await broker.read('run-a', 'manager', 'manager', {
        ...QUERY,
        author: 'engineer',
      }),
    );
    expect(byAuthor.notes.map((note) => note.text)).toEqual(['shown']);
  });

  it('keeps a conversation’s own notes out of the no-filter read, and since 0 still returns them', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['engineer']);
    written(
      await broker.write('run-a', 'engineer', 'engineer/c1', {
        kind: 'fact',
        text: 'mine',
      }),
    );

    const unread = read(
      await broker.read('run-a', 'engineer', 'engineer/c1', UNREAD),
    );
    expect(unread.notes).toEqual([]);
    expect(unread.seenLeftOut).toBe(1);

    const all = read(
      await broker.read('run-a', 'engineer', 'engineer/c1', {
        ...QUERY,
        since: 0,
      }),
    );
    expect(all.notes.map((note) => note.text)).toEqual(['mine']);
  });

  it('a fresh conversation of a member gets every note it did not write on its first no-filter read', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'one',
      }),
    );
    written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'two',
      }),
    );
    read(await broker.read('run-a', 'manager', 'manager/c1', UNREAD));

    const other = read(
      await broker.read('run-a', 'manager', 'manager/c2', UNREAD),
    );
    expect(other.notes.map((note) => note.text)).toEqual(['two', 'one']);
  });

  it('forgetShown makes the next no-filter read show every note again', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'kept',
      }),
    );
    const manager = { memberId: 'manager', conversationId: null };
    read(await broker.read('run-a', 'manager', 'manager', UNREAD));
    expect(
      read(await broker.read('run-a', 'manager', 'manager', UNREAD)).notes,
    ).toEqual([]);

    broker.forgetShown('run-a', manager);
    expect(broker.unreadCount('run-a', manager)).toBe(1);
    const again = read(
      await broker.read('run-a', 'manager', 'manager', UNREAD),
    );
    expect(again.notes.map((note) => note.text)).toEqual(['kept']);
  });

  it('sessionOpened forgets what a conversation was shown only when its session id changes', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'kept',
      }),
    );
    const manager = { memberId: 'manager', conversationId: null };

    broker.sessionOpened('run-a', manager, 's1');
    read(await broker.read('run-a', 'manager', 'manager', UNREAD));
    broker.sessionOpened('run-a', manager, 's1');
    expect(
      read(await broker.read('run-a', 'manager', 'manager', UNREAD)).notes,
    ).toEqual([]);

    broker.sessionOpened('run-a', manager, 's2');
    expect(
      read(await broker.read('run-a', 'manager', 'manager', UNREAD)).notes.map(
        (note) => note.text,
      ),
    ).toEqual(['kept']);
  });

  it('a restart forgets what was shown and the session ids, so the first session after it forgets nothing more', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer']);
    written(
      await broker.write('run-a', 'engineer', 'engineer', {
        kind: 'fact',
        text: 'kept',
      }),
    );
    const manager = { memberId: 'manager', conversationId: null };
    broker.sessionOpened('run-a', manager, 's1');
    read(await broker.read('run-a', 'manager', 'manager', UNREAD));

    broker.forgetRun('run-a');
    await broker.prime('run-a');
    const afterRestart = read(
      await broker.read('run-a', 'manager', 'manager', UNREAD),
    );
    expect(afterRestart.notes.map((note) => note.text)).toEqual(['kept']);

    broker.sessionOpened('run-a', manager, 's2');
    expect(
      read(await broker.read('run-a', 'manager', 'manager', UNREAD)).notes,
    ).toEqual([]);
  });

  it('filters by kind and by author name or member id', async () => {
    const { broker, items } = setUp();
    register(broker, items, 'run-a', ['manager', 'engineer', 'reviewer']);
    await broker.write('run-a', 'engineer', 'engineer', {
      kind: 'contract',
      text: 'a',
    });
    await broker.write('run-a', 'reviewer', 'reviewer', {
      kind: 'pitfall',
      text: 'b',
    });
    await broker.write('run-a', 'engineer', 'engineer', {
      kind: 'pitfall',
      text: 'c',
    });

    const pitfalls = read(
      await broker.read('run-a', 'manager', 'manager', {
        ...QUERY,
        kinds: ['pitfall'],
      }),
    );
    expect(pitfalls.notes.map((note) => note.text)).toEqual(['c', 'b']);

    const byName = read(
      await broker.read('run-a', 'manager', 'manager', {
        ...QUERY,
        author: ' backend ENGINEER ',
      }),
    );
    expect(byName.notes.map((note) => note.text)).toEqual(['c', 'a']);

    const byId = read(
      await broker.read('run-a', 'manager', 'manager', {
        ...QUERY,
        author: 'reviewer',
      }),
    );
    expect(byId.notes.map((note) => note.text)).toEqual(['b']);
  });
});
