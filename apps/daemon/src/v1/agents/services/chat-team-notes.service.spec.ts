import type { EntityManager } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { ChatTeamNotesService } from './chat-team-notes.service';

interface Row {
  seq: number;
  payload: string;
  createdAt: Date;
}

/** JSON TEXT, as the `payload` column hands it back — see the artifacts spec. */
function row(seq: number, payload: unknown): Row {
  return {
    seq,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    createdAt: new Date(seq * 1000),
  };
}

function note(
  kind: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, text, nodeId: 'engineer', conversationId: null, ...extra };
}

/** Rows oldest first, exactly as `ItemDao.teamNoteRows` orders them. */
function build(rows: Row[], runExists = true): ChatTeamNotesService {
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: () => Promise.resolve(runExists ? { id: 'run' } : null),
  } as unknown as RunDao;
  const itemDao = {
    teamNoteRows: () => Promise.resolve(rows),
  } as unknown as ItemDao;
  return new ChatTeamNotesService(em, runDao, itemDao);
}

describe('ChatTeamNotesService', () => {
  it('lists every note newest first, a superseded one kept and marked by its replacement', async () => {
    const { notes } = await build([
      row(10, note('decision', 'use REST')),
      row(
        20,
        note('fact', 'CI is ubuntu-22.04', {
          callId: 'call-2',
          conversationId: 'call-2',
        }),
      ),
      row(30, note('decision', 'use gRPC', { supersedes: 10 })),
    ]).read('run');

    expect(notes.map((n) => [n.seq, n.supersedes, n.supersededBy])).toEqual([
      [30, 10, null],
      [20, null, null],
      [10, null, 30],
    ]);
    expect(notes[1]).toMatchObject({
      kind: 'fact',
      callId: 'call-2',
      conversationId: 'call-2',
      createdAt: new Date(20_000).toISOString(),
    });
  });

  it('leaves out a row whose payload is not a team note, keeping the rest', async () => {
    const { notes } = await build([
      row(10, note('fact', 'kept')),
      row(20, { kind: 'progress', text: 'step 3 done' }),
      row(30, 'not json'),
    ]).read('run');

    expect(notes.map((n) => n.text)).toEqual(['kept']);
  });

  it('refuses a run that does not exist', async () => {
    await expect(build([], false).read('gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
