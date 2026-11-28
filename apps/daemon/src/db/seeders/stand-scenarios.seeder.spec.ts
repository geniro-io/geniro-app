import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPendingQuestion } from '../../v1/agents/utils/pending-question';
import { commandCenterDb } from '../../v1/command-center/__tests__/command-center-db';
import { CommandCenterRosterEntry } from '../../v1/command-center/entity/command-center-roster.entity';
import { Item } from '../../v1/runs/entity/item.entity';
import { Run } from '../../v1/runs/entity/run.entity';
import {
  type StandScenarioName,
  standScenariosFrom,
  StandScenariosSeeder,
} from './stand-scenarios.seeder';

type Db = Awaited<ReturnType<typeof commandCenterDb>>;

const PREFIX = 'seed-fixture-stand-';
const THREAD = `${PREFIX}waiting-thread`;
const MANAGER = `${PREFIX}command-center`;
const LONG = `${PREFIX}long-transcript`;

function textOf(item: Item): string {
  return (JSON.parse(item.payload) as { text: string }).text;
}

describe('standScenariosFrom', () => {
  it('names no scenario while the variable is unset or blank', () => {
    expect(standScenariosFrom(undefined)).toEqual([]);
    expect(standScenariosFrom('')).toEqual([]);
    expect(standScenariosFrom(' , ')).toEqual([]);
  });

  it('reads a comma list in the known order, each name once', () => {
    expect(standScenariosFrom('long-transcript,waiting-question')).toEqual([
      'waiting-question',
      'long-transcript',
    ]);
    expect(standScenariosFrom('waiting-question, waiting-question')).toEqual([
      'waiting-question',
    ]);
  });

  it('reads all as every scenario', () => {
    expect(standScenariosFrom('all')).toEqual([
      'waiting-question',
      'long-transcript',
    ]);
  });

  it('sends working-threads to the stand boot, which needs a live daemon', () => {
    expect(() => standScenariosFrom('long-transcript,working-threads')).toThrow(
      /needs a live daemon[\s\S]*boot\.mjs/,
    );
  });

  it('refuses an unknown name and names the known ones', () => {
    expect(() => standScenariosFrom('waiting-questoin')).toThrow(
      /"waiting-questoin"[\s\S]*waiting-question, long-transcript/,
    );
  });
});

describe('StandScenariosSeeder', () => {
  let db: Db;

  beforeEach(async () => {
    db = await commandCenterDb();
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  async function seed(scenarios: readonly StandScenarioName[]): Promise<void> {
    const em = db.em.fork();
    await new StandScenariosSeeder().run(em, { scenarios });
    await em.flush();
  }

  async function standRunIds(): Promise<string[]> {
    const runs = await db.em.fork().find(Run, {
      id: { $like: `${PREFIX}%` },
    });
    return runs.map((run) => run.id).sort();
  }

  async function itemsOf(runId: string): Promise<Item[]> {
    return db.em.fork().find(Item, { runId }, { orderBy: { seq: 'asc' } });
  }

  it('writes no stand row when no scenario is named', async () => {
    await seed([]);

    expect(await standRunIds()).toEqual([]);
  });

  describe('waiting-question', () => {
    it('writes a chat waiting on an answer that a boot can take back', async () => {
      await seed(['waiting-question']);

      const thread = await db.em.fork().findOneOrFail(Run, { id: THREAD });
      expect(thread).toMatchObject({ teamId: null, archivedAt: null });
      const snapshot = readPendingQuestion(thread.pendingQuestion);
      expect(snapshot).toMatchObject({
        kind: 'question',
        title: null,
        questions: [
          expect.objectContaining({
            question: 'Which fix should the login redirect take?',
          }),
          expect.objectContaining({
            question: 'Should the fix cover sign-in on paired devices too?',
          }),
        ],
      });

      const request = (await itemsOf(THREAD)).find(
        (item) => item.kind === 'approval_request',
      );
      const payload = JSON.parse(request?.payload ?? 'null') as {
        id: string;
        toolName: string;
        questions: { question: string }[];
      };
      expect(snapshot).toMatchObject({ requestId: payload.id });
      expect(payload.toolName).toBe('ask_user_question');
      expect(payload.questions).toHaveLength(2);
    });

    it('puts the thread on the manager roster, so a boot relays its question', async () => {
      await seed(['waiting-question']);

      const row = await db.em.fork().findOne(CommandCenterRosterEntry, {
        threadRunId: THREAD,
      });
      expect(row).toMatchObject({ managerRunId: MANAGER, leftAt: null });
    });

    it('writes the command center manager beside it, with no relay row of its own', async () => {
      await seed(['waiting-question']);

      const manager = await db.em.fork().findOneOrFail(Run, { id: MANAGER });
      expect(manager.commandCenter).toBe(true);
      const kinds = (await itemsOf(MANAGER)).map((item) => item.kind);
      expect(kinds).not.toContain('approval_request');
    });
  });

  describe('long-transcript', () => {
    it('writes several hundred rows, long replies among them, ending on a short reply', async () => {
      await seed(['long-transcript']);

      const rows = await itemsOf(LONG);
      expect(rows.length).toBeGreaterThanOrEqual(400);
      expect(new Set(rows.map((row) => row.kind))).toEqual(
        new Set(['message', 'tool_call', 'tool_result', 'turn_complete']),
      );
      const messages = rows.filter((row) => row.kind === 'message');
      expect(
        Math.max(...messages.map((row) => textOf(row).length)),
      ).toBeGreaterThan(1000);
      const last = messages.at(-1);
      expect(last?.role).toBe('assistant');
      expect(textOf(last as Item).length).toBeLessThan(200);
    });
  });

  it('replaces its rows on a second seed rather than doubling them', async () => {
    const scenarios: StandScenarioName[] = [
      'waiting-question',
      'long-transcript',
    ];
    await seed(scenarios);
    const runIds = await standRunIds();
    const kinds = (await itemsOf(LONG)).map((row) => row.kind);

    await seed(scenarios);

    expect(await standRunIds()).toEqual(runIds);
    expect((await itemsOf(LONG)).map((row) => row.kind)).toEqual(kinds);
  });
});
